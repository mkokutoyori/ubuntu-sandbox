import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { IpSlaEngine, SlaOperationRuntime } from '../../../ipsla/IpSlaEngine';
import {
  applyCodecDefaults, applyTypeDefaults, CODEC_PROFILES,
  type SlaCodec, type SlaOperationConfig, type SlaOperationType,
} from '../../../ipsla/types';
import { isReactionElement } from '../../../ipsla/reactions';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import {
  specsFromTrieRegistrations, type AdapterKeyword,
} from '@/cli/commands/trieAdapter';

export type IpSlaSubMode =
  | 'config-ipsla' | 'config-ipsla-http-raw' | 'config'
  | 'config-ipsla-echo' | 'config-ipsla-icmpjitter' | 'config-ipsla-jitter'
  | 'config-ipsla-udp' | 'config-ipsla-tcp' | 'config-ipsla-http'
  | 'config-ipsla-dns' | 'config-ipsla-pathecho';

export interface IpSlaCommandContext {
  r(): Router;
  setMode(mode: IpSlaSubMode): void;
  getSelectedIpSla(): number | null;
  setSelectedIpSla(id: number | null): void;
}

export const IPSLA_TYPE_MODES: Record<SlaOperationType, IpSlaSubMode> = {
  'icmp-echo': 'config-ipsla-echo',
  'icmp-jitter': 'config-ipsla-icmpjitter',
  'udp-jitter': 'config-ipsla-jitter',
  'udp-echo': 'config-ipsla-udp',
  'tcp-connect': 'config-ipsla-tcp',
  'http': 'config-ipsla-http',
  'dns': 'config-ipsla-dns',
  'path-echo': 'config-ipsla-pathecho',
  'unknown': 'config-ipsla',
};

const INVALID_INPUT = '% Invalid input detected at \'^\' marker.';
const INCOMPLETE = '% Incomplete command.';

export const IPSLA_RANGES = {
  frequency: [1, 604800],
  timeout: [0, 604800000],
  threshold: [0, 2147483647],
  requestDataSize: [0, 16384],
  tos: [0, 255],
  numPackets: [1, 60000],
  interval: [1, 60000],
  bucketsKept: [1, 60],
  livesKept: [0, 2],
  distributions: [1, 20],
  distributionInterval: [1, 100],
  hoursKept: [0, 25],
} as const;

