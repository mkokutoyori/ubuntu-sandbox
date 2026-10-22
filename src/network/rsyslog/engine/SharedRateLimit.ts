import type { Errno } from '@/network/core/Errno';
import type { RsyslogMessage } from '../Message';
import type { Template } from '../Template';
import { RsyslogHashTable } from './HashTable';
import { RS_RET } from './Log';
import type { RuntimeLog } from './Modules';
import { PerSourceLimits } from './PerSourceRateLimit';
import {
  emptyPolicyFile, parseDurationMillis, parsePerSourcePolicyFile, parsePolicyFile, type OutputMode, type PerSourcePolicy, type PolicyFile,
  type PolicyFiles, type RateLimitScope,
} from './RateLimitPolicy';
import type { Statistics } from './Statistics';

const CONFIG_SHARDS = 32;
const CONFIG_HASH_SIZE = 16;
const DEFAULT_DEBOUNCE_MS = 5000;

export interface RateLimitFiles extends PolicyFiles {
  watch?(path: string, onEvent: () => void): (() => void) | null;
}

export interface RateLimitServices {
  readonly runtime: () => RuntimeLog;
  readonly files: RateLimitFiles;
  readonly statistics: Statistics;
  readonly template: (name: string) => Template | undefined;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly nowMs: () => number;
}

export interface RateLimitParams {
  readonly name: string;
  readonly interval: number;
  readonly burst: number;
  readonly severity: number;
  readonly policyFile: string | null;
  readonly policyWatch: boolean;
  readonly policyWatchDebounce: string | null;
  readonly perSource: boolean;
  readonly perSourcePolicyFile: string | null;
  readonly perSourceKeyTemplate: string | null;
  readonly perSourceMaxStates: number;
  readonly perSourceTopN: number;
  readonly hasInlinePolicyParams: boolean;
  readonly hasLegacyPerSourceParams: boolean;
}

type WatchKind = 'policy' | 'per-source policy';

const BUILTIN_KEY_TEMPLATE = 'RSYSLOG_PerSourceKey';

export class SharedRateLimit {
  scope: RateLimitScope = 'input';
  outputMode: OutputMode = 'drop';
  interval = 0;
  burst = 10000;
  severity = -1;
  policyFile: string | null = null;
  policyWatch = false;
  debounceMs = DEFAULT_DEBOUNCE_MS;
  outputPaceForbidden = false;
  readonly perSource: PerSourceLimits;
  private readonly watchers: Array<() => void> = [];

  constructor(readonly name: string, private readonly services: RateLimitServices) {
    this.perSource = new PerSourceLimits(name, services.statistics);
  }

  private get log(): RuntimeLog {
    return this.services.runtime();
  }

  get perSourceFromPolicy(): boolean {
    return this.perSource.fromPolicyFile;
  }

  lookupKeyTemplate(name: string | null): { template: Template; isDefault: boolean } | null {
    const template = this.services.template(name ?? BUILTIN_KEY_TEMPLATE);
    return template === undefined ? null : { template, isDefault: name === null };
  }

  private fail(trigger: string, text: string, code: number): never {
    this.log.error(`ratelimit: ${trigger} reload of ${text}`, code);
    throw new ReloadRejected(code);
  }

  reloadPolicy(trigger: string): number {
    const file = this.policyFile;
    if (file === null) return RS_RET.OK_VALUE;
    let result: number = RS_RET.OK_VALUE;
    try {
      this.applyReloadedPolicy(trigger, file);
      this.log.info(`ratelimit: ${trigger} reloaded policy '${this.name}' from file '${file}'`);
    } catch (error) {
      if (!(error instanceof ReloadRejected)) throw error;
      result = error.code;
      this.log.error(`ratelimit: ${trigger} failed to reload policy '${this.name}' from file '${file}', keeping old values`, result);
    }
    return result;
  }

