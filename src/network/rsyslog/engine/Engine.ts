import type { SyslogTime } from '@/network/syslog/codec/SyslogTime';
import { ScriptState, type EvaluationEnvironment } from '../config/Expressions';
import { jsonDeepCopy } from '../Json';
import { RsyslogMessage } from '../Message';
import { LOG_PRI_INVALID } from '@/network/syslog/codec/SyslogPriority';
import { parseReceivedMessage, type MessageParserModule } from '../MessageParser';
import { messageAsJson, type RenderContext } from '../Properties';
import { jsonText } from '../Json';
import { ActionRuntime, type ActionServices } from './ActionRuntime';
import type { ActionDefinition, InputRecord, LoadedConfig, RulesetDefinition } from './Config';
import { executeStatements, type ExecResult, type ExecutionServices, type Sleep } from './Execution';
import type { FileHandle, RsyslogHost } from './Host';
import { formatLogEntry, RS_RET } from './Log';
import { zlibDecompress, ZlibError } from '../Zlib';
import { RateLimiter } from './RateLimiter';
import type { InputInstance, InputSubmission, InputSubmitter, RuntimeLog } from './Modules';
import { WorkerQueue, type ProcessOutcome } from './Queue';

const LOG_SYSLOG = 5;
const INTERNAL_INPUT = 'rsyslogd';

export type StartOutcome = { readonly ok: true } | { readonly ok: false; readonly code: number };

export interface EngineEvents {
  onInternalMessage?(severity: number, code: number, text: string): void;
}

export class RsyslogEngine implements InputSubmitter {
  readonly mainQueue: WorkerQueue<RsyslogMessage>;
  private readonly actions = new Map<number, ActionRuntime>();
  private readonly actionQueues = new Map<number, WorkerQueue<RsyslogMessage>>();
  private readonly rulesetQueues = new Map<string, WorkerQueue<RsyslogMessage>>();
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly globalVariables: { [key: string]: import('../Message').JsonValue } = {};
  private readonly defaultLimiter: RateLimiter;
  private readonly internalLimiter: RateLimiter;
  private readonly script = new ScriptState();
  private started = false;
  private oversizeLog: FileHandle | null = null;
  private internalBacklog: RsyslogMessage[] | null = null;
  private stopCallbacks: Array<() => void> = [];
  private readonly runtimeLog: RuntimeLog;

  constructor(readonly config: LoadedConfig, private readonly host: RsyslogHost, private readonly events: EngineEvents = {}) {
    const runtimeLog: RuntimeLog = {
      error: (text, code, errno) => runtimeLog.log(3, code ?? RS_RET.ERR, text, errno),
      warning: (text, code) => runtimeLog.log(4, code ?? RS_RET.NO_ERRCODE, text),
      info: (text, code) => runtimeLog.log(6, code ?? RS_RET.NO_ERRCODE, text),
      log: (severity, code, text, errno) => this.internal(severity, code, formatLogEntry(text, code, errno ?? null)),
      internal: (severity, code, text, mark, facility) => this.internal(severity, code, text, mark, facility),
    };
    this.runtimeLog = runtimeLog;
    config.bindRuntime(runtimeLog);
    this.defaultLimiter = this.newLimiter('rsyslogd', 0, 10000, 0);
    this.internalLimiter = this.newLimiter(
      'rsyslogd[internal_messages]', config.settings.internalMessages.rateInterval, config.settings.internalMessages.rateBurst, 0,
    );
    this.mainQueue = this.newQueue('main Q', config.settings.mainQueue, (message) => this.processThroughRuleset(message));
    config.actions.forEach((definition) => {
      this.actions.set(definition.id, new ActionRuntime(definition, this.actionServices(), definition.id - 1));
    });
    for (const [name, ruleset] of config.rulesets) {
      if (ruleset.queue !== null && ruleset.queue.type !== 'Direct') {
        this.rulesetQueues.set(name, this.newQueue(`ruleset ${name} queue`, ruleset.queue, (message) => this.processThroughRuleset(message)));
      }
    }
    for (const definition of config.actions) {
      const queue = definition.options.queue;
      if (queue.type === 'Direct') continue;
      const runtime = this.actions.get(definition.id) as ActionRuntime;
      this.actionQueues.set(definition.id, this.newQueue(`${runtime.name} queue`, queue, (message) => this.processAction(runtime, message)));
    }
  }