function boundedInt(token: string | undefined, range: readonly [number, number]): number | null {
  if (token === undefined || !/^\d+$/.test(token)) return null;
  const value = parseInt(token, 10);
  return value < range[0] || value > range[1] ? null : value;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function engineOf(ctx: IpSlaCommandContext): IpSlaEngine {
  return ctx.r().getIpSlaEngine();
}

function selected(ctx: IpSlaCommandContext): SlaOperationRuntime | undefined {
  const id = ctx.getSelectedIpSla();
  return id === null ? undefined : engineOf(ctx).getOperation(id);
}

function positiveInt(token: string | undefined): number | null {
  if (token === undefined || !/^\d+$/.test(token)) return null;
  return parseInt(token, 10);
}

function findKeywordValue(args: string[], keyword: string): string | undefined {
  const index = args.indexOf(keyword);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseClockToken(token: string | undefined): number | null {
  if (!token) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(token);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function applyTarget(config: SlaOperationConfig, args: string[], type: SlaOperationType): string {
  const target = args[0];
  if (!target) return '% Incomplete command.';
  config.target = target;

  const source = findKeywordValue(args, 'source-interface');
  config.sourceInterface = source ?? null;
  const sourceIp = findKeywordValue(args, 'source-ip');
  config.sourceIp = sourceIp ?? null;
  const sourcePort = positiveInt(findKeywordValue(args, 'source-port'));
  config.sourcePort = sourcePort;

  if (type === 'udp-echo' || type === 'udp-jitter' || type === 'tcp-connect') {
    const explicitPort = positiveInt(args[1]);
    const destPort = positiveInt(findKeywordValue(args, 'dest-port')) ?? explicitPort;
    if (destPort === null) return '% Incomplete command.';
    config.targetPort = destPort;
  }
  if (args.includes('control') && args[args.indexOf('control') + 1] === 'disable') {
    config.controlEnabled = false;
  }
  return '';
}

export function buildIpSlaConfigCommands(
  configTrie: CommandTrie,
  slaTrie: CommandTrie,
  rawTrie: CommandTrie,
  ctx: IpSlaCommandContext,
): void {
  configTrie.registerGreedy('ip sla', 'Configure an IP SLAs operation', (args) => {
    const id = positiveInt(args[0]);
    if (id === null) return '% Incomplete command.';
    engineOf(ctx).ensureOperation(id);
    ctx.setSelectedIpSla(id);
    ctx.setMode('config-ipsla');
    return '';
  });

  configTrie.registerGreedy('no ip sla', 'Remove an IP SLAs operation', (args) => {
    const id = positiveInt(args[0]);
    if (id === null) return '% Incomplete command.';
    engineOf(ctx).removeOperation(id);
    return '';
  });

  configTrie.registerGreedy('ip sla schedule', 'Schedule an IP SLAs operation', (args) => {
    const id = positiveInt(args[0]);
    if (id === null) return '% Incomplete command.';
    const engine = engineOf(ctx);
    const runtime = engine.getOperation(id);
    if (!runtime) return `% IP SLAs entry ${id} does not exist`;
    const schedule = runtime.config.schedule;
    schedule.startPending = false;
    schedule.startAfterSeconds = null;
    schedule.startAtSecondsOfDay = null;

    for (let i = 1; i < args.length; i++) {
      const token = args[i];
      if (token === 'life') {
        const next = args[i + 1];
        if (next === 'forever') schedule.lifeSeconds = 'forever';
        else {
          const seconds = positiveInt(next);
          if (seconds === null) return '% Invalid life value';
          schedule.lifeSeconds = seconds;
        }
        i++;
      } else if (token === 'ageout') {
        const seconds = positiveInt(args[i + 1]);
        if (seconds === null) return '% Invalid ageout value';
        schedule.ageoutSeconds = seconds;
        i++;
      } else if (token === 'recurring') {
        schedule.recurring = true;
      } else if (token === 'start-time') {
        const next = args[i + 1];
        if (next === 'now') { i++; }
        else if (next === 'pending') { schedule.startPending = true; i++; }
        else if (next === 'after') {
          const offset = parseClockToken(args[i + 2]);
          if (offset === null) return '% Invalid start-time';
          schedule.startAfterSeconds = offset;
          i += 2;
        } else {
          const atSeconds = parseClockToken(next);
          if (atSeconds === null) return '% Invalid start-time';
          schedule.startAtSecondsOfDay = atSeconds;
          i++;
        }
      }
    }
    const result = engine.schedule(id);
    return result.ok ? '' : (result.error ?? '% Schedule refused');
  }, [
    { keyword: 'after', description: 'Start the operation after a delay' },
    { keyword: 'ageout', description: 'How long to keep the operation when it is inactive' },
    { keyword: 'forever', description: 'Run the operation without a time limit' },
    { keyword: 'life', description: 'How long the operation runs' },
    { keyword: 'now', description: 'Start the operation immediately' },
    { keyword: 'pending', description: 'Leave the operation pending' },
    { keyword: 'recurring', description: 'Restart the operation every day' },
    { keyword: 'start-time', description: 'When the operation starts' },
  ]);

  configTrie.registerGreedy('no ip sla schedule', 'Unschedule an IP SLAs operation', (args) => {
    const id = positiveInt(args[0]);
    if (id !== null) engineOf(ctx).unschedule(id);
    return '';
  });

  configTrie.registerGreedy('ip sla group schedule', 'Schedule a group of operations', (args) => {
    const groupName = args[0];
    const list = args[1];
    if (!groupName || !list) return '% Incomplete command.';
    const engine = engineOf(ctx);
    const ids = expandOperationList(list);
    if (ids.length === 0) return '% Invalid operation list';
    for (const id of ids) {
      const runtime = engine.getOperation(id);
      if (!runtime) return `% IP SLAs entry ${id} does not exist`;
      runtime.config.schedule.groupName = groupName;
    }
    for (let i = 2; i < args.length; i++) {
      if (args[i] === 'life') {
        const next = args[i + 1];
        for (const id of ids) {
          const runtime = engine.getOperation(id)!;
          runtime.config.schedule.lifeSeconds = next === 'forever'
            ? 'forever'
            : (positiveInt(next) ?? runtime.config.schedule.lifeSeconds);
        }
        i++;
      } else if (args[i] === 'ageout') {
        const seconds = positiveInt(args[i + 1]) ?? 0;
        for (const id of ids) engine.getOperation(id)!.config.schedule.ageoutSeconds = seconds;
        i++;
      }
    }
    for (const id of ids) {
      const result = engine.schedule(id);
      if (!result.ok) return result.error ?? '% Schedule refused';
    }
    return '';
  }, [
    { keyword: 'ageout', description: 'How long to keep the operations when they are inactive' },
    { keyword: 'forever', description: 'Run the operations without a time limit' },
    { keyword: 'life', description: 'How long the operations run' },
    { keyword: 'schedule-period', description: 'Period over which the operations are spread' },
    { keyword: 'start-time', description: 'When the operations start' },
  ]);

  configTrie.registerGreedy('ip sla restart', 'Restart an IP SLAs operation', (args) => {
    const id = positiveInt(args[0]);
    if (id === null) return '% Incomplete command.';
    return engineOf(ctx).restart(id) ? '' : `% IP SLAs entry ${id} is not scheduled`;
  });

  configTrie.registerGreedy('ip sla enable reaction-alerts',
    'Enable IP SLAs reaction alerts', () => {
      engineOf(ctx).globalEnabled = true;
      return '';
    });
  configTrie.registerGreedy('no ip sla enable reaction-alerts',
    'Disable IP SLAs reaction alerts', () => {
      engineOf(ctx).globalEnabled = false;
      return '';
    });
  configTrie.registerGreedy('ip sla logging traps', 'Enable IP SLAs syslog traps', () => {
    engineOf(ctx).loggingTrapsEnabled = true;
    return '';
  });
  configTrie.registerGreedy('no ip sla logging traps', 'Disable IP SLAs syslog traps', () => {
    engineOf(ctx).loggingTrapsEnabled = false;
    return '';
  });

  registerResponderCommands(configTrie, ctx);
  registerReactionCommands(configTrie, ctx);
  registerOperationTypes(slaTrie, ctx);
  void rawTrie;
}

function registerReactionCommands(configTrie: CommandTrie, ctx: IpSlaCommandContext): void {
  configTrie.registerGreedy('ip sla reaction-configuration', 'Configure an IP SLAs reaction', (args) => {
    const operationId = positiveInt(args[0]);
    if (operationId === null) return '% Incomplete command.';
    const engine = engineOf(ctx);
    if (!engine.getOperation(operationId)) return `% IP SLAs entry ${operationId} does not exist`;

    const reactIndex = args.indexOf('react');
    const elementName = reactIndex >= 0 ? args[reactIndex + 1] : undefined;
    if (!elementName) return '% Incomplete command.';
    if (!isReactionElement(elementName)) {
      return '% Invalid input detected at \'^\' marker.';
    }
    const reaction = engine.ensureReaction(operationId, elementName);

    for (let i = 1; i < args.length; i++) {
      const token = args[i];
      if (token === 'threshold-type') {
        const kind = args[i + 1];
        if (kind === 'never' || kind === 'immediate') {
          reaction.thresholdType = kind;
          i++;
        } else if (kind === 'consecutive') {
          const count = positiveInt(args[i + 2]);
          if (count === null) return '% Incomplete command.';
          reaction.thresholdType = 'consecutive';
          reaction.consecutiveCount = count;
          i += 2;
        } else if (kind === 'xOfy') {
          const x = positiveInt(args[i + 2]);
          const y = positiveInt(args[i + 3]);
          if (x === null || y === null) return '% Incomplete command.';
          if (x > y) return '% X must not exceed Y';
          reaction.thresholdType = 'xOfy';
          reaction.xOfyX = x;
          reaction.xOfyY = y;
          i += 3;
        } else if (kind === 'average') {
          const count = positiveInt(args[i + 2]);
          if (count === null) return '% Incomplete command.';
          reaction.thresholdType = 'average';
          reaction.averageCount = count;
          i += 2;
        } else {
          return '% Invalid input detected at \'^\' marker.';
        }
      } else if (token === 'threshold-value') {
        const upper = positiveInt(args[i + 1]);
        const lower = positiveInt(args[i + 2]);
        if (upper === null || lower === null) return '% Incomplete command.';
        reaction.thresholdUpper = upper;
        reaction.thresholdLower = lower;
        i += 2;
      } else if (token === 'action-type') {
        const action = args[i + 1];
        if (action !== 'none' && action !== 'trapOnly'
          && action !== 'triggerOnly' && action !== 'trapAndTrigger') {
          return '% Invalid input detected at \'^\' marker.';
        }
        reaction.actionType = action;
        i++;
      }
    }
    return '';
  }, [
    { keyword: 'react', description: 'Element the reaction watches' },
    { keyword: 'threshold-type', description: 'How the threshold is evaluated' },
    { keyword: 'threshold-value', description: 'Rising and falling threshold values' },
    { keyword: 'action-type', description: 'Action to take when the threshold is violated' },
  ]);

  configTrie.registerGreedy('no ip sla reaction-configuration', 'Remove an IP SLAs reaction', (args) => {
    const operationId = positiveInt(args[0]);
    if (operationId === null) return '% Incomplete command.';
    const reactIndex = args.indexOf('react');
    const elementName = reactIndex >= 0 ? args[reactIndex + 1] : undefined;
    if (elementName === undefined) {
      engineOf(ctx).removeReaction(operationId);
      return '';
    }
    if (!isReactionElement(elementName)) {
      return '% Invalid input detected at \'^\' marker.';
    }
    engineOf(ctx).removeReaction(operationId, elementName);
    return '';
  });

  configTrie.registerGreedy('ip sla reaction-trigger', 'Trigger another operation on reaction', (args) => {
    const source = positiveInt(args[0]);
    const target = positiveInt(args[1]);
    if (source === null || target === null) return '% Incomplete command.';
    const engine = engineOf(ctx);
    if (!engine.getOperation(source)) return `% IP SLAs entry ${source} does not exist`;
    const targetRuntime = engine.getOperation(target);
    if (!targetRuntime) return `% IP SLAs entry ${target} does not exist`;
    if (!targetRuntime.config.schedule.startPending) {
      return `% IP SLAs entry ${target} must be scheduled with start-time pending`;
    }
    return engine.setReactionTrigger(source, target) ? '' : '% Trigger refused';
  });

  configTrie.registerGreedy('no ip sla reaction-trigger', 'Remove a reaction trigger', (args) => {
    const source = positiveInt(args[0]);
    if (source !== null) engineOf(ctx).removeReactionTrigger(source);
    return '';
  });
}

function registerResponderCommands(configTrie: CommandTrie, ctx: IpSlaCommandContext): void {
  configTrie.registerGreedy('ip sla responder', 'Enable the IP SLAs Responder', (args) => {
    const responder = engineOf(ctx).getResponder();
    if (args.length === 0) {
      responder.setEnabled(true);
      return '';
    }
    const protocol = args[0];
    if (protocol !== 'udp-echo' && protocol !== 'tcp-connect') {
      return '% Invalid input detected at \'^\' marker.';
    }
    const port = positiveInt(findKeywordValue(args, 'port'));
    if (port === null) return '% Incomplete command.';
    const address = findKeywordValue(args, 'ipaddress') ?? null;
    responder.setEnabled(true);
    responder.openPermanentPort(protocol, port, address);
    return '';
  }, [
    { keyword: 'udp-echo', description: 'Open a permanent UDP echo port' },
    { keyword: 'tcp-connect', description: 'Open a permanent TCP connect port' },
  ]);

  configTrie.registerGreedy('no ip sla responder', 'Disable the IP SLAs Responder', (args) => {
    const responder = engineOf(ctx).getResponder();
    if (args.length === 0) {
      responder.setEnabled(false);
      return '';
    }
    const port = positiveInt(findKeywordValue(args, 'port'));
    if (port !== null) responder.closePermanentPort(port);
    return '';
  });

  configTrie.registerGreedy('ip sla key-chain', 'Authentication key-chain for the control protocol', (args) => {
    const chain = args[0];
    if (!chain) return '% Incomplete command.';
    engineOf(ctx).setKeyChain(chain);
    return '';
  });
  configTrie.registerGreedy('no ip sla key-chain', 'Remove control protocol authentication', () => {
    engineOf(ctx).setKeyChain(null);
    return '';
  });
}

export function expandOperationList(list: string): number[] {
  const ids: number[] = [];
  for (const chunk of list.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(chunk);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      for (let id = from; id <= to; id++) ids.push(id);
      continue;
    }
    if (/^\d+$/.test(chunk)) ids.push(parseInt(chunk, 10));
  }
  return ids;
}

function extractHost(url: string): string | null {
  const match = /^(?:https?:\/\/)?([^/:]+)/i.exec(url);
  return match ? match[1] : null;
}

interface TypeSpec {
  keyword: string;
  description: string;
  type: SlaOperationType;

  parameters: readonly ParameterName[];
}

type ParameterName =
  | 'frequency' | 'timeout' | 'threshold' | 'request-data-size' | 'tos'
  | 'verify-data' | 'tag' | 'owner' | 'precision' | 'history' | 'vrf'
  | 'http-raw-request';

const COMMON_PARAMETERS: readonly ParameterName[] = [
  'frequency', 'history', 'owner', 'tag', 'threshold', 'timeout', 'tos', 'vrf',
];

const TYPE_SPECS: readonly TypeSpec[] = [
  {
    keyword: 'icmp-echo', description: 'ICMP Echo Operation', type: 'icmp-echo',
    parameters: [...COMMON_PARAMETERS, 'request-data-size', 'verify-data'],
  },
  {
    keyword: 'icmp-jitter', description: 'ICMP Jitter Operation', type: 'icmp-jitter',
    parameters: [...COMMON_PARAMETERS, 'request-data-size', 'precision', 'verify-data'],
  },
  {
    keyword: 'udp-echo', description: 'UDP Echo Operation', type: 'udp-echo',
    parameters: [...COMMON_PARAMETERS, 'request-data-size', 'verify-data'],
  },
  {
    keyword: 'udp-jitter', description: 'UDP Jitter Operation', type: 'udp-jitter',
    parameters: [...COMMON_PARAMETERS, 'request-data-size', 'precision', 'verify-data'],
  },
  {
    keyword: 'tcp-connect', description: 'TCP Connect Operation', type: 'tcp-connect',
    parameters: COMMON_PARAMETERS,
  },
  {
    keyword: 'http', description: 'HTTP Operation', type: 'http',
    parameters: [...COMMON_PARAMETERS, 'http-raw-request'],
  },
  { keyword: 'dns', description: 'DNS Query Operation', type: 'dns', parameters: COMMON_PARAMETERS },
  {
    keyword: 'path-echo', description: 'Path Discovered ICMP Echo Operation', type: 'path-echo',
    parameters: [...COMMON_PARAMETERS, 'request-data-size', 'verify-data'],
  },
];

export function registerOperationTypes(
  slaTrie: CommandTrie,
  ctx: IpSlaCommandContext,
): void {
  for (const spec of TYPE_SPECS) {
    slaTrie.registerGreedy(spec.keyword, spec.description, (args) => {
      const runtime = selected(ctx);
      if (!runtime) return '';
      if (args.length === 0) return INCOMPLETE;

      applyTypeDefaults(runtime.config, spec.type);
      runtime.config.type = spec.type;

      const error = spec.type === 'http'
        ? applyHttpOperand(runtime.config, args, ctx)
        : spec.type === 'dns'
          ? applyDnsOperand(runtime.config, args)
          : applyTarget(runtime.config, args, spec.type);
      if (error) {
        runtime.config.type = 'unknown';
        return error;
      }

      if (spec.type === 'udp-jitter') {
        const codecIndex = args.indexOf('codec');
        if (codecIndex >= 0) {
          const codec = args[codecIndex + 1] as SlaCodec | undefined;
          if (!codec || !(codec in CODEC_PROFILES)) {
            runtime.config.type = 'unknown';
            return INVALID_INPUT;
          }
          applyCodecDefaults(runtime.config, codec);
        }
      }
      if (spec.type === 'udp-jitter' || spec.type === 'icmp-jitter') {
        const numPackets = boundedInt(
          findKeywordValue(args, 'num-packets'), IPSLA_RANGES.numPackets);
        if (numPackets !== null) runtime.config.numPackets = numPackets;
        const interval = boundedInt(findKeywordValue(args, 'interval'), IPSLA_RANGES.interval);
        if (interval !== null) runtime.config.intervalMs = interval;
      }

      engineOf(ctx).noteConfigChange(runtime.config.id);
      ctx.setMode(IPSLA_TYPE_MODES[spec.type]);
      return '';
    });
  }
}

function applyDnsOperand(config: SlaOperationConfig, args: string[]): string {
  const name = args[0];
  if (!name) return INCOMPLETE;
  const server = findKeywordValue(args, 'name-server');
  if (!server) return INCOMPLETE;
  config.dns = { name, nameServer: server };
  config.target = server;
  config.sourceInterface = findKeywordValue(args, 'source-interface') ?? null;
  config.sourceIp = findKeywordValue(args, 'source-ip') ?? null;
  return '';
}

function applyHttpOperand(
  config: SlaOperationConfig,
  args: string[],
  ctx: IpSlaCommandContext,
): string {
  const mode = args[0];
  if (mode !== 'get' && mode !== 'raw') return INVALID_INPUT;
  const url = args[1];
  if (!url) return INCOMPLETE;
  config.http.mode = mode;
  config.http.rawRequest = [];
  config.http.url = url;
  config.http.nameServer = findKeywordValue(args, 'name-server') ?? null;
  const version = findKeywordValue(args, 'version');
  if (version) config.http.version = version;
  config.sourceIp = findKeywordValue(args, 'source-ip') ?? null;
  config.sourceInterface = findKeywordValue(args, 'source-interface') ?? null;
  config.target = IPV4.test(url) ? url : extractHost(url);
  void ctx;
  return '';
}

function registerParameter(
  trie: CommandTrie,
  name: ParameterName,
  ctx: IpSlaCommandContext,
): void {
  const engine = () => engineOf(ctx);
  switch (name) {
    case 'frequency':
      trie.registerGreedy('frequency', 'Frequency of an operation', (args) => {
        const runtime = selected(ctx);
        if (!runtime) return '';
        const value = boundedInt(args[0], IPSLA_RANGES.frequency);
        if (value === null) return args.length === 0 ? INCOMPLETE : INVALID_INPUT;
        runtime.config.frequencySeconds = value;
        engine().noteConfigChange(runtime.config.id);
        return '';
      });
      return;
    case 'timeout':
      trie.registerGreedy('timeout', 'Timeout of an operation', (args) => {
        const runtime = selected(ctx);
        if (!runtime) return '';
        const value = boundedInt(args[0], IPSLA_RANGES.timeout);
        if (value === null) return args.length === 0 ? INCOMPLETE : INVALID_INPUT;
        runtime.config.timeoutMs = value;
        return '';
      });
      return;
    case 'threshold':
      trie.registerGreedy('threshold', 'Operation threshold in milliseconds', (args) => {
        const runtime = selected(ctx);
        if (!runtime) return '';
        const value = boundedInt(args[0], IPSLA_RANGES.threshold);
        if (value === null) return args.length === 0 ? INCOMPLETE : INVALID_INPUT;
        runtime.config.thresholdMs = value;
        return '';
      });
      return;
    case 'request-data-size':
      trie.registerGreedy('request-data-size', 'Request data size', (args) => {
        const runtime = selected(ctx);
        if (!runtime) return '';
        const value = boundedInt(args[0], IPSLA_RANGES.requestDataSize);
        if (value === null) return args.length === 0 ? INCOMPLETE : INVALID_INPUT;
        runtime.config.requestDataSize = value;
        return '';
      });
      return;
    case 'tos':
      trie.registerGreedy('tos', 'Type Of Service', (args) => {
        const runtime = selected(ctx);
        if (!runtime) return '';
        const value = boundedInt(args[0], IPSLA_RANGES.tos);
        if (value === null) return args.length === 0 ? INCOMPLETE : INVALID_INPUT;
        runtime.config.tos = value;
        return '';
      });
      return;
    case 'verify-data':
      trie.register('verify-data', 'Verify data in response', () => {
        const runtime = selected(ctx);
        if (runtime) runtime.config.verifyData = true;
        return '';
      });
      trie.register('no verify-data', 'Do not verify data in response', () => {
        const runtime = selected(ctx);
        if (runtime) runtime.config.verifyData = false;
        return '';
      });
      return;
    case 'tag':
      trie.registerGreedy('tag', 'User defined tag', (args) => {
        const runtime = selected(ctx);
        if (!runtime) return '';
        if (args.length === 0) return INCOMPLETE;
        runtime.config.tag = args.join(' ');
        return '';
      });
      return;
    case 'owner':
      trie.registerGreedy('owner', 'Owner of entry', (args) => {
        const runtime = selected(ctx);
        if (!runtime) return '';
        if (args.length === 0) return INCOMPLETE;
        runtime.config.owner = args.join(' ');
        return '';
      });
      return;
    case 'precision':
      trie.registerGreedy('precision', 'Timestamp precision', (args) => {
        const runtime = selected(ctx);
        if (!runtime) return '';
        if (args[0] !== 'milliseconds' && args[0] !== 'microseconds') return INVALID_INPUT;
        runtime.config.precision = args[0];
        return '';
      });
      return;
    case 'vrf':
      trie.registerGreedy('vrf', 'Configure IP SLAs for a VRF', () =>
        '% VRF-aware IP SLAs is not supported in this simulator '
        + '(no per-VRF forwarding plane)');
      return;
    case 'http-raw-request':
      trie.register('http-raw-request', 'Enter HTTP raw request mode', () => {
        ctx.setMode('config-ipsla-http-raw');
        return '';
      });
      return;
    case 'history':
      trie.registerGreedy('history', 'History and Distribution Data', (args) =>
        applyHistory(ctx, args));
      return;
  }
}

function applyHistory(ctx: IpSlaCommandContext, args: string[]): string {
  const runtime = selected(ctx);
  if (!runtime) return '';
  const config = runtime.config;
  switch (args[0]) {
    case 'lives-kept': {
      const value = boundedInt(args[1], IPSLA_RANGES.livesKept);
      if (value === null) return args.length < 2 ? INCOMPLETE : INVALID_INPUT;
      config.historyLivesKept = value;
      if (value > 0 && config.historyFilter === 'none') config.historyFilter = 'all';
      break;
    }
    case 'buckets-kept': {
      const value = boundedInt(args[1], IPSLA_RANGES.bucketsKept);
      if (value === null) return args.length < 2 ? INCOMPLETE : INVALID_INPUT;
      config.historyBucketsKept = value;
      break;
    }
    case 'filter': {
      const filter = args[1];
      if (filter !== 'none' && filter !== 'all' && filter !== 'overThreshold'
        && filter !== 'failures') return INVALID_INPUT;
      config.historyFilter = filter;
      break;
    }
    case 'distributions-of-statistics-kept': {
      const value = boundedInt(args[1], IPSLA_RANGES.distributions);
      if (value === null) return args.length < 2 ? INCOMPLETE : INVALID_INPUT;
      config.distributionsKept = value;
      break;
    }
    case 'statistics-distribution-interval': {
      const value = boundedInt(args[1], IPSLA_RANGES.distributionInterval);
      if (value === null) return args.length < 2 ? INCOMPLETE : INVALID_INPUT;
      config.distributionIntervalMs = value;
      break;
    }
    case 'hours-of-statistics-kept': {
      const value = boundedInt(args[1], IPSLA_RANGES.hoursKept);
      if (value === null) return args.length < 2 ? INCOMPLETE : INVALID_INPUT;
      config.hoursOfStatisticsKept = value;
      break;
    }
    case 'enhanced':
      break;
    default:
      return args.length === 0 ? INCOMPLETE : INVALID_INPUT;
  }
  engineOf(ctx).noteConfigChange(config.id);
  return '';
}

export function registerIpSlaTypeSubModes(
  tries: Record<string, CommandTrie>,
  rawTrie: CommandTrie,
  ctx: IpSlaCommandContext,
): void {
  for (const spec of TYPE_SPECS) {
    const trie = tries[IPSLA_TYPE_MODES[spec.type]];
    if (!trie) continue;
    registerTypeSubModeOn(trie, spec.type, ctx);
  }
  registerIpSlaHttpRawOn(rawTrie, ctx);
}

export function registerTypeSubModeOn(
  trie: CommandTrie, type: SlaOperationType, ctx: IpSlaCommandContext,
): void {
  const spec = TYPE_SPECS.find(candidate => candidate.type === type);
  if (!spec) return;
  for (const parameter of spec.parameters) registerParameter(trie, parameter, ctx);
}

export function registerIpSlaHttpRawOn(
  rawTrie: CommandTrie, ctx: IpSlaCommandContext,
): void {
  rawTrie.registerGreedy('exit', 'Exit the raw HTTP request mode', () => {
    ctx.setMode('config-ipsla-http');
    return '';
  });
}

/**
 * Les bornes viennent d'`IPSLA_RANGES`, la table que le gestionnaire lit
 * deja pour refuser une valeur : deux vues du meme fait ne peuvent donc
 * pas se contredire, et une commande annonce exactement l'intervalle
 * qu'elle accepte.
 */
function borne(
  nom: string, description: string,
  plage: readonly [number, number],
): ArgumentSpec {
  return { name: nom, type: 'INT', description, range: [plage[0], plage[1]] };
}

const HISTORY_KEYWORDS: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'lives-kept', description: 'Number of lives kept',
    argument: borne('lives', 'Number of lives', IPSLA_RANGES.livesKept),
  },
  {
    keyword: 'buckets-kept', description: 'Number of history buckets kept',
    argument: borne('buckets', 'Number of buckets', IPSLA_RANGES.bucketsKept),
  },
  {
    keyword: 'filter', description: 'Type of information kept in the history table',
    argument: {
      name: 'filtre', type: 'ENUM', description: 'What the history keeps',
      values: [
        { keyword: 'none', description: 'Keep no history' },
        { keyword: 'all', description: 'Keep every operation' },
        { keyword: 'overThreshold', description: 'Keep the operations over the threshold' },
        { keyword: 'failures', description: 'Keep the operations that failed' },
      ],
    },
  },
  {
    keyword: 'distributions-of-statistics-kept',
    description: 'Number of statistics distributions kept',
    argument: borne('distributions', 'Number of distributions', IPSLA_RANGES.distributions),
  },
  {
    keyword: 'statistics-distribution-interval',
    description: 'Statistics distribution interval in milliseconds',
    argument: borne('intervalle', 'Interval in milliseconds', IPSLA_RANGES.distributionInterval),
  },
  {
    keyword: 'hours-of-statistics-kept', description: 'Number of hours of statistics kept',
    argument: borne('heures', 'Number of hours', IPSLA_RANGES.hoursKept),
  },
  {
    keyword: 'enhanced', description: 'Enhanced history parameters',
    argument: { name: 'reste', type: 'REST', optional: true,
      description: 'Enhanced history parameters' },
  },
];