  private applyReloadedPolicy(trigger: string, file: string): void {
    let { interval, burst, severity } = this;
    let outputMode = this.outputMode;
    const policy = parsePolicyFile(this.services.files, file, { error: (text, code, errno) => this.log.error(text, code, errno) });
    if (policy === null) throw new ReloadRejected(RS_RET.CONF_PARAM_INVLD);
    const scope: RateLimitScope = policy.hasScope ? policy.scope : 'input';
    const where = `policy '${this.name}' from file '${file}'`;
    if (scope !== this.scope) this.fail(trigger, `${where} rejected because scope changed`, RS_RET.CONFIG_ERROR);
    if (this.scope === 'output') {
      const output = `output policy '${this.name}' from file '${file}'`;
      if (!policy.hasOutputMode) this.fail(trigger, `${output} rejected because mode is missing`, RS_RET.CONFIG_ERROR);
      if (!policy.hasInterval || !policy.hasBurst) this.fail(trigger, `${output} rejected because interval or burst is missing`, RS_RET.CONFIG_ERROR);
      if (policy.hasSeverity || policy.hasPerSource) this.fail(trigger, `${output} rejected due to unsupported fields`, RS_RET.CONFIG_ERROR);
      outputMode = policy.outputMode;
    } else if (policy.hasOutputMode) {
      this.fail(trigger, `input policy '${this.name}' from file '${file}' rejected because output mode is set`, RS_RET.CONFIG_ERROR);
    }
    if (policy.hasInterval) interval = policy.interval;
    if (policy.hasBurst) burst = policy.burst;
    if (policy.hasSeverity) severity = policy.severity;
    if (this.scope === 'output' && outputMode === 'pace') {
      const output = `output policy '${this.name}' from file '${file}'`;
      if (burst === 0) this.fail(trigger, `${output} rejected because pace mode requires burst greater than zero`, RS_RET.CONFIG_ERROR);
      if (this.outputPaceForbidden) this.fail(trigger, `${output} rejected because a direct action uses this policy`, RS_RET.CONFIG_ERROR);
    }
    if (policy.hasPerSource) this.applyPerSourceFromPolicy(policy, file);
    else if (this.perSource.fromPolicyFile) this.perSource.enabled = false;
    this.interval = interval;
    this.burst = burst;
    this.severity = severity;
    this.outputMode = outputMode;
  }

  private applyPerSourceFromPolicy(policy: PolicyFile, file: string): void {
    const perSource = this.perSource;
    if (!policy.perSourceEnabled) {
      perSource.enabled = false;
      perSource.fromPolicyFile = true;
      return;
    }
    const key = this.lookupKeyTemplate(policy.keyTemplateName);
    if (key === null) throw new ReloadRejected(RS_RET.CONFIG_ERROR);
    const parsed = policy.perSource as PerSourcePolicy;
    if (!perSource.initialized) perSource.init(parsed, file, policy.maxStates, policy.topN);
    else perSource.swapPolicy(parsed);
    if (perSource.policyFile === null) perSource.policyFile = file;
    perSource.keyTemplateName = policy.keyTemplateName;
    perSource.fromPolicyFile = true;
    perSource.reconfigure(policy.maxStates, policy.topN);
    perSource.publishKeyPolicy(key.template, key.isDefault);
    perSource.enabled = true;
  }

  reloadPerSourcePolicy(trigger: string): number {
    const file = this.perSource.policyFile;
    if (file === null) return RS_RET.OK_VALUE;
    const policy = parsePerSourcePolicyFile(this.services.files, file, { error: (text, code, errno) => this.log.error(text, code, errno) });
    if (policy === null) {
      this.log.error(`ratelimit: ${trigger} failed to reload per-source policy '${this.name}' from file '${file}', keeping old values`, RS_RET.CONF_PARAM_INVLD);
      return RS_RET.CONF_PARAM_INVLD;
    }
    this.perSource.swapPolicy(policy);
    this.log.info(`ratelimit: ${trigger} reloaded per-source policy '${this.name}' from file '${file}'`);
    return RS_RET.OK_VALUE;
  }

  hup(): void {
    if (this.policyFile !== null) this.reloadPolicy('HUP');
    if (this.perSource.policyFile !== null && !this.perSource.fromPolicyFile) this.reloadPerSourcePolicy('HUP');
  }

