import type { Stmt } from '../config/Ast';
import type { MessageParserModule } from '../MessageParser';
import type { Template } from '../Template';
import type { ActionModuleInstance, EngineModule, InputInstance, OutChannel, RuntimeLog, TemplateRequest } from './Modules';
import type { LocalClock } from './LocalClock';
import type { SenderResolver } from './SenderResolver';
import type { LookupRef } from './LookupTable';
import type { GlobalSettings, QueueSettings } from './Settings';

export interface ActionOptions {
  name: string | null;
  resumeInterval: number;
  resumeIntervalMax: number;
  resumeRetryCount: number;
  writeAllMarkMessages: boolean;
  execOnlyWhenPreviousIsSuspended: boolean;
  execOnlyOnceEveryInterval: number;
  execOnlyEveryNthTime: number;
  execOnlyEveryNthTimeTimeout: number;
  repeatedMessageContainsOriginalMessage: boolean;
  reportSuspension: boolean;
  reportSuspensionContinuation: boolean;
  copyMessage: boolean;
  errorFile: string | null;
  errorFileMaxSize: number;
  externalStateFile: string | null;
  rateLimitName: string | null;
  queue: QueueSettings;
}

export interface ActionTemplateBinding {
  readonly request: TemplateRequest;
  readonly template: Template | null;
}

export interface ActionDefinition {
  readonly id: number;
  readonly instance: ActionModuleInstance;
  readonly moduleDisplayName: string;
  readonly templates: ActionTemplateBinding[];
  readonly options: ActionOptions;
}

export interface RulesetDefinition {
  readonly name: string;
  statements: Stmt[];
  parserNames: string[] | null;
  queue: QueueSettings | null;
}

export interface RateLimitDefinition {
  readonly name: string;
  readonly interval: number;
  readonly burst: number;
  readonly severity: number;
}

export interface InputRecord {
  readonly module: string;
  readonly instance: InputInstance;
}

export interface LoadedConfig {
  readonly settings: GlobalSettings;
  readonly templates: Map<string, Template>;
  readonly rulesets: Map<string, RulesetDefinition>;
  readonly modules: Map<string, EngineModule>;
  readonly inputs: InputRecord[];
  readonly outchannels: OutChannel[];
  readonly actions: ActionDefinition[];
  readonly parsers: Map<string, MessageParserModule>;
  readonly rateLimits: Map<string, RateLimitDefinition>;
  readonly lookupTables: LookupRef[];
  readonly timezones: Map<string, { offsetMinutes: number }>;
  readonly senderResolver: SenderResolver;
  readonly localClock: LocalClock;
  hadErrors: boolean;
  inputDeclarationFailed: boolean;
  bindRuntime(sink: RuntimeLog): void;
}