const PARAMETER_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  frequency: borne('secondes', 'Frequency in seconds', IPSLA_RANGES.frequency),
  timeout: borne('millisecondes', 'Timeout in milliseconds', IPSLA_RANGES.timeout),
  threshold: borne('millisecondes', 'Threshold in milliseconds', IPSLA_RANGES.threshold),
  'request-data-size': borne('octets', 'Payload size in bytes', IPSLA_RANGES.requestDataSize),
  tos: borne('tos', 'Type of service value', IPSLA_RANGES.tos),
  tag: { name: 'etiquette', type: 'REST', literal: 'LINE',
    description: 'User defined tag for this operation' },
  owner: { name: 'proprietaire', type: 'REST', literal: 'LINE',
    description: 'Owner of this operation' },
  precision: {
    name: 'precision', type: 'ENUM', description: 'Unit the timestamps are kept in',
    values: [
      { keyword: 'milliseconds', description: 'Keep timestamps to the millisecond' },
      { keyword: 'microseconds', description: 'Keep timestamps to the microsecond' },
    ],
  },
  vrf: { name: 'instance', type: 'WORD', description: 'Name of the VRF' },
  history: null,
};

/**
 * Ce que chaque type d'operation prend apres son mot-cle.
 *
 * La cible seule ne suffit pas : trois types portent un PORT en
 * deuxieme position et `http` ne prend pas de cible du tout mais un
 * verbe suivi d'une URL. Un `REST` unique les couvrirait toutes en
 * n'en decrivant aucune.
 */
