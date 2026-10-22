import type { Errno } from '@/network/core/Errno';
import { decodeSeverityName } from '../config/Filters';
import { RS_RET } from './Log';
import { yamlEvents, type YamlEvent } from './YamlEvents';

export type RateLimitScope = 'input' | 'output';
export type OutputMode = 'drop' | 'pace';

export interface PerSourceOverride {
  key: string;
  max: number;
  window: number;
  hasMax: boolean;
  hasWindow: boolean;
}

export interface PerSourcePolicy {
  defaultMax: number;
  defaultWindow: number;
  readonly overrides: Map<string, PerSourceOverride>;
}

export interface PolicyFile {
  hasScope: boolean;
  scope: RateLimitScope;
  hasOutputMode: boolean;
  outputMode: OutputMode;
  hasInterval: boolean;
  interval: number;
  hasBurst: boolean;
  burst: number;
  hasSeverity: boolean;
  severity: number;
  hasPerSource: boolean;
  perSourceEnabled: boolean;
  keyTemplateName: string | null;
  maxStates: number;
  topN: number;
  perSource: PerSourcePolicy | null;
}

export interface PolicyLog {
  error(text: string, code: number, errno?: Errno): void;
}

export interface PolicyFiles {
  read(path: string): string | null;
  exists(path: string): boolean;
}

const UINT_MAX = 4294967295;
const MAX_NESTING = 8;
const MAX_OVERRIDES = 10000;

export function parseUnsignedInt(value: string): number | null {
  const match = /^\s*\+?(\d+)$/.exec(value);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return parsed > UINT_MAX ? null : parsed;
}

export function parseDurationMillis(value: string): number | null {
  const match = /^\s*(\d+)\s*(ms|s|m|h)?$/.exec(value);
  if (match === null) return null;
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 1000;
  const total = Number(match[1]) * multiplier;
  return total > UINT_MAX ? null : total;
}

function parseDurationSeconds(value: string): number | null {
  const millis = parseDurationMillis(value);
  return millis === null || millis % 1000 !== 0 ? null : millis / 1000;
}

function parseBoolean(value: string): boolean | null {
  const lowered = value.toLowerCase();
  if (['on', 'yes', 'true', '1'].includes(lowered)) return true;
  if (['off', 'no', 'false', '0'].includes(lowered)) return false;
  return null;
}

function parseSeverity(value: string): number | null {
  const trimmed = value.trimStart();
  if (trimmed.startsWith('-') || /^\d/.test(trimmed)) {
    if (!/^-?\d+$/.test(trimmed)) return null;
    const numeric = Number(trimmed);
    return numeric < -1 || numeric > 127 ? null : numeric;
  }
  const severity = decodeSeverityName(trimmed);
  return severity < 0 || severity > 127 ? null : severity;
}

export function emptyPolicyFile(): PolicyFile {
  return {
    hasScope: false, scope: 'input', hasOutputMode: false, outputMode: 'drop', hasInterval: false, interval: 0, hasBurst: false, burst: 0,
    hasSeverity: false, severity: 0, hasPerSource: false, perSourceEnabled: false, keyTemplateName: null, maxStates: 0, topN: 0, perSource: null,
  };
}

type Context = 'top' | 'perSource' | 'default' | 'override';

interface OverrideDraft {
  key: string | null;
  max: number;
  window: number;
  hasMax: boolean;
  hasWindow: boolean;
}

class Abort extends Error {
  constructor(readonly code: number) {
    super('abort');
  }
}

interface Reader {
  readonly path: string;
  readonly legacy: boolean;
  readonly log: PolicyLog;
}

class PolicyWalker {
  readonly policy = emptyPolicyFile();
  private depth = 0;
  private readonly contexts: Context[] = [];
  private readonly expectKey: boolean[] = [];
  private lastKey: string | null = null;
  private inOverrides = false;
  private defaultMaxSeen = false;
  private defaultWindowSeen = false;
  private overrideCount = 0;
  private current: OverrideDraft | null = null;
  private legacyPolicy: PerSourcePolicy | null = null;

  constructor(private readonly reader: Reader) {
    if (reader.legacy) this.legacyPolicy = { defaultMax: 0, defaultWindow: 0, overrides: new Map() };
  }

  private fail(text: string, code: number = RS_RET.CONF_PARAM_INVLD): never {
    this.reader.log.error(text, code);
    throw new Abort(code);
  }

  private invalid(what: string, value: string): never {
    return this.fail(`ratelimit: invalid ${what} value '${value}' in ${this.reader.path}`);
  }