  private newQueue(name: string, settings: import('./Settings').QueueSettings, process: (message: RsyslogMessage) => Generator<Sleep, ProcessOutcome>): WorkerQueue<RsyslogMessage> {
    return new WorkerQueue<RsyslogMessage>(
      name,
      settings,
      {
        schedule: (callback, delay) => this.host.schedule(callback, delay),
        localHour: () => this.renderContext().now().hour,
        nowMs: () => this.host.clock.wallMs(),
        report: (text) => this.internal(4, -1, text),
      },
      process,
    );
  }

  private newLimiter(name: string, interval: number, burst: number, threshold: number): RateLimiter {
    return new RateLimiter({
      name, interval, burst, severityThreshold: threshold,
      reduceRepeated: this.config.settings.repeatedMessageReduction,
      internal: (severity, code, text) => this.internal(severity, code, text),
      nowSeconds: () => Math.floor(this.host.clock.wallMs() / 1000),
    });
  }

  limiterFor(name: string, interval: number, burst: number, severity = 0): RateLimiter {
    const key = `${name}:${interval}:${burst}:${severity}`;
    let limiter = this.limiters.get(key);
    if (limiter === undefined) {
      limiter = this.newLimiter(name, interval, burst, severity);
      this.limiters.set(key, limiter);
    }
    return limiter;
  }

  private timeAt(epochMs: number): SyslogTime {
    return this.config.localClock.at(epochMs);
  }

  renderContext(): RenderContext {
    const settings = this.config.settings;
    return {
      now: () => this.config.localClock.now(),
      nowUtc: () => this.config.localClock.utcNow(),
      localHostName: () => this.localHostName(),
      uptimeSeconds: () => Math.floor((this.host.clock.wallMs() - this.host.bootTimeMs()) / 1000),
      globalVariables: this.globalVariables,
      caseSensitiveVariables: settings.variablesCaseSensitive,
    };
  }

  localHostName(): string {
    const settings = this.config.settings;
    if (settings.localHostNameOverride !== null) return settings.localHostNameOverride;
    const full = this.host.hostname();
    const domain = this.host.domainName();
    if (settings.preserveFqdn) return full.includes('.') || domain === null ? full : `${full}.${domain}`;
    const dot = full.indexOf('.');
    return dot < 0 ? full : full.slice(0, dot);
  }

  private environment(): EvaluationEnvironment {
    const settings = this.config.settings;
    return {
      render: this.renderContext(),
      state: this.script,
      maxLine: settings.parser.maxLine,
      caseSensitiveVariables: settings.variablesCaseSensitive,
      template: (name) => this.config.templates.get(name),
      environment: (name) => settings.environment[name] ?? this.host.environment(name),
      random: () => Math.floor(this.host.random() * 0x7fffffff),
      warn: (text) => this.internal(4, -1, text),
    };
  }

  private actionServices(): ActionServices {
    return {
      host: this.host,
      renderContext: () => this.renderContext(),
      log: (severity, code, text) => this.runtimeLog.log(severity, code, text),
      markIntervalSeconds: () => this.config.settings.markIntervalSeconds,
    };
  }

  private executionServices(): ExecutionServices {
    return {
      env: this.environment(),
      runAction: (definition, message) => this.runAction(definition, message),
      callRuleset: (name, message, depth) => this.callRuleset(name, message, depth),
      log: (text) => this.internal(4, -1, text),
    };
  }