const TYPE_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[]>> = {
  'icmp-echo': [
    { name: 'cible', type: 'IP_ADDR', description: 'Destination IP address' },
    { name: 'reste', type: 'REST', optional: true,
      description: 'source-interface, source-ip' },
  ],
  'icmp-jitter': [
    { name: 'cible', type: 'IP_ADDR', description: 'Destination IP address' },
    { name: 'reste', type: 'REST', optional: true,
      description: 'num-packets, interval, source-ip' },
  ],
  'path-echo': [
    { name: 'cible', type: 'IP_ADDR', description: 'Destination IP address' },
    { name: 'reste', type: 'REST', optional: true,
      description: 'source-interface, source-ip' },
  ],
  'udp-echo': [
    { name: 'cible', type: 'IP_ADDR', description: 'Destination IP address' },
    { name: 'port', type: 'INT', description: 'Destination port', range: [1, 65535] },
    { name: 'reste', type: 'REST', optional: true,
      description: 'source-ip, source-port, control' },
  ],
  'udp-jitter': [
    { name: 'cible', type: 'IP_ADDR', description: 'Destination IP address' },
    { name: 'port', type: 'INT', description: 'Destination port', range: [1, 65535] },
    { name: 'reste', type: 'REST', optional: true,
      description: 'codec, num-packets, interval, source-ip' },
  ],
  'tcp-connect': [
    { name: 'cible', type: 'IP_ADDR', description: 'Destination IP address' },
    { name: 'port', type: 'INT', description: 'Destination port', range: [1, 65535] },
    { name: 'reste', type: 'REST', optional: true,
      description: 'source-ip, source-port, control' },
  ],
  dns: [
    { name: 'nom', type: 'WORD', description: 'Name to resolve' },
    { name: 'reste', type: 'REST', description: 'name-server <A.B.C.D>' },
  ],
  http: [
    {
      name: 'verbe', type: 'ENUM', description: 'How the request is built',
      values: [
        { keyword: 'get', description: 'Build the request from the URL' },
        { keyword: 'raw', description: 'Type the request by hand' },
      ],
    },
    { name: 'reste', type: 'REST', description: 'URL, then name-server or version' },
  ],
};

export function ipSlaSubmodeSpecs(ctx: IpSlaCommandContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerOperationTypes(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ipsla'], minPrivilege: 15,
      argumentFor: (path) => TYPE_ARGUMENTS[path],
    },
  );
}

export function ipSlaTypeSubmodeSpecs(ctx: IpSlaCommandContext): CommandSpec[] {
  const specs: CommandSpec[] = [];
  for (const type of Object.keys(IPSLA_TYPE_MODES) as SlaOperationType[]) {
    const mode = IPSLA_TYPE_MODES[type];
    specs.push(...specsFromTrieRegistrations(
      (collector) =>
        registerTypeSubModeOn(collector as unknown as CommandTrie, type, ctx),
      {
        modes: [mode], minPrivilege: 15,
        undoFromNegatedPaths: true,
        argumentFor: (path) => PARAMETER_ARGUMENTS[path],
        keywordsFor: (path) => path === 'history' ? HISTORY_KEYWORDS : undefined,
      },
    ));
  }
  return specs;
}

export function ipSlaHttpRawSpecs(ctx: IpSlaCommandContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerIpSlaHttpRawOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ipsla-http-raw'], minPrivilege: 15,
      argumentFor: () => null,
    },
  );
}
