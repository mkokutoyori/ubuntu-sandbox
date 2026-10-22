import type { Stmt } from '../config/Ast';
import type { DynStatsRegistry } from './DynStats';
import type { PercentileStatsRegistry } from './PercentileStats';
import type { RateLimiter } from './RateLimiter';
import type { RateLimitRegistry, SharedRateLimit } from './SharedRateLimit';
import type { Statistics } from './Statistics';
import type { MessageParserModule } from '../MessageParser';
import type { Template } from '../Template';
import type { ActionModuleInstance, EngineModule, InputInstance, OutChannel, RuntimeLog, TemplateRequest } from './Modules';
import type { LocalClock } from './LocalClock';
import type { SenderResolver } from './SenderResolver';
import type { Janitor } from './Janitor';
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

export interface ActionRateLimit {
  readonly limiter: RateLimiter;
  readonly shared: SharedRateLimit;
}

export interface ActionDefinition {
  readonly id: number;
  readonly instance: ActionModuleInstance;
  readonly moduleDisplayName: string;
  readonly templates: ActionTemplateBinding[];
  readonly options: ActionOptions;
  readonly outputLimiter: ActionRateLimit | null;
}

export interface RulesetDefinition {
  readonly name: string;
  statements: Stmt[];
  parserNames: string[] | null;
  queue: QueueSettings | null;
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
  readonly rateLimits: RateLimitRegistry;
  readonly lookupTables: LookupRef[];
  readonly statistics: Statistics;
  readonly janitor: Janitor;
  readonly dynStats: DynStatsRegistry;
  readonly percentileStats: PercentileStatsRegistry;
  readonly timezones: Map<string, { offsetMinutes: number }>;
  readonly senderResolver: SenderResolver;
  readonly localClock: LocalClock;
  hadErrors: boolean;
  fatalConfigError: string | null;
  inputDeclarationFailed: boolean;
  bindRuntime(sink: RuntimeLog): void;
}