  registerWatchTargets(): void {
    if (!this.policyWatch) return;
    const perSourceFile = this.perSource.policyFile;
    if (this.policyFile === null && perSourceFile === null) {
      this.log.warning(`ratelimit: policyWatch enabled for '${this.name}' but no policy file is configured; using HUP-only reload`, RS_RET.OK_VALUE);
      return;
    }
    if (this.policyFile !== null) this.watch(this.policyFile, 'policy', () => this.reloadPolicy('policy watch'));
    if (perSourceFile !== null && !this.perSource.fromPolicyFile) this.watch(perSourceFile, 'per-source policy', () => this.reloadPerSourcePolicy('policy watch'));
  }

  private watch(path: string, kind: WatchKind, reload: () => void): void {
    let cancelPending: (() => void) | null = null;
    const onEvent = (): void => {
      cancelPending?.();
      cancelPending = this.services.schedule(() => {
        cancelPending = null;
        reload();
      }, this.debounceMs);
    };
    const detach = this.services.files.watch?.(path, onEvent) ?? null;
    if (detach === null) {
      this.log.warning(
        `ratelimit: policyWatch requested for '${this.name}' but automatic reload unavailable for ${kind} '${path}'; using HUP-only reload`,
        RS_RET.NOT_IMPLEMENTED,
      );
      return;
    }
    this.watchers.push(() => {
      cancelPending?.();
      detach();
    });
  }

  close(): void {
    for (const stop of this.watchers.splice(0)) stop();
  }
}

class ReloadRejected extends Error {
  constructor(readonly code: number) {
    super('rejected');
  }
}

export class RateLimitRegistry {
  private readonly shards: Array<RsyslogHashTable<SharedRateLimit>> = Array.from({ length: CONFIG_SHARDS }, () => new RsyslogHashTable<SharedRateLimit>(CONFIG_HASH_SIZE));
  private renderer: ((template: Template, message: RsyslogMessage) => string) | null = null;

  constructor(private readonly services: RateLimitServices) {}

  bindRenderer(render: (template: Template, message: RsyslogMessage) => string): void {
    this.renderer = render;
  }

  render(template: Template, message: RsyslogMessage): string {
    return this.renderer === null ? '' : this.renderer(template, message);
  }

  private shardOf(name: string): RsyslogHashTable<SharedRateLimit> {
    return this.shards[this.shards[0].hash(name) % CONFIG_SHARDS];
  }

  find(name: string): SharedRateLimit | undefined {
    return this.shardOf(name).search(name);
  }

  hup(): void {
    for (const shard of this.shards) for (const shared of shard.values()) shared.hup();
  }

  close(): void {
    for (const shard of this.shards) for (const shared of shard.values()) shared.close();
  }

