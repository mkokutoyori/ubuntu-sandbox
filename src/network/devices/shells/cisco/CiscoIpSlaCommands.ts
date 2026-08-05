import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { IpSlaEngine, SlaOperationRuntime } from '../../../ipsla/IpSlaEngine';
import {
  applyCodecDefaults, applyTypeDefaults, CODEC_PROFILES,
  type SlaCodec, type SlaOperationConfig, type SlaOperationType,
} from '../../../ipsla/types';
import { isReactionElement } from '../../../ipsla/reactions';

export interface IpSlaCommandContext {
  r(): Router;
  setMode(mode: 'config-ipsla' | 'config-ipsla-http-raw' | 'config'): void;
  getSelectedIpSla(): number | null;
  setSelectedIpSla(id: number | null): void;
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
  const positional = args.filter((token, index) => {
    if (index === 0) return true;
    return false;
  });
  const target = positional[0];
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
  });

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
  });

  configTrie.registerGreedy('ip sla restart', 'Restart an IP SLAs operation', (args) => {
    const id = positiveInt(args[0]);
    if (id === null) return '% Incomplete command.';
    return engineOf(ctx).restart(id) ? '' : `% IP SLAs entry ${id} is not scheduled`;
  });

  configTrie.registerGreedy('ip sla enable', 'Enable IP SLAs', () => {
    engineOf(ctx).globalEnabled = true;
    return '';
  });
  configTrie.registerGreedy('no ip sla enable', 'Disable IP SLAs', () => {
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
  registerOperationTypes(slaTrie, rawTrie, ctx);
  registerOperationParameters(slaTrie, ctx);
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
  });

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
  });

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

function registerOperationTypes(
  slaTrie: CommandTrie,
  rawTrie: CommandTrie,
  ctx: IpSlaCommandContext,
): void {
  const simpleTypes: Array<[string, SlaOperationType, string]> = [
    ['icmp-echo', 'icmp-echo', 'ICMP Echo Operation'],
    ['icmp-jitter', 'icmp-jitter', 'ICMP Jitter Operation'],
    ['udp-echo', 'udp-echo', 'UDP Echo Operation'],
    ['udp-jitter', 'udp-jitter', 'UDP Jitter Operation'],
    ['tcp-connect', 'tcp-connect', 'TCP Connect Operation'],
    ['path-echo', 'path-echo', 'Path Discovered ICMP Echo Operation'],
  ];

  for (const [keyword, type, description] of simpleTypes) {
    slaTrie.registerGreedy(keyword, description, (args) => {
      const runtime = selected(ctx);
      if (!runtime) return '';
      applyTypeDefaults(runtime.config, type);
      runtime.config.type = type;
      const error = applyTarget(runtime.config, args, type);
      if (error) return error;
      if (type === 'udp-jitter') {
        const codecIndex = args.indexOf('codec');
        if (codecIndex >= 0) {
          const codec = args[codecIndex + 1] as SlaCodec | undefined;
          if (!codec || !(codec in CODEC_PROFILES)) return '% Invalid codec';
          applyCodecDefaults(runtime.config, codec);
        }
        const numPackets = positiveInt(findKeywordValue(args, 'num-packets'));
        if (numPackets !== null) runtime.config.numPackets = numPackets;
        const interval = positiveInt(findKeywordValue(args, 'interval'));
        if (interval !== null) runtime.config.intervalMs = interval;
      }
      engineOf(ctx).noteConfigChange(runtime.config.id);
      return '';
    });
  }

  slaTrie.registerGreedy('dns', 'DNS Query Operation', (args) => {
    const runtime = selected(ctx);
    if (!runtime) return '';
    const name = args[0];
    if (!name) return '% Incomplete command.';
    const server = findKeywordValue(args, 'name-server');
    if (!server) return '% Incomplete command.';
    applyTypeDefaults(runtime.config, 'dns');
    runtime.config.type = 'dns';
    runtime.config.dns = { name, nameServer: server };
    runtime.config.target = server;
    runtime.config.sourceInterface = findKeywordValue(args, 'source-interface') ?? null;
    runtime.config.sourceIp = findKeywordValue(args, 'source-ip') ?? null;
    engineOf(ctx).noteConfigChange(runtime.config.id);
    return '';
  });

  slaTrie.registerGreedy('http', 'HTTP Operation', (args) => {
    const runtime = selected(ctx);
    if (!runtime) return '';
    const mode = args[0];
    if (mode !== 'get' && mode !== 'raw') return '% Invalid input detected at \'^\' marker.';
    applyTypeDefaults(runtime.config, 'http');
    runtime.config.type = 'http';
    runtime.config.http.mode = mode;
    runtime.config.http.rawRequest = [];
    const url = args[1];
    if (!url) return '% Incomplete command.';
    runtime.config.http.url = url;
    runtime.config.http.nameServer = findKeywordValue(args, 'name-server') ?? null;
    const version = findKeywordValue(args, 'version');
    if (version) runtime.config.http.version = version;
    const sourceIp = findKeywordValue(args, 'source-ip');
    runtime.config.sourceIp = sourceIp ?? null;
    runtime.config.sourceInterface = findKeywordValue(args, 'source-interface') ?? null;
    runtime.config.target = IPV4.test(url) ? url : extractHost(url);
    if (mode === 'raw') ctx.setMode('config-ipsla-http-raw');
    engineOf(ctx).noteConfigChange(runtime.config.id);
    return '';
  });

  rawTrie.registerGreedy('exit', 'Exit raw HTTP request mode', () => {
    ctx.setMode('config-ipsla');
    return '';
  });
}

