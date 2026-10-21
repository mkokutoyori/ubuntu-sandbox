import type { RsyslogMessage } from '../Message';
import { renderTemplate, renderTemplateJson } from '../Template';
import type { ActionDefinition } from './Config';
import type { FileHandle, RsyslogHost } from './Host';
import type { ActionArguments, ActionOutcome, ActionWorker } from './Modules';
import type { Sleep } from './Execution';
import { jsonText } from '../Json';
import { RS_RET } from './Log';
import type { ScriptState } from '../config/Expressions';
import type { RenderContext } from '../Properties';

export type ActionState = 'ready' | 'retry' | 'suspended' | 'disabled';
export type SubmitResult = 'delivered' | 'dropped' | 'deferred';

export interface ActionServices {
  readonly host: RsyslogHost;
  renderContext(): RenderContext;
  log(severity: number, code: number, text: string): void;
  markIntervalSeconds(): number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function ctime(epochMs: number, offsetMinutes: number): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${WEEKDAYS[shifted.getUTCDay()]} ${MONTHS[shifted.getUTCMonth()]} ${String(shifted.getUTCDate()).padStart(2, ' ')} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} ${shifted.getUTCFullYear()}`;
}

export class ActionRuntime {
  state: ActionState = 'ready';
  readonly name: string;
  readonly moduleDisplayName: string;
  private worker: ActionWorker | null = null;
  private skipped = 0;
  private lastOccurrenceSeconds = 0;
  private lastExecutionSeconds = 0;
  private lastMessageSeconds = 0;
  private resumeAtSeconds = 0;
  private retriesInRow = 0;
  private resumeInRow = 0;
  private errorHandle: FileHandle | null = null;
  private errorFileSize = 0;
  private transactionMessages = 0;
  private pendingFailures: Array<{ readonly status: number; readonly strings: readonly string[]; readonly hard: boolean }> = [];
  counters = {
    processed: 0, batchesProcessed: 0, failed: 0, suspended: 0, suspendedDuration: 0, resumed: 0,
    rateLimitAllowed: 0, rateLimitDropped: 0, rateLimitPaced: 0, rateLimitPacedMicroseconds: 0,
  };

  constructor(readonly definition: ActionDefinition, private readonly services: ActionServices, ordinal: number) {
    this.moduleDisplayName = definition.moduleDisplayName;
    this.name = definition.options.name ?? `action-${ordinal}-${definition.moduleDisplayName}`;
  }

  private nowSeconds(): number {
    return Math.floor(this.services.host.clock.wallMs() / 1000);
  }

  private ensureWorker(): ActionWorker {
    if (this.worker === null) this.worker = this.definition.instance.createWorker();
    return this.worker;
  }

  hup(): void {
    this.definition.instance.hup?.();
  }

  stop(): void {
    this.flushFailures();
    this.errorHandle?.close();
    this.errorHandle = null;
    this.worker?.close();
    this.worker = null;
    this.definition.instance.teardown?.();
  }

  commit(): void {
    this.flushFailures();
    if (this.state !== 'ready') return;
    const outcome = this.worker?.endTransaction?.();
    if (outcome === 'suspended') this.enterRetry();
  }

  resumeDelayMs(): number {
    if (this.state !== 'suspended') return 0;
    return Math.max(0, this.resumeAtSeconds * 1000 - this.services.host.clock.wallMs());
  }

  private render(message: RsyslogMessage): ActionArguments {
    const strings: string[] = [];
    const json: unknown[] = [];
    const context = this.services.renderContext();
    for (const binding of this.definition.templates) {
      if (binding.template === null) {
        strings.push('');
        json.push(message);
      } else if (binding.request.asJson === true) {
        strings.push('');
        json.push(renderTemplateJson(binding.template, message, context));
      } else {
        strings.push(renderTemplate(binding.template, message, context));
        json.push(null);
      }
    }
    return { strings, json };
  }

  private suspendNow(): void {
    const options = this.definition.options;
    let duration = options.resumeInterval * (Math.floor(this.retriesInRow / 10) + 1);
    if (options.resumeIntervalMax > 0 && duration > options.resumeIntervalMax) duration = options.resumeIntervalMax;
    const nowMs = this.services.host.clock.wallMs();
    this.resumeAtSeconds = Math.floor(nowMs / 1000) + duration;
    this.state = 'suspended';
    this.counters.suspendedDuration += duration;
    if (this.retriesInRow === 0) this.counters.suspended++;
    if (options.reportSuspensionContinuation || (options.reportSuspension && this.retriesInRow === 0)) {
      const offset = this.services.renderContext().now().offsetHour * 60 + this.services.renderContext().now().offsetMinute;
      const sign = this.services.renderContext().now().offsetMode === '-' ? -1 : 1;
      this.services.log(
        4, RS_RET.SUSPENDED,
        `action '${this.name}' suspended (module '${this.moduleDisplayName}'), next retry is ${ctime(this.resumeAtSeconds * 1000, sign * offset)}, retry nbr ${this.retriesInRow}. There should be messages before this one giving the reason for suspension.`,
      );
    }
  }

  private enterRetry(): void {
    const options = this.definition.options;
    this.state = 'retry';
    if (options.reportSuspension) {
      this.services.log(
        4, RS_RET.SUSPENDED,
        `action '${this.name}' suspended (module '${this.moduleDisplayName}'), retry ${this.retriesInRow}. There should be messages before this one giving the reason for suspension.`,
      );
    }
    this.resumeInRow++;
  }

  private *retryLoop(): Generator<Sleep, void> {
    const options = this.definition.options;
    let attempts = 0;
    while (this.state === 'retry') {
      let outcome: ActionOutcome = this.ensureWorker().tryResume?.() ?? 'ok';
      let treatOkAsSuspended = false;
      if (this.resumeInRow > 9 && this.resumeInRow % 10 === 0) {
        treatOkAsSuspended = true;
        this.resumeInRow = 0;
        outcome = 'suspended';
      }
      if (outcome === 'ok' && !treatOkAsSuspended) {
        this.counters.resumed++;
        if (options.reportSuspension) {
          this.services.log(6, RS_RET.RESUMED, `action '${this.name}' resumed (module '${this.moduleDisplayName}')`);
        }
        this.state = 'ready';
      } else if (outcome === 'suspended') {
        if (options.resumeRetryCount !== -1 && attempts >= options.resumeRetryCount) {
          this.suspendNow();
          if (this.retriesInRow < 20) this.retriesInRow++;
        } else {
          attempts++;
          yield { sleepMs: options.resumeInterval * 1000 };
        }
      } else if (outcome === 'disable') {
        this.state = 'disabled';
      }
    }
    if (this.state === 'ready') this.retriesInRow = 0;
  }

  private *prepare(): Generator<Sleep, void> {
    if (this.state === 'disabled') return;
    this.ensureWorker();
    if (this.state === 'suspended' && this.nowSeconds() >= this.resumeAtSeconds) this.state = 'retry';
    if (this.state === 'retry') yield* this.retryLoop();
    if (this.state === 'ready' && this.definition.options.externalStateFile !== null) {
      if (this.externalStateSuspends()) yield* this.externalStateRetryLoop();
      this.state = 'ready';
    }
  }

  private externalStateSuspends(): boolean {
    const path = this.definition.options.externalStateFile as string;
    const content = this.services.host.files.read(path);
    if (content === null || content.length === 0) return false;
    let text = content.slice(0, 1023);
    for (let index = text.length - 1; index > 0; index--) {
      if (text[index] !== '\n' && text[index] !== '\t' && text[index] !== ' ') break;
      text = text.slice(0, index);
    }
    if (text !== 'SUSPENDED') return false;
    this.services.log(4, RS_RET.SUSPENDED, `action '${this.name}' suspended (module '${this.moduleDisplayName}') by external state file`);
    this.enterRetry();
    return true;
  }

  private *externalStateRetryLoop(): Generator<Sleep, void> {
    const options = this.definition.options;
    let attempts = 0;
    while (this.state === 'retry') {
      if (!this.externalStateSuspends()) {
        if (options.reportSuspension) this.services.log(6, RS_RET.RESUMED, `action '${this.name}' resumed (module '${this.moduleDisplayName}') via external state file`);
        this.state = 'ready';
      } else if (options.resumeRetryCount !== -1 && attempts >= options.resumeRetryCount) {
        this.suspendNow();
        if (this.retriesInRow < 20) this.retriesInRow++;
      } else {
        attempts++;
        yield { sleepMs: options.resumeInterval * 1000 };
      }
    }
    if (this.state === 'ready') this.retriesInRow = 0;
  }

  private flushFailures(): void {
    const failures = this.pendingFailures;
    const total = this.transactionMessages;
    this.pendingFailures = [];
    this.transactionMessages = 0;
    for (const failure of failures) {
      if (failure.hard && total === 1) continue;
      this.writeErrorFile(failure.status, failure.strings);
    }
  }

  private writeErrorFile(status: number, strings: readonly string[]): void {
    this.counters.failed++;
    const options = this.definition.options;
    const path = options.errorFile;
    if (path === null) return;
    const files = this.services.host.files;
    if (this.errorHandle === null) {
      const opened = files.open(path, {
        mode: 0o660, directoryMode: 0o700, uid: null, gid: null, directoryUid: null, directoryGid: null, createDirectories: false, failOnChownFailure: false,
      });
      if ('error' in opened) {
        this.services.log(3, RS_RET.ERR, `action ${this.name}: error opening error file ${path}: ${opened.error}`);
        return;
      }
      this.errorHandle = opened.handle;
      if (options.errorFileMaxSize > 0) this.errorFileSize = files.statSize(path) ?? 0;
    }
    const entry: { [key: string]: string | number } = { action: this.name, status };
    strings.forEach((text, index) => { entry[`template${index}`] = text; });
    let rendered = `${jsonText(entry)}\n`;
    if (options.errorFileMaxSize > 0) {
      let toWrite = rendered.length;
      if (this.errorFileSize + toWrite > options.errorFileMaxSize) toWrite = options.errorFileMaxSize - this.errorFileSize;
      this.errorFileSize += toWrite;
      rendered = toWrite > 0 ? `${rendered.slice(0, toWrite - 1)}\n` : '';
    }
    if (rendered.length > 0) this.errorHandle.write(rendered);
  }

  private *execute(args: ActionArguments, message: RsyslogMessage): Generator<Sleep, SubmitResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const suspendedBefore = this.state === 'suspended';
      yield* this.prepare();
      if (this.state === 'disabled') return 'dropped';
      if (this.state !== 'ready') {
        if (this.state === 'suspended') this.pendingFailures.push({ status: suspendedBefore ? RS_RET.OK_VALUE : RS_RET.SUSPENDED, strings: args.strings, hard: false });
        return 'deferred';
      }
      const outcome = this.ensureWorker().doAction(args, message);
      switch (outcome) {
        case 'ok':
        case 'discard':
        case 'defer': {
          this.resumeInRow = 0;
          const pauseMs = this.ensureWorker().pauseAfterAction?.() ?? 0;
          if (pauseMs > 0) yield { sleepMs: pauseMs };
          return 'delivered';
        }
        case 'suspended':
          this.enterRetry();
          continue;
        case 'disable':
          this.state = 'disabled';
          return 'dropped';
        default: {
          const status = this.ensureWorker().failureCode?.() ?? RS_RET.DATAFAIL;
          this.pendingFailures.push({ status, strings: args.strings, hard: true });
          this.services.log(
            3, status,
            `action '${this.name}' (module '${this.moduleDisplayName}') message lost, could not be processed. Check for additional error messages before this one.`,
          );
          return 'dropped';
        }
      }
    }
    yield* this.prepare();
    return 'deferred';
  }

  private *passesOutputRateLimit(): Generator<Sleep, boolean> {
    const output = this.definition.outputLimiter;
    if (output === null) return true;
    const counters = this.counters;
    if (output.shared.outputMode === 'drop') {
      if (output.limiter.admit(this.name)) {
        counters.rateLimitAllowed++;
        return true;
      }
      counters.rateLimitDropped++;
      return false;
    }
    for (;;) {
      const wait = output.limiter.waitMicroseconds();
      if (wait === 0) {
        counters.rateLimitAllowed++;
        return true;
      }
      const sleep = wait > 1_000_000 ? 1_000_000 : wait;
      counters.rateLimitPaced++;
      counters.rateLimitPacedMicroseconds += sleep;
      yield { sleepMs: sleep / 1000 };
    }
  }

  *submit(message: RsyslogMessage, script: ScriptState): Generator<Sleep, SubmitResult> {
    const options = this.definition.options;
    if (this.state === 'disabled') return 'dropped';
    if (options.execOnlyWhenPreviousIsSuspended && !script.previousSuspended) return 'dropped';
    const now = this.nowSeconds();
    const complex = options.execOnlyEveryNthTime > 1 || options.execOnlyOnceEveryInterval > 0;
    const markWindow = Math.floor(this.services.markIntervalSeconds() / 2);
    if (!options.writeAllMarkMessages) {
      if (complex) {
        if (message.mark && now - this.lastMessageSeconds < markWindow) return 'dropped';
      } else {
        if (message.mark && message.receivedAtSeconds - this.lastMessageSeconds < markWindow) return 'dropped';
        this.lastMessageSeconds = message.receivedAtSeconds;
      }
    }
    if (options.execOnlyEveryNthTime > 1) {
      if (options.execOnlyEveryNthTimeTimeout > 0 && now - this.lastOccurrenceSeconds > options.execOnlyEveryNthTimeTimeout) {
        this.skipped = 0;
        this.lastOccurrenceSeconds = now;
      }
      if (this.skipped < options.execOnlyEveryNthTime - 1) {
        this.skipped++;
        return 'dropped';
      }
      this.skipped = 0;
    }
    if (options.execOnlyOnceEveryInterval > 0 && options.execOnlyOnceEveryInterval + this.lastExecutionSeconds > now) return 'dropped';
    this.lastExecutionSeconds = now;
    if (complex) this.lastMessageSeconds = message.receivedAtSeconds;
    this.counters.processed++;
    if (options.queue.type === 'Direct') this.counters.batchesProcessed++;
    if (!(yield* this.passesOutputRateLimit())) return 'dropped';
    this.transactionMessages++;
    const args = this.render(message);
    const result = yield* this.execute(args, message);
    script.previousSuspended = result === 'deferred';
    return result;
  }
}