  private *runAction(definition: ActionDefinition, message: RsyslogMessage): Generator<Sleep, void> {
    const runtime = this.actions.get(definition.id);
    if (runtime === undefined) return;
    const queue = this.actionQueues.get(definition.id);
    if (queue === undefined) {
      yield* runtime.submit(message, this.script);
      return;
    }
    queue.enqueue(definition.options.copyMessage ? this.copyMessage(message) : message);
  }

  private *processAction(runtime: ActionRuntime, message: RsyslogMessage): Generator<Sleep, ProcessOutcome> {
    const result = yield* runtime.submit(message, new ScriptState());
    if (result !== 'deferred') return 'done';
    return { retryAfterMs: runtime.resumeDelayMs() || runtime.definition.options.resumeInterval * 1000 };
  }

  private *callRuleset(name: string, message: RsyslogMessage, depth: number): Generator<Sleep, ExecResult> {
    const ruleset = this.config.rulesets.get(name);
    if (ruleset === undefined) return 'continue';
    const queue = this.rulesetQueues.get(name);
    if (queue !== undefined) {
      const copy = this.copyMessage(message);
      copy.rulesetName = name;
      queue.enqueue(copy);
      return 'continue';
    }
    return yield* executeStatements(ruleset.statements, message, this.executionServices(), depth);
  }