  add(params: RateLimitParams): number {
    const log = this.services.runtime();
    const error = (text: string, code: number): number => {
      log.error(text, code);
      return code;
    };
    let debounceMs = DEFAULT_DEBOUNCE_MS;
    if (params.policyWatchDebounce !== null) {
      const parsed = parseDurationMillis(params.policyWatchDebounce);
      if (parsed === null) return RS_RET.CONF_PARAM_INVLD;
      debounceMs = parsed;
    }
    let { interval, burst, severity } = params;
    let perSourceEnabled = params.perSource;
    let perSourceFile = params.perSourcePolicyFile;
    let keyTemplateName = params.perSourceKeyTemplate;
    let maxStates = params.perSourceMaxStates;
    let topN = params.perSourceTopN;
    let perSourcePolicy: PerSourcePolicy | null = null;
    let fromPolicyFile = false;
    let scope: RateLimitScope = 'input';
    let outputMode: OutputMode = 'drop';
    let filePolicy = emptyPolicyFile();
    if (params.policyFile !== null) {
      const parsed = parsePolicyFile(this.services.files, params.policyFile, { error: (text, code, errno: Errno | undefined) => log.error(text, code, errno) });
      if (parsed === null) return RS_RET.CONF_PARAM_INVLD;
      filePolicy = parsed;
      if (filePolicy.hasScope) scope = filePolicy.scope;
      if (filePolicy.hasOutputMode) outputMode = filePolicy.outputMode;
      if (filePolicy.hasInterval) interval = filePolicy.interval;
      if (filePolicy.hasBurst) burst = filePolicy.burst;
      if (filePolicy.hasSeverity) severity = filePolicy.severity;
      if (filePolicy.hasPerSource) {
        if (perSourceEnabled || perSourceFile !== null || keyTemplateName !== null || maxStates !== 0 || topN !== 0) {
          return error(`ratelimit: policy file '${params.policyFile}' contains perSource for '${params.name}'; do not mix it with legacy perSource/perSourcePolicy/perSourceKeyTpl/maxStates/topN parameters`, RS_RET.CONFIG_ERROR);
        }
        fromPolicyFile = true;
        perSourceEnabled = filePolicy.perSourceEnabled;
        if (perSourceEnabled) {
          perSourcePolicy = filePolicy.perSource;
          perSourceFile = params.policyFile;
          keyTemplateName = filePolicy.keyTemplateName;
          maxStates = filePolicy.maxStates;
          topN = filePolicy.topN;
        }
      }
    }
    const name = params.name;
    if (scope === 'output') {
      if (params.policyFile === null) return error(`ratelimit: output policy '${name}' must use a YAML policy file`, RS_RET.CONFIG_ERROR);
      if (params.hasInlinePolicyParams || params.hasLegacyPerSourceParams) {
        return error(`ratelimit: output policy '${name}' must define limits only in the YAML policy file`, RS_RET.CONFIG_ERROR);
      }
      if (!filePolicy.hasOutputMode) return error(`ratelimit: output policy '${name}' must define mode in the YAML policy file`, RS_RET.CONFIG_ERROR);
      if (!filePolicy.hasInterval || !filePolicy.hasBurst) {
        return error(`ratelimit: output policy '${name}' must define interval and burst in the YAML policy file`, RS_RET.CONFIG_ERROR);
      }
      if (filePolicy.hasSeverity || filePolicy.hasPerSource) {
        return error(`ratelimit: output policy '${name}' does not support severity or perSource in this version`, RS_RET.CONFIG_ERROR);
      }
      if (outputMode === 'pace' && burst === 0) {
        return error(`ratelimit: output policy '${name}' pace mode requires burst greater than zero`, RS_RET.CONFIG_ERROR);
      }
    } else if (filePolicy.hasOutputMode) {
      return error(`ratelimit: input policy '${name}' must not define output mode`, RS_RET.CONFIG_ERROR);
    }
    if (perSourceEnabled && perSourcePolicy === null) {
      if (perSourceFile === null) return error(`ratelimit: per-source rate limiting enabled but perSourcePolicy is missing for '${name}'`, RS_RET.CONFIG_ERROR);
      perSourcePolicy = parsePerSourcePolicyFile(this.services.files, perSourceFile, { error: (text, code, errno: Errno | undefined) => log.error(text, code, errno) });
      if (perSourcePolicy === null) return RS_RET.CONF_PARAM_INVLD;
    }
    const shard = this.shardOf(name);
    if (shard.search(name) !== undefined) return error(`ratelimit: duplicate name '${name}' in current config set`, RS_RET.CONFIG_ERROR);
    const shared = new SharedRateLimit(name, this.services);
    shared.scope = scope;
    shared.outputMode = outputMode;
    shared.interval = interval;
    shared.burst = burst;
    shared.severity = severity;
    shared.policyWatch = params.policyWatch;
    shared.debounceMs = debounceMs;
    shared.policyFile = params.policyFile;
    if (perSourceEnabled) {
      const perSource = shared.perSource;
      perSource.init(perSourcePolicy as PerSourcePolicy, perSourceFile as string, maxStates, topN);
      const key = shared.lookupKeyTemplate(keyTemplateName);
      if (key === null) {
        perSource.dispose();
        return error(
          keyTemplateName !== null
            ? `ratelimit: perSourceKeyTpl '${keyTemplateName}' not found for '${name}'`
            : `ratelimit: default perSourceKeyTpl '${BUILTIN_KEY_TEMPLATE}' not found for '${name}'`,
          RS_RET.CONFIG_ERROR,
        );
      }
      perSource.keyTemplateName = keyTemplateName;
      perSource.fromPolicyFile = fromPolicyFile;
      perSource.publishKeyPolicy(key.template, key.isDefault);
      perSource.enabled = true;
    }
    shard.insert(name, shared);
    shared.registerWatchTargets();
    return RS_RET.OK_VALUE;
  }
}