  private perSourcePolicy(): PerSourcePolicy {
    return (this.reader.legacy ? this.legacyPolicy : this.policy.perSource) as PerSourcePolicy;
  }

  get legacyResult(): PerSourcePolicy | null {
    return this.legacyPolicy;
  }

  walk(events: readonly YamlEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'mapping-start': this.mappingStart(); break;
        case 'mapping-end': this.mappingEnd(); break;
        case 'sequence-start': this.sequenceStart(); break;
        case 'sequence-end': this.inOverrides = false; this.lastKey = null; break;
        case 'scalar': this.scalar(event.value); break;
      }
    }
  }

  finish(): void {
    const { legacy, path } = this.reader;
    if (legacy) {
      if (!this.defaultMaxSeen || !this.defaultWindowSeen) {
        this.fail(`ratelimit: per-source policy file ${path} missing default.max or default.window`);
      }
      return;
    }
    if (this.policy.hasPerSource && this.policy.perSourceEnabled && (!this.defaultMaxSeen || !this.defaultWindowSeen)) {
      this.fail(`ratelimit: policy file ${path} perSource section missing default.max or default.window`);
    }
  }

  private mappingStart(): void {
    const { legacy, path } = this.reader;
    if (this.depth >= MAX_NESTING) this.fail(`ratelimit: yaml nesting too deep in ${path}`);
    if (this.depth === 0) this.contexts[this.depth] = 'top';
    else if (this.inOverrides) {
      if (this.overrideCount >= MAX_OVERRIDES) {
        this.fail(legacy ? `ratelimit: too many overrides in ${path} (max ${MAX_OVERRIDES})` : `ratelimit: too many per-source overrides in ${path} (max ${MAX_OVERRIDES})`);
      }
      this.contexts[this.depth] = 'override';
      this.current = { key: null, max: 0, window: 0, hasMax: false, hasWindow: false };
      this.overrideCount++;
    } else if (!legacy && this.lastKey === 'perSource') {
      this.contexts[this.depth] = 'perSource';
      this.policy.hasPerSource = true;
      this.policy.perSourceEnabled = true;
      this.policy.perSource = { defaultMax: 0, defaultWindow: 0, overrides: new Map() };
    } else if (legacy && this.lastKey === 'default') this.contexts[this.depth] = 'default';
    else if (!legacy && this.depth > 0 && this.contexts[this.depth - 1] === 'perSource' && this.lastKey === 'default') this.contexts[this.depth] = 'default';
    else this.contexts[this.depth] = 'top';
    if (this.depth > 0 && this.lastKey !== null) this.expectKey[this.depth - 1] = true;
    this.expectKey[this.depth] = true;
    this.depth++;
    this.lastKey = null;
  }

  private mappingEnd(): void {
    if (this.depth > 0) {
      this.depth--;
      if (this.contexts[this.depth] === 'override' && this.current !== null) {
        if (this.current.key === null) this.fail(`ratelimit: per-source override missing key in ${this.reader.path}`);
        this.perSourcePolicy().overrides.set(this.current.key, { ...this.current, key: this.current.key });
        this.current = null;
      }
    }
    this.lastKey = null;
  }

  private sequenceStart(): void {
    const owner = this.reader.legacy ? true : this.depth > 0 && this.contexts[this.depth - 1] === 'perSource';
    if (owner && this.lastKey === 'overrides') this.inOverrides = true;
    if (this.depth > 0 && this.lastKey !== null) this.expectKey[this.depth - 1] = true;
    this.lastKey = null;
  }

  private scalar(value: string): void {
    if (this.depth === 0) return;
    if (this.expectKey[this.depth - 1]) {
      this.lastKey = value;
      this.expectKey[this.depth - 1] = false;
      return;
    }
    const context = this.contexts[this.depth - 1];
    const key = this.lastKey;
    if (this.reader.legacy) this.legacyValue(context, key, value);
    else this.policyValue(context, key, value);
    this.expectKey[this.depth - 1] = true;
  }

  private policyValue(context: Context, key: string | null, value: string): void {
    const { path } = this.reader;
    const policy = this.policy;
    if (context === 'top') {
      if (key === 'scope') {
        const lowered = value.toLowerCase();
        if (lowered !== 'input' && lowered !== 'output') this.fail(`ratelimit: invalid scope value '${value}' in ${path}`);
        policy.scope = lowered;
        policy.hasScope = true;
      } else if (key === 'mode') {
        const lowered = value.toLowerCase();
        if (lowered !== 'drop' && lowered !== 'pace') this.fail(`ratelimit: invalid mode value '${value}' in ${path}`);
        policy.outputMode = lowered;
        policy.hasOutputMode = true;
      } else if (key === 'interval') {
        const parsed = parseUnsignedInt(value);
        if (parsed === null) this.invalid('interval', value);
        policy.interval = parsed;
        policy.hasInterval = true;
      } else if (key === 'burst') {
        const parsed = parseUnsignedInt(value);
        if (parsed === null) this.invalid('burst', value);
        policy.burst = parsed;
        policy.hasBurst = true;
      } else if (key === 'severity') {
        const parsed = parseSeverity(value);
        if (parsed === null) this.invalid('severity', value);
        policy.severity = parsed;
        policy.hasSeverity = true;
      }
    } else if (context === 'perSource') {
      if (key === 'enabled') {
        const parsed = parseBoolean(value);
        if (parsed === null) this.invalid('perSource.enabled', value);
        policy.perSourceEnabled = parsed;
      } else if (key === 'keyTemplate') policy.keyTemplateName = value;
      else if (key === 'maxStates') {
        const parsed = parseUnsignedInt(value);
        if (parsed === null) this.invalid('perSource.maxStates', value);
        policy.maxStates = parsed;
      } else if (key === 'topN') {
        const parsed = parseUnsignedInt(value);
        if (parsed === null) this.invalid('perSource.topN', value);
        policy.topN = parsed;
      }
    } else if (context === 'default' && policy.perSource !== null) this.defaultValue('perSource.default', key, value);
    else if (context === 'override' && this.current !== null) this.overrideValue('perSource override', key, value);
  }

  private legacyValue(context: Context, key: string | null, value: string): void {
    if (context === 'default') this.defaultValue('default', key, value);
    else if (context === 'override' && this.current !== null) this.overrideValue('override', key, value);
  }

  private defaultValue(label: string, key: string | null, value: string): void {
    const target = this.perSourcePolicy();
    if (key === 'max') {
      const parsed = parseUnsignedInt(value);
      if (parsed === null) this.invalid(`${label}.max`, value);
      target.defaultMax = parsed;
      this.defaultMaxSeen = true;
    } else if (key === 'window') {
      const parsed = parseDurationSeconds(value);
      if (parsed === null) this.invalid(`${label}.window`, value);
      target.defaultWindow = parsed;
      this.defaultWindowSeen = true;
    }
  }

  private overrideValue(label: string, key: string | null, value: string): void {
    const current = this.current as OverrideDraft;
    if (key === 'key') current.key = value;
    else if (key === 'max') {
      const parsed = parseUnsignedInt(value);
      if (parsed === null) this.invalid(`${label}.max`, value);
      current.max = parsed;
      current.hasMax = true;
    } else if (key === 'window') {
      const parsed = parseDurationSeconds(value);
      if (parsed === null) this.invalid(`${label}.window`, value);
      current.window = parsed;
      current.hasWindow = true;
    }
  }
}