function extractHost(url: string): string | null {
  const match = /^(?:https?:\/\/)?([^/:]+)/i.exec(url);
  return match ? match[1] : null;
}

function registerOperationParameters(slaTrie: CommandTrie, ctx: IpSlaCommandContext): void {
  const numeric: Array<[string, string, (config: SlaOperationConfig, value: number) => void]> = [
    ['frequency', 'Frequency of an operation', (config, value) => { config.frequencySeconds = value; }],
    ['timeout', 'Timeout of an operation', (config, value) => { config.timeoutMs = value; }],
    ['threshold', 'Operation threshold in milliseconds', (config, value) => { config.thresholdMs = value; }],
    ['request-data-size', 'Request data size', (config, value) => { config.requestDataSize = value; }],
    ['tos', 'Type Of Service', (config, value) => { config.tos = value; }],
    ['num-packets', 'Number of packets', (config, value) => { config.numPackets = value; }],
    ['interval', 'Inter-packet interval', (config, value) => { config.intervalMs = value; }],
  ];

  for (const [keyword, description, apply] of numeric) {
    slaTrie.registerGreedy(keyword, description, (args) => {
      const runtime = selected(ctx);
      if (!runtime) return '';
      const value = positiveInt(args[0]);
      if (value === null) return '% Incomplete command.';
      apply(runtime.config, value);
      engineOf(ctx).noteConfigChange(runtime.config.id);
      return '';
    });
  }

  slaTrie.registerGreedy('tag', 'User defined tag', (args) => {
    const runtime = selected(ctx);
    if (runtime) runtime.config.tag = args.join(' ') || null;
    return '';
  });

  slaTrie.registerGreedy('owner', 'Owner of entry', (args) => {
    const runtime = selected(ctx);
    if (runtime) runtime.config.owner = args.join(' ') || null;
    return '';
  });

  slaTrie.registerGreedy('verify-data', 'Verify data in response', () => {
    const runtime = selected(ctx);
    if (runtime) runtime.config.verifyData = true;
    return '';
  });
  slaTrie.registerGreedy('no verify-data', 'Do not verify data', () => {
    const runtime = selected(ctx);
    if (runtime) runtime.config.verifyData = false;
    return '';
  });

  slaTrie.registerGreedy('precision', 'Timestamp precision', (args) => {
    const runtime = selected(ctx);
    if (!runtime) return '';
    if (args[0] !== 'milliseconds' && args[0] !== 'microseconds') {
      return '% Invalid input detected at \'^\' marker.';
    }
    runtime.config.precision = args[0];
    return '';
  });

  slaTrie.registerGreedy('history', 'History and Distribution Data', (args) => {
    const runtime = selected(ctx);
    if (!runtime) return '';
    const config = runtime.config;
    const keyword = args[0];
    const value = positiveInt(args[1]);
    switch (keyword) {
      case 'lives-kept':
        if (value === null) return '% Incomplete command.';
        config.historyLivesKept = value;
        if (value > 0 && config.historyFilter === 'none') config.historyFilter = 'all';
        break;
      case 'buckets-kept':
        if (value === null) return '% Incomplete command.';
        config.historyBucketsKept = value;
        break;
      case 'filter': {
        const filter = args[1];
        if (filter !== 'none' && filter !== 'all' && filter !== 'overThreshold'
          && filter !== 'failures') {
          return '% Invalid input detected at \'^\' marker.';
        }
        config.historyFilter = filter;
        break;
      }
      case 'distributions-of-statistics-kept':
        if (value === null) return '% Incomplete command.';
        config.distributionsKept = value;
        break;
      case 'statistics-distribution-interval':
        if (value === null) return '% Incomplete command.';
        config.distributionIntervalMs = value;
        break;
      case 'hours-of-statistics-kept':
        if (value === null) return '% Incomplete command.';
        config.hoursOfStatisticsKept = value;
        break;
      case 'enhanced':
        break;
      default:
        return '% Invalid input detected at \'^\' marker.';
    }
    engineOf(ctx).noteConfigChange(config.id);
    return '';
  });

  slaTrie.registerGreedy('vrf', 'Configure IP SLAs for a VRF', () =>
    '% VRF-aware IP SLAs is not supported in this simulator (no per-VRF forwarding plane)');
}