  copyMessage(message: RsyslogMessage): RsyslogMessage {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(message) as object) as RsyslogMessage, message);
    copy.cee = JSON.parse(JSON.stringify(message.cee)) as typeof message.cee;
    copy.localVariables = JSON.parse(JSON.stringify(message.localVariables)) as typeof message.localVariables;
    return copy;
  }

  private rulesetOf(message: RsyslogMessage): RulesetDefinition {
    return this.config.rulesets.get(message.rulesetName ?? this.config.settings.defaultRuleset)
      ?? (this.config.rulesets.get('RSYSLOG_DefaultRuleset') as RulesetDefinition);
  }

  private *processThroughRuleset(message: RsyslogMessage): Generator<Sleep, ProcessOutcome> {
    const ruleset = this.rulesetOf(message);
    this.script.previousSuspended = false;
    yield* executeStatements(ruleset.statements, message, this.executionServices());
    return 'done';
  }

  private parsersFor(rulesetName: string | null): MessageParserModule[] {
    const ruleset = this.config.rulesets.get(rulesetName ?? this.config.settings.defaultRuleset);
    const names = ruleset?.parserNames ?? null;
    if (names === null) return [this.config.parsers.get('rsyslog.rfc5424'), this.config.parsers.get('rsyslog.rfc3164')].filter((parser): parser is MessageParserModule => parser !== undefined);
    return names.map((name) => this.config.parsers.get(name)).filter((parser): parser is MessageParserModule => parser !== undefined);
  }

  private decodeReceived(bytes: Uint8Array, noLegacyZ: boolean): string | null {
    const settings = this.config.settings;
    if (bytes.length > 0 && bytes[0] === 0x7a && settings.supportCompressionExtension && !noLegacyZ) {
      let inflated: Uint8Array;
      try {
        inflated = zlibDecompress(bytes.subarray(1), settings.parser.maxLine);
      } catch (error) {
        const code = error instanceof ZlibError && error.message.includes('exceeds limit') ? -5 : -3;
        this.internal(
          3, -1,
          formatLogEntry(`Uncompression of a message failed with return code ${code} - enable debug logging if you need further information. Message ignored.`, -1),
        );
        return null;
      }
      if (inflated.length === 0) {
        this.internal(3, -1, formatLogEntry('legacy zlib decompression produced an empty message; discarding', -1));
        return null;
      }
      return new TextDecoder().decode(inflated);
    }
    return new TextDecoder().decode(bytes);
  }

  submit(info: InputSubmission): void {
    if (!this.started) return;
    const now = info.receivedAtMs ?? this.host.clock.wallMs();
    let raw = info.raw;
    if (info.bytes !== undefined) {
      const decoded = this.decodeReceived(info.bytes, info.noLegacyZDecompress === true);
      if (decoded === null) return;
      raw = decoded;
    }
    let { fromHost, fromHostIp, fromHostPort } = info;
    if (info.localOrigin === true && fromHost === null) fromHost = this.localHostName();
    if (info.sender !== undefined) {
      const resolved = this.config.senderResolver.resolve(info.sender.ip);
      fromHost = info.preserveCase === true ? resolved.fqdn : resolved.fqdnLowerCase;
      fromHostIp = resolved.ip;
      fromHostPort = String(info.sender.port);
      if (info.pendingAcl !== undefined && info.pendingAcl.verdict(info.sender.ip, resolved.fqdn, true) !== 'allowed') return;
    }
    const build = (text: string): RsyslogMessage | null =>
      this.buildMessage(info, text, now, fromHost, fromHostIp, fromHostPort);
    const message = build(raw);
    if (message === null) return;
    const limiter = info.limiter ?? this.defaultLimiter;
    const decision = limiter.decide(message);
    if (decision.repeated !== null) this.enqueue(decision.repeated);
    if (decision.deliver !== null) this.admit(decision.deliver, build);
  }

  private buildMessage(
    info: InputSubmission, raw: string, now: number, fromHost: string | null, fromHostIp: string | null, fromHostPort: string | null,
  ): RsyslogMessage | null {
    const settings = this.config.settings;
    const message = new RsyslogMessage({
      rawMsg: raw,
      receivedAt: this.timeAt(now),
      inputName: info.inputName,
      fromHost,
      fromHostIp,
      fromHostPort,
      defaultTimeZone: info.defaultTimeZone,
      internal: info.internal,
      parseHostname: info.parseHostname,
      ignoreDate: info.ignoreDate,
      noPriInRaw: info.noPriInRaw,
      mark: info.mark,
      localHostName: this.localHostName(),
    });
    message.rulesetName = info.ruleset;
    if (info.cee !== undefined) message.cee = jsonDeepCopy(info.cee) as typeof message.cee;
    if (info.preparsed !== undefined) {
      const fields = info.preparsed;
      if (fields.priority === null) message.setPri(LOG_PRI_INVALID);
      else message.setPri(fields.priority);
      message.offAfterPri = fields.offsetAfterPriority;
      message.tag = fields.tag;
      message.msg = fields.msg;
      if (fields.timestamp !== null) message.timestamp = fields.timestamp;
      message.parseSuccess = true;
    } else {
      const outcome = parseReceivedMessage(message, this.parsersFor(info.ruleset), settings.parser);
      if (outcome === 'empty') return null;
      if (message.discarded) return null;
    }
    if (message.rulesetName === null) message.rulesetName = info.ruleset;
    return message;
  }

  private admit(message: RsyslogMessage, build: (raw: string) => RsyslogMessage | null): void {
    const settings = this.config.settings;
    const maxLine = settings.parser.maxLine;
    const raw = message.rawMsg;
    if (raw.length <= maxLine) {
      this.enqueue(message);
      return;
    }
    if (settings.oversize.report) {
      this.runtimeLog.log(4, RS_RET.OVERSIZE_MSG, `message too long (${raw.length}) with configured size ${maxLine}, begin of message is: ${raw.slice(0, 80)}`);
    }
    this.writeOversizeLog(message);
    if (settings.oversize.mode === 'accept') {
      this.enqueue(message);
    } else if (settings.oversize.mode === 'truncate') {
      const truncated = build(raw.slice(0, maxLine));
      if (truncated !== null) this.enqueue(truncated);
    } else {
      for (let offset = 0; offset < raw.length; offset += maxLine) {
        const segment = build(raw.slice(offset, offset + maxLine));
        if (segment !== null) this.enqueue(segment);
      }
    }
  }

  private writeOversizeLog(message: RsyslogMessage): void {
    const path = this.config.settings.oversize.errorFile;
    if (path === null) return;
    if (this.oversizeLog === null) {
      const opened = this.host.files.open(path, {
        mode: 0o660, directoryMode: 0o700, uid: null, gid: null, directoryUid: null, directoryGid: null,
        createDirectories: false, failOnChownFailure: false,
      });
      if ('error' in opened) {
        this.runtimeLog.log(3, RS_RET.ERR, `error opening oversize message log file ${path}: ${opened.error}`);
        return;
      }
      this.oversizeLog = opened.handle;
    }
    const entry = messageAsJson(message);
    if (entry['$!'] === null) delete entry['$!'];
    entry.input = message.inputName;
    const failure = this.oversizeLog.write(`${jsonText(entry)}\n`);
    if (failure !== null) {
      this.runtimeLog.log(3, RS_RET.IO_ERROR, `error writing oversize message log file ${path}, write returned -1: ${failure}`);
    }
  }

  private enqueue(message: RsyslogMessage): void {
    const queue = this.rulesetQueues.get(message.rulesetName ?? '') ?? this.mainQueue;
    queue.enqueue(message);
  }

  internal(severity: number, code: number, text: string, mark = false, facility = LOG_SYSLOG): void {
    this.events.onInternalMessage?.(severity, code, text);
    if (!this.started) return;
    const sanitized = text.replace(/[\x00-\x1f\x7f]/g, ' ');
    const localName = this.localHostName();
    const message = new RsyslogMessage({
      rawMsg: sanitized,
      receivedAt: this.timeAt(this.host.clock.wallMs()),
      inputName: INTERNAL_INPUT,
      fromHost: localName,
      fromHostIp: '127.0.0.1',
      fromHostPort: null,
      internal: true,
      mark,
      localHostName: localName,
    });
    message.setPri(facility * 8 + (severity & 7));
    message.hostname = localName;
    message.tag = code === RS_RET.NO_ERRCODE ? 'rsyslogd:' : `rsyslogd${code}:`;
    message.msg = sanitized;
    message.parseSuccess = true;
    if (this.internalBacklog !== null) {
      this.internalBacklog.push(message);
      return;
    }
    this.processInternal(message);
  }

  private processInternal(message: RsyslogMessage): void {
    const decision = this.internalLimiter.decide(message);
    if (decision.repeated !== null) this.writeInternal(decision.repeated);
    if (decision.deliver !== null) this.writeInternal(decision.deliver);
  }

  private writeInternal(message: RsyslogMessage): void {
    const settings = this.config.settings;
    if (message.severity > settings.internalMessages.severityFilter) return;
    if (settings.processInternalMessages) {
      message.rulesetName = null;
      this.enqueue(message);
    } else {
      this.host.syslog?.(message.pri, message.msg);
    }
  }

  start(replay: () => void = () => undefined): StartOutcome {
    if (this.started) return { ok: true };
    this.started = true;
    this.internalBacklog = [];
    replay();
    const settings = this.config.settings;
    const process = this.host.process;
    if (settings.umask !== null) process?.setUmask(settings.umask);
    if (settings.maxOpenFiles !== null && settings.maxOpenFiles > 0 && process !== undefined) {
      const failure = process.setOpenFilesLimit(settings.maxOpenFiles);
      if (failure !== null) {
        this.runtimeLog.log(
          3, RS_RET.ERR_RLIM_NOFILE, `could not set process file limit to ${settings.maxOpenFiles} [current hard limit ${failure.hardLimit}]`, failure.errno,
        );
        return this.abortStart(RS_RET.ERR_RLIM_NOFILE);
      }
    }
    const strict = settings.abortOnUncleanConfig || settings.requireAllInputs;
    const started: InputInstance[] = [];
    const startRecords = (records: InputRecord[]): number | null => {
      for (const record of records) {
        if (record.instance.start()) {
          started.push(record.instance);
        } else if (settings.requireAllInputs) {
          this.runtimeLog.log(3, RS_RET.NO_RUN, `input module ${record.module} will not run`);
          return RS_RET.NO_RUN;
        }
      }
      return null;
    };
    const early = this.config.inputs.filter((record) => record.instance.bindsBeforePrivilegeDrop === true);
    const late = this.config.inputs.filter((record) => record.instance.bindsBeforePrivilegeDrop !== true);
    for (const record of early) {
      if (record.instance.start()) {
        started.push(record.instance);
        continue;
      }
      this.runtimeLog.log(3, RS_RET.NO_RUN, `activation of module ${record.module} failed`);
      if (strict) return this.abortStart(RS_RET.NO_RUN, started);
    }
    const dropped = this.dropPrivileges();
    if (dropped !== null) return this.abortStart(dropped, started);
    const failed = startRecords(late);
    if (failed !== null) return this.abortStart(failed, started);
    const backlog = this.internalBacklog ?? [];
    this.internalBacklog = null;
    for (const message of backlog) this.processInternal(message);
    return { ok: true };
  }

  private abortStart(code: number, started: readonly InputInstance[] = []): StartOutcome {
    for (const instance of started) instance.stop();
    this.internalBacklog = null;
    this.started = false;
    return { ok: false, code };
  }

  private dropPrivileges(): number | null {
    const { uid, gid, keepSupplemental } = this.config.settings.privDrop;
    const process = this.host.process;
    if (process === undefined) return null;
    if (gid !== 0) {
      if (!keepSupplemental) {
        const refused = process.setSupplementaryGroups([]);
        if (refused !== null) {
          this.runtimeLog.log(3, RS_RET.ERR_DROP_PRIV, 'could not remove supplemental group IDs via setgroups(): missing CAP_SETGID or insufficient privilege', refused);
          return RS_RET.ERR_DROP_PRIV;
        }
      }
      const refused = process.setGid(gid);
      if (refused !== null) {
        this.runtimeLog.log(3, RS_RET.ERR_DROP_PRIV, `could not set requested group id ${gid} via setgid(): missing CAP_SETGID or insufficient privilege`, refused);
        return RS_RET.ERR_DROP_PRIV;
      }
      this.internal(6, RS_RET.NO_ERRCODE, `rsyslogd's groupid changed to ${gid}`);
    }
    if (uid !== 0) {
      const name = process.userNameOf(uid);
      if (name === null) {
        this.runtimeLog.log(3, RS_RET.NO_ERRCODE, `could not get username for userid '${uid}'`);
      } else {
        const refused = process.initSupplementaryGroups(name, process.currentGid());
        if (refused !== null) {
          this.runtimeLog.log(3, RS_RET.ERR_DROP_PRIV, `could not initialize supplemental groups for user id ${uid} via initgroups(): missing CAP_SETGID or insufficient privilege`, refused);
        }
      }
      const refused = process.setUid(uid);
      if (refused !== null) {
        this.runtimeLog.log(3, RS_RET.ERR_DROP_PRIV, `could not set requested user id ${uid} via setuid(): missing CAP_SETUID or insufficient privilege`, refused);
        return RS_RET.ERR_DROP_PRIV;
      }
      this.internal(6, RS_RET.NO_ERRCODE, `rsyslogd's userid changed to ${uid}`);
    }
    return null;
  }

  stop(): void {
    if (!this.started) return;
    for (const record of this.config.inputs) record.instance.stop();
    this.mainQueue.stop();
    for (const queue of this.rulesetQueues.values()) queue.stop();
    for (const queue of this.actionQueues.values()) queue.stop();
    for (const runtime of this.actions.values()) runtime.stop();
    for (const callback of this.stopCallbacks) callback();
    this.stopCallbacks = [];
    this.oversizeLog?.close();
    this.oversizeLog = null;
    this.started = false;
  }

  hup(): void {
    for (const runtime of this.actions.values()) runtime.hup();
    this.oversizeLog?.close();
    this.oversizeLog = null;
  }

  onStop(callback: () => void): void {
    this.stopCallbacks.push(callback);
  }

  actionRuntimes(): ActionRuntime[] {
    return [...this.actions.values()];
  }

  get isStarted(): boolean {
    return this.started;
  }
}