function readEvents(files: PolicyFiles, path: string, log: PolicyLog, openFailure: string): { events: YamlEvent[]; problem: string | null } | null {
  const text = files.exists(path) ? files.read(path) : null;
  if (text === null) {
    log.error(`${openFailure} ${path}`, RS_RET.FILE_NOT_FOUND, 'ENOENT');
    return null;
  }
  return yamlEvents(text);
}

function walkAll(walker: PolicyWalker, parse: { events: YamlEvent[]; problem: string | null }, reader: Reader): number {
  try {
    walker.walk(parse.events);
    if (parse.problem !== null) {
      reader.log.error(`ratelimit: yaml parser error in policy file ${reader.path}: ${parse.problem}`, RS_RET.CONF_PARAM_INVLD);
      return RS_RET.CONF_PARAM_INVLD;
    }
    walker.finish();
    return 0;
  } catch (error) {
    if (error instanceof Abort) return error.code;
    throw error;
  }
}

export function parsePolicyFile(files: PolicyFiles, path: string, log: PolicyLog): PolicyFile | null {
  const parse = readEvents(files, path, log, 'ratelimit: error opening policy file');
  if (parse === null) return null;
  const reader: Reader = { path, legacy: false, log };
  const walker = new PolicyWalker(reader);
  return walkAll(walker, parse, reader) === 0 ? walker.policy : null;
}

export function parsePerSourcePolicyFile(files: PolicyFiles, path: string, log: PolicyLog): PerSourcePolicy | null {
  const parse = readEvents(files, path, log, 'ratelimit: error opening per-source policy file');
  if (parse === null) return null;
  const reader: Reader = { path, legacy: true, log };
  const walker = new PolicyWalker(reader);
  return walkAll(walker, parse, reader) === 0 ? walker.legacyResult : null;
}
