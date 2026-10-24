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
import { OperatingStateFile } from './OperatingState';
import { RSYSLOG_VERSION } from './Log';
import { DiskQueueStore } from './DiskQueueStore';
import type { QueueSettings } from './Settings';
import { renderTemplate } from '../Template';
import type { InputInstance, InputSubmission, InputSubmitter, RuntimeLog } from './Modules';
import { WorkerQueue, type ProcessOutcome } from './Queue';

const LOG_SYSLOG = 5;
const INTERNAL_INPUT = 'rsyslogd';

export type StartOutcome = { readonly ok: true } | { readonly ok: false; readonly code: number; readonly exitText?: string };

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
  private operatingState: OperatingStateFile | null = null;
  private readonly runtimeLog: RuntimeLog;

  constructor(readonly config: LoadedConfig, private readonly host: RsyslogHost, private readonly events: EngineEvents = {}) {
    const runtimeLog: RuntimeLog = {
      error: (text, code, errno) => runtimeLog.log(3, code ?? RS_RET.ERR, text, errno),
      warning: (text, code) => runtimeLog.log(4, code ?? RS_RET.NO_ERRCODE, text),
      info: (text, code) => runtimeLog.log(6, code ?? RS_RET.NO_ERRCODE, text),
      childExited: (pid, exitCode) => {
        const policy = config.settings.reportChildProcessExits;
        if (policy === 'none' || (policy === 'errors' && exitCode === 0)) return;
        runtimeLog.log(exitCode === 0 ? 6 : 4, RS_RET.NO_ERRCODE, `child process (pid ${pid}) exited with status ${exitCode}`);
      },
      log: (severity, code, text, errno) => this.internal(severity, code, formatLogEntry(text, code, errno ?? null)),
      internal: (severity, code, text, mark, facility) => this.internal(severity, code, text, mark, facility),
    };
    this.runtimeLog = runtimeLog;
    config.bindRuntime(runtimeLog);
    config.rateLimits.bindRenderer((template, message) => renderTemplate(template, message, this.renderContext()));
    this.defaultLimiter = this.newLimiter('rsyslogd', 0, 10000, 0);
    this.internalLimiter = this.newLimiter(
      'rsyslogd[internal_messages]', config.settings.internalMessages.rateInterval, config.settings.internalMessages.rateBurst, 0,
    );
    this.mainQueue = this.newQueue('main Q', config.settings.mainQueue, (message) => this.processThroughRuleset(message));
    for (const [name, ruleset] of config.rulesets) {
      if (ruleset.queue !== null && ruleset.queue.type !== 'Direct') {
        this.rulesetQueues.set(name, this.newQueue(`ruleset ${name} queue`, ruleset.queue, (message) => this.processThroughRuleset(message)));
      }
    }
    for (const definition of config.actions) {
      const runtime = new ActionRuntime(definition, this.actionServices(), definition.id - 1);
      this.actions.set(definition.id, runtime);
      this.registerActionStatistics(runtime);
      const queue = definition.options.queue;
      if (queue.type === 'Direct') continue;
      this.actionQueues.set(definition.id, this.newQueue(`${runtime.name} queue`, queue, (message) => this.processAction(runtime, message), () => { runtime.counters.batchesProcessed++; return runtime.commit(); }));
    }
  }

  private newQueue(
    name: string, settings: import('./Settings').QueueSettings, process: (message: RsyslogMessage) => Generator<Sleep, ProcessOutcome>,
    endBatch: () => Generator<Sleep, void> = () => this.commitActions(),
  ): WorkerQueue<RsyslogMessage> {
    const disk = settings.type === 'Disk' && settings.fileName !== null ? this.newDiskStore(settings) : null;
    const queue = new WorkerQueue<RsyslogMessage>(
      name,
      settings,
      {
        schedule: (callback, delay) => this.host.schedule(callback, delay),
        localHour: () => this.renderContext().now().hour,
        nowMs: () => this.host.clock.wallMs(),
        report: (text) => this.internal(4, -1, text),
        endBatch,
      },
      process,
      disk,
    );
    if (settings.type !== 'Direct') this.registerQueueStatistics(queue);
    return queue;
  }

  private registerQueueStatistics(queue: WorkerQueue<RsyslogMessage>): void {
    const counters = queue.statistics;
    const object = this.config.statistics.create(queue.name, { origin: 'core.queue' });
    object.addCounter({ name: 'size', read: () => queue.length });
    object.addCounter({ name: 'enqueued', read: () => counters.enqueued, reset: () => { counters.enqueued = 0; } });
    object.addCounter({ name: 'full', read: () => counters.full, reset: () => { counters.full = 0; } });
    object.addCounter({ name: 'discarded.full', read: () => counters.discardedFull, reset: () => { counters.discardedFull = 0; } });
    object.addCounter({ name: 'discarded.nf', read: () => counters.discardedNearlyFull, reset: () => { counters.discardedNearlyFull = 0; } });
    object.addCounter({ name: 'maxqsize', read: () => counters.maxSize });
  }

  private registerActionStatistics(runtime: ActionRuntime): void {
    const object = this.config.statistics.create(runtime.name, { origin: 'core.action' });
    const counters = runtime.counters;
    object.addCounter({ name: 'processed', read: () => counters.processed, reset: () => { counters.processed = 0; } });
    object.addCounter({ name: 'batchesprocessed', read: () => counters.batchesProcessed, reset: () => { counters.batchesProcessed = 0; } });
    object.addCounter({ name: 'failed', read: () => counters.failed, reset: () => { counters.failed = 0; } });
    object.addCounter({ name: 'suspended', read: () => counters.suspended, reset: () => { counters.suspended = 0; } });
    object.addCounter({ name: 'suspended.duration', read: () => counters.suspendedDuration });
    object.addCounter({ name: 'resumed', read: () => counters.resumed, reset: () => { counters.resumed = 0; } });
    object.addCounter({ name: 'ratelimit.allowed', read: () => counters.rateLimitAllowed, reset: () => { counters.rateLimitAllowed = 0; } });
    object.addCounter({ name: 'ratelimit.dropped', read: () => counters.rateLimitDropped, reset: () => { counters.rateLimitDropped = 0; } });
    object.addCounter({ name: 'ratelimit.paced', read: () => counters.rateLimitPaced, reset: () => { counters.rateLimitPaced = 0; } });
    object.addCounter({ name: 'ratelimit.paced_usec', read: () => counters.rateLimitPacedMicroseconds, reset: () => { counters.rateLimitPacedMicroseconds = 0; } });
  }

  private *commitActions(): Generator<Sleep, void> {
    for (const runtime of this.actions.values()) yield* runtime.commit();
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
      error: (text) => this.runtimeLog.log(3, RS_RET.CONF_PARSE_ERROR, `error during config processing: ${text}`),
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
      reloadLookupTable: (name, stub) => this.config.lookupTables.find((table) => table.name === name)?.reload(stub),
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
    if (result === 'requeued') return 'requeue';
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
    this.operatingState?.write('MSG', text.replace(/ \[v[^\]]*\]$/, ''));
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
    const stateFile = this.config.settings.operatingStateFile;
    if (stateFile !== null) {
      this.operatingState = new OperatingStateFile(stateFile, {
        files: this.host.files, now: () => this.timeAt(this.host.clock.wallMs()), version: RSYSLOG_VERSION,
        report: (text, level, code) => this.runtimeLog.log(level === 'error' ? 3 : 6, code, text),
      });
      this.operatingState.open();
    }
    replay();
    if (this.config.fatalConfigError !== null) {
      this.runtimeLog.log(3, RS_RET.NOT_FOUND, this.config.fatalConfigError);
      return this.abortStart(RS_RET.NOT_FOUND);
    }
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
    const queueFailure = this.activateQueues();
    if (queueFailure !== null) return this.abortStart(queueFailure.code, started, queueFailure.exitText);
    const backlog = this.internalBacklog ?? [];
    this.internalBacklog = null;
    for (const message of backlog) this.processInternal(message);
    this.restoreQueues();
    for (const instance of started) instance.run?.();
    this.stopCallbacks.push(this.host.scheduleEvery(() => this.runJanitor(), Math.max(1, settings.janitorInterval) * 60_000));
    return { ok: true };
  }

  private runJanitor(): void {
    this.config.janitor.run();
    const senders = this.config.settings.senders;
    const oldestAllowed = Math.floor(this.host.clock.wallMs() / 1000) - senders.timeoutAfter;
    this.config.statistics.senders.removeStale(oldestAllowed, (record) => {
      if (!senders.reportGoneAway) return;
      const time = this.timeAt(record.lastSeen * 1000);
      const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
      this.runtimeLog.log(
        4, RS_RET.SENDER_GONE_AWAY,
        `removing sender '${record.sender}' from connection table, last seen at ${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)} ${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`,
      );
    });
  }

  private abortStart(code: number, started: readonly InputInstance[] = [], exitText?: string): StartOutcome {
    for (const instance of started) instance.stop();
    this.internalBacklog = null;
    this.started = false;
    return exitText === undefined ? { ok: false, code } : { ok: false, code, exitText };
  }

  private queueCannotStart(queue: import('./Settings').QueueSettings): boolean {
    return queue.type === 'Disk' && queue.fileName === null;
  }

  private activateQueues(): { readonly code: number; readonly exitText: string } | null {
    const abort = this.config.settings.abortOnFailedQueueStartup;
    const code = RS_RET.FILE_PREFIX_MISSING;
    for (const definition of this.config.actions) {
      if (!this.queueCannotStart(definition.options.queue)) continue;
      if (abort) {
        return { code, exitText: `rsyslogd: error ${code} starting up action queue, abortOnFailedQueueStartup is set, so we abort rsyslog now.` };
      }
      this.runtimeLog.log(3, code, 'error starting up action queue');
      this.runtimeLog.log(3, code, 'file prefix (work directory?) is missing');
      this.actions.get(definition.id)?.disable();
    }
    if (this.queueCannotStart(this.config.settings.mainQueue)) {
      if (abort) {
        return {
          code,
          exitText: 'rsyslogd: could not start (ruleset) main message queue, local queue safety or abortOnFailedQueueStartup requires aborting rsyslog now.',
        };
      }
      this.runtimeLog.log(3, code, 'could not start (ruleset) main message queue');
    }
    return null;
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
    this.drainQueues();
    this.saveQueues();
    this.mainQueue.stop();
    for (const queue of this.rulesetQueues.values()) queue.stop();
    for (const queue of this.actionQueues.values()) queue.stop();
    for (const runtime of this.actions.values()) runtime.stop();
    for (const table of this.config.lookupTables) table.stop();
    this.config.rateLimits.close();
    this.config.dynStats.persistAll();
    this.operatingState?.close();
    this.operatingState = null;
    for (const callback of this.stopCallbacks) callback();
    this.stopCallbacks = [];
    this.oversizeLog?.close();
    this.oversizeLog = null;
    this.started = false;
  }

  private drainQueues(): void {
    const ordered = [this.mainQueue, ...this.rulesetQueues.values(), ...this.actionQueues.values()];
    if (this.config.settings.shutdownQueueDoubleSize) for (const queue of ordered) queue.doubleCapacity();
    for (const queue of ordered) {
      queue.runWorkerFor(queue.settings.timeoutShutdown, false);
      if (queue.midMessage) queue.runWorkerFor(queue.settings.timeoutActionCompletion, true);
    }
  }

  private newDiskStore(settings: QueueSettings): DiskQueueStore {
    const global = this.config.settings;
    const prefix = settings.fileName ?? '';
    const maxFileSize = settings.maxFileSize;
    let maxDiskSpace = settings.maxDiskSpace;
    if (maxDiskSpace > 0 && maxFileSize > 0 && maxDiskSpace < maxFileSize) {
      this.internal(3, RS_RET.CONF_PARAM_INVLD, `queue.maxDiskSpace (${maxDiskSpace}) must be larger than queue.maxFileSize (${maxFileSize}) - setting queue.maxDiskSpace to ${maxFileSize}`);
      maxDiskSpace = maxFileSize;
    }
    return new DiskQueueStore(
      { directory: settings.spoolDirectory ?? global.workDirectory ?? '', prefix, maxFileSize, maxDiskSpace },
      {
        files: this.host.files,
        codec: () => ({ localHostName: this.localHostName(), defaultTimeZone: null, compactJson: global.compactJson }),
        report: (severity, text) => this.internal(severity, -1, text),
      },
      {
        mode: 0o600, directoryMode: 0o700, uid: null, gid: null, directoryUid: null, directoryGid: null,
        createDirectories: false, failOnChownFailure: false,
      },
    );
  }

  private allQueues(): WorkerQueue<RsyslogMessage>[] {
    return [this.mainQueue, ...this.rulesetQueues.values(), ...this.actionQueues.values()];
  }

  private spillsOnShutdown(queue: WorkerQueue<RsyslogMessage>): boolean {
    const { type, fileName, saveOnShutdown } = queue.settings;
    return queue.disk === null && type !== 'Direct' && fileName !== null && saveOnShutdown;
  }

  private saveQueues(): void {
    for (const queue of this.allQueues()) {
      if (queue.disk !== null) {
        queue.closeStore();
        continue;
      }
      const pending = queue.pending();
      if (!this.spillsOnShutdown(queue) || pending.length === 0) continue;
      const store = this.newDiskStore(queue.settings);
      const failure = pending.map((message) => store.append(message)).find((result) => result !== null);
      if (failure !== undefined) this.internal(3, -1, `queue '${queue.name}': could not save the queue state: ${failure}`);
      store.persist(false, pending.length);
      store.close(pending.length);
    }
  }

  private restoreQueues(): void {
    for (const queue of this.allQueues()) {
      const resident = queue.disk !== null;
      if (!resident && !this.spillsOnShutdown(queue)) continue;
      const store = queue.disk ?? this.newDiskStore(queue.settings);
      const backlog = store.load();
      if (backlog === null) continue;
      this.internal(6, RS_RET.NO_ERRCODE, `${queue.name}: queue files exist on disk, re-starting with ${backlog.messages.length} messages. This will keep the disk queue file open, details: https://rainer.gerhards.net/2013/07/rsyslog-why-disk-assisted-queues-keep-a-file-open.html`);
      if (resident) {
        queue.restore(backlog.messages);
        continue;
      }
      store.drop();
      for (const message of backlog.messages) queue.enqueue(message);
    }
  }

  hup(): void {
    for (const runtime of this.actions.values()) runtime.hup();
    for (const record of this.config.inputs) record.instance.hup?.();
    for (const table of this.config.lookupTables) if (table.reloadOnHup) table.reload(null);
    this.config.rateLimits.hup();
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
