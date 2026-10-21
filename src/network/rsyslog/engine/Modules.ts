import type { Errno } from '@/network/core/Errno';
import type { SyslogTime } from '@/network/syslog/codec/SyslogTime';
import type { NvList } from '../config/Ast';
import type { ParamDescriptor } from '../config/Params';
import type { RsyslogMessage } from '../Message';
import type { Template } from '../Template';
import type { RsyslogHost } from './Host';
import type { AllowedSenderList } from './AllowedSenders';
import type { LocalClock } from './LocalClock';
import type { RateLimiter } from './RateLimiter';
import type { ResolvedSender } from './SenderResolver';
import type { GlobalSettings } from './Settings';
import type { Statistics } from './Statistics';

export type ActionOutcome = 'ok' | 'suspended' | 'discard' | 'fail' | 'disable' | 'defer';

export interface TemplateRequest {
  readonly name: string;
  readonly dynamicFileName?: boolean;
  readonly asMessage?: boolean;
  readonly asJson?: boolean;
  readonly requireSql?: boolean;
}

export interface ActionArguments {
  readonly strings: string[];
  readonly json: unknown[];
}

export interface ActionWorker {
  doAction(args: ActionArguments, message: RsyslogMessage): ActionOutcome;
  tryResume?(): ActionOutcome;
  beginTransaction?(): void;
  endTransaction?(): ActionOutcome;
  pauseAfterAction?(): number;
  close(): void;
}

export interface ActionModuleInstance {
  readonly moduleName: string;
  readonly templates: TemplateRequest[];
  readonly description: string;
  createWorker(): ActionWorker;
  hup?(): void;
  teardown?(): void;
}

export interface RuntimeLog {
  error(text: string, code?: number, errno?: Errno): void;
  warning(text: string, code?: number): void;
  info(text: string, code?: number): void;
  log(severity: number, code: number, text: string, errno?: Errno): void;
  internal(severity: number, code: number, text: string, mark?: boolean, facility?: number): void;
}

export interface ModuleRateLimitSpec {
  readonly module: string;
  readonly interval: number;
  readonly burst: number;
  readonly forInput?: boolean;
  readonly dynamicName?: string;
  readonly severity?: number;
}

export type ModuleRateLimiter = RateLimiter;

export interface ModuleContext {
  readonly host: RsyslogHost;
  readonly runtime: RuntimeLog;
  readonly settings: GlobalSettings;
  readonly statistics: Statistics;
  template(name: string): Template | undefined;
  report(message: string): void;
  warn(message: string): void;
  loaded(moduleName: string): boolean;
  rateLimiter(spec: ModuleRateLimitSpec): { readonly limiter: ModuleRateLimiter | null } | null;
  moduleState<T>(moduleName: string, create: () => T): T;
  netstreamDriverAvailable(driver: string): boolean;
  moduleDirectory(): string;
  moduleFileAvailable(fileName: string): boolean;
  outchannel(name: string): OutChannel | undefined;
}

export interface OutChannel {
  readonly name: string;
  readonly fileTemplate: string | null;
  readonly sizeLimit: number;
  readonly sizeLimitCommand: string | null;
}

export interface DirectiveRegistration {
  readonly name: string;
  readonly type: 'binary' | 'int' | 'nonneg' | 'positive' | 'size' | 'word' | 'char' | 'facility' | 'severity' | 'uid' | 'gid' | 'filemode' | 'goneaway' | 'custom';
  readonly apply: (value: string | number, context: InputContext) => void;
  readonly custom?: (rest: string, context: InputContext) => string | null;
}

export type SelectorParse =
  | { readonly status: 'ok'; readonly instance: ActionModuleInstance; readonly rest: string; readonly warning?: string }
  | { readonly status: 'unprocessed' }
  | { readonly status: 'error' };

export interface OutputModule {
  readonly kind: 'output';
  readonly name: string;
  readonly builtin: boolean;
  parseSelector?(line: string, context: ModuleContext): SelectorParse;
  newActionInstance(params: NvList, context: ModuleContext): ActionModuleInstance | null;
  directives?(): DirectiveRegistration[];
  moduleParams?: readonly ParamDescriptor[];
  setModuleConfig?(params: NvList, context: ModuleContext): boolean;
  reset?(context: ModuleContext): void;
}

export interface InputInstance {
  readonly bindsBeforePrivilegeDrop?: boolean;
  check?(): void;
  start(): boolean;
  stop(): void;
  hup?(): void;
  readonly description: string;
}

export interface InputSubmitter {
  submit(info: InputSubmission): void;
}

export interface PreparsedFields {
  readonly priority: number | null;
  readonly offsetAfterPriority: number;
  readonly tag: string;
  readonly msg: string;
  readonly timestamp: SyslogTime | null;
  readonly parseHostname: boolean;
}

export interface InputSubmission {
  readonly raw: string;
  readonly bytes?: Uint8Array;
  readonly noLegacyZDecompress?: boolean;
  readonly inputName: string;
  readonly fromHost: string | null;
  readonly fromHostIp: string | null;
  readonly fromHostPort: string | null;
  readonly ruleset: string | null;
  readonly parseHostname?: boolean;
  readonly ignoreDate?: boolean;
  readonly noPriInRaw?: boolean;
  readonly internal?: boolean;
  readonly pid?: number | null;
  readonly uid?: number | null;
  readonly gid?: number | null;
  readonly programName?: string | null;
  readonly limiter?: RateLimiter;
  readonly sender?: { readonly ip: string; readonly port: number };
  readonly preserveCase?: boolean;
  readonly pendingAcl?: AllowedSenderList;
  readonly defaultTimeZone?: string | null;
  readonly preparsed?: PreparsedFields;
  readonly localOrigin?: boolean;
  readonly mark?: boolean;
  readonly receivedAtMs?: number;
  readonly cee?: { readonly [key: string]: import('../Message').JsonValue };
}

export interface InputContext extends ModuleContext {
  readonly submitter: InputSubmitter;
  allowedSenders(entries: string[], source: string): AllowedSenderList | null;
  resolveSender(ip: string): ResolvedSender;
  readonly clock: LocalClock;
  rulesetExists(name: string): boolean;
  instanceId(): number;
  registerInput(moduleName: string, instance: InputInstance): void;
}

export interface InputModule {
  readonly kind: 'input';
  readonly name: string;
  readonly builtin: boolean;
  newInstances(params: NvList, context: InputContext): InputInstance[] | null;
  setModuleConfig?(params: NvList, context: ModuleContext): boolean;
  directives?(): DirectiveRegistration[];
  reset?(context: ModuleContext): void;
  check?(instanceCount: number, context: ModuleContext): void;
  implicitInstances?(context: InputContext): InputInstance[];
}

export interface ParserModuleDefinition {
  readonly kind: 'parser';
  readonly name: string;
  readonly cnfName: string;
  readonly builtin: boolean;
}

export type EngineModule = OutputModule | InputModule | ParserModuleDefinition;
