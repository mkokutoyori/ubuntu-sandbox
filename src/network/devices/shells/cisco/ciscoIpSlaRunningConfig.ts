import type { Router } from '../../Router';
import type { SlaOperationRuntime } from '../../../ipsla/IpSlaEngine';
import type { SlaOperationConfig } from '../../../ipsla/types';
import { CODEC_PROFILES, OPERATION_TYPE_DEFAULTS } from '../../../ipsla/types';
import type { TrackObject } from '../../../ipsla/TrackService';

function defaultOf(config: SlaOperationConfig, field: keyof SlaOperationConfig): unknown {
  const typeDefaults = OPERATION_TYPE_DEFAULTS[config.type];
  if (typeDefaults && field in typeDefaults) {
    return (typeDefaults as Record<string, unknown>)[field as string];
  }
  const generic: Partial<Record<keyof SlaOperationConfig, unknown>> = {
    frequencySeconds: 60,
    timeoutMs: 5000,
    thresholdMs: 5000,
    tos: 0,
    numPackets: 10,
    intervalMs: 20,
    historyLivesKept: 0,
    historyBucketsKept: 15,
    distributionsKept: 1,
    distributionIntervalMs: 20,
    hoursOfStatisticsKept: 2,
  };
  return generic[field];
}

function operationLine(config: SlaOperationConfig): string | null {
  const source = config.sourceInterface
    ? ` source-interface ${config.sourceInterface}`
    : config.sourceIp ? ` source-ip ${config.sourceIp}` : '';
  switch (config.type) {
    case 'icmp-echo':
      return ` icmp-echo ${config.target}${source}`;
    case 'icmp-jitter':
      return ` icmp-jitter ${config.target}${source}`;
    case 'path-echo':
      return ` path-echo ${config.target}${source}`;
    case 'udp-echo':
      return ` udp-echo ${config.target} ${config.targetPort}${source}`
        + `${config.controlEnabled ? '' : ' control disable'}`;
    case 'udp-jitter': {
      const codec = config.codec ? ` codec ${config.codec}` : '';
      return ` udp-jitter ${config.target} ${config.targetPort}${codec}${source}`
        + `${config.controlEnabled ? '' : ' control disable'}`;
    }
    case 'tcp-connect':
      return ` tcp-connect ${config.target} ${config.targetPort}${source}`
        + `${config.controlEnabled ? '' : ' control disable'}`;
    case 'http':
      return ` http ${config.http.mode} ${config.http.url}`
        + `${config.http.nameServer ? ` name-server ${config.http.nameServer}` : ''}`;
    case 'dns':
      return ` dns ${config.dns.name} name-server ${config.dns.nameServer}`;
    default:
      return null;
  }
}

function scheduleLine(runtime: SlaOperationRuntime): string | null {
  const schedule = runtime.config.schedule;
  if (!schedule.configured) return null;
  const parts = [`ip sla schedule ${runtime.config.id}`];
  parts.push(`life ${schedule.lifeSeconds === 'forever' ? 'forever' : schedule.lifeSeconds}`);
  if (schedule.startPending) parts.push('start-time pending');
  else if (schedule.startAfterSeconds !== null) {
    parts.push(`start-time after ${formatClock(schedule.startAfterSeconds)}`);
  } else if (schedule.startAtSecondsOfDay !== null) {
    parts.push(`start-time ${formatClock(schedule.startAtSecondsOfDay)}`);
  } else parts.push('start-time now');
  if (schedule.ageoutSeconds > 0) parts.push(`ageout ${schedule.ageoutSeconds}`);
  if (schedule.recurring) parts.push('recurring');
  return parts.join(' ');
}

function formatClock(totalSeconds: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function trackLines(object: TrackObject): string[] {
  const header = (() => {
    switch (object.type) {
      case 'interface-line':
        return `track ${object.id} interface ${object.iface} line-protocol`;
      case 'interface-routing':
        return `track ${object.id} interface ${object.iface} ip routing`;
      case 'route-reachability':
        return `track ${object.id} ip route ${object.prefix} ${object.mask} reachability`;
      case 'route-metric':
        return `track ${object.id} ip route ${object.prefix} ${object.mask} metric threshold`;
      case 'ipsla-reachability':
        return `track ${object.id} ip sla ${object.slaId} reachability`;
      case 'ipsla-state':
        return `track ${object.id} ip sla ${object.slaId} state`;
      case 'list-boolean':
        return `track ${object.id} list boolean ${object.boolOp}`;
      case 'list-threshold':
        return `track ${object.id} list threshold weight`;
      default:
        return `track ${object.id} stub-object`;
    }
  })();

  const lines = [header];
  for (const member of object.members) {
    lines.push(` object ${member.id}`
      + `${member.weight !== undefined ? ` weight ${member.weight}` : ''}`
      + `${member.negate ? ' not' : ''}`);
  }
  if (object.thresholdUp !== null || object.thresholdDown !== null) {
    const up = object.thresholdUp !== null ? ` up ${object.thresholdUp}` : '';
    const down = object.thresholdDown !== null ? ` down ${object.thresholdDown}` : '';
    lines.push(` threshold weight${up}${down}`);
  }
  if (object.delayUpSeconds > 0 || object.delayDownSeconds > 0) {
    const up = object.delayUpSeconds > 0 ? ` up ${object.delayUpSeconds}` : '';
    const down = object.delayDownSeconds > 0 ? ` down ${object.delayDownSeconds}` : '';
    lines.push(` delay${up}${down}`);
  }
  return lines;
}

/**
 * IP SLA et `track` n'apparaissaient nulle part dans la running-config.
 * Ce n'est pas qu'un affichage : la configuration rendue est ce que
 * `write memory` enregistre et ce qu'un import de topologie rejoue. Une
 * route statique conditionnée par `track 1`, elle, ÉTAIT sauvegardée —
 * la machine rechargée avait donc des routes suspendues à des objets qui
 * n'existaient plus.
 */
export function ipSlaRunningConfigLines(router: Router): string[] {
  const engine = router.getIpSlaEngine();
  const lines: string[] = [];

  for (const runtime of engine.listOperations()) {
    const config = runtime.config;
    lines.push(`ip sla ${config.id}`);
    const operation = operationLine(config);
    if (operation) lines.push(operation);

    if (config.type === 'http' && config.http.mode === 'raw') {
      for (const raw of config.http.rawRequest) lines.push(`  ${raw}`);
    }
    if (config.frequencySeconds !== defaultOf(config, 'frequencySeconds')) {
      lines.push(` frequency ${config.frequencySeconds}`);
    }
    if (config.timeoutMs !== defaultOf(config, 'timeoutMs')) {
      lines.push(` timeout ${config.timeoutMs}`);
    }
    if (config.thresholdMs !== defaultOf(config, 'thresholdMs')) {
      lines.push(` threshold ${config.thresholdMs}`);
    }
    if (config.requestDataSize !== defaultOf(config, 'requestDataSize')
      && !(config.codec && config.requestDataSize === CODEC_PROFILES[config.codec].payloadBytes)) {
      lines.push(` request-data-size ${config.requestDataSize}`);
    }
    if (config.tos !== 0) lines.push(` tos ${config.tos}`);
    if (config.verifyData) lines.push(' verify-data');
    if (config.tag) lines.push(` tag ${config.tag}`);
    if (config.owner) lines.push(` owner ${config.owner}`);
    if ((config.type === 'udp-jitter' || config.type === 'icmp-jitter')) {
      const codecProfile = config.codec ? CODEC_PROFILES[config.codec] : null;
      if (config.numPackets !== (codecProfile?.numPackets ?? defaultOf(config, 'numPackets'))) {
        lines.push(` num-packets ${config.numPackets}`);
      }
      if (config.intervalMs !== (codecProfile?.intervalMs ?? defaultOf(config, 'intervalMs'))) {
        lines.push(` interval ${config.intervalMs}`);
      }
    }
    if (config.historyLivesKept !== 0) lines.push(` history lives-kept ${config.historyLivesKept}`);
    if (config.historyBucketsKept !== 15) {
      lines.push(` history buckets-kept ${config.historyBucketsKept}`);
    }
    if (config.historyFilter !== 'none') lines.push(` history filter ${config.historyFilter}`);
    if (config.distributionsKept !== 1) {
      lines.push(` history distributions-of-statistics-kept ${config.distributionsKept}`);
    }
    if (config.distributionIntervalMs !== 20) {
      lines.push(` history statistics-distribution-interval ${config.distributionIntervalMs}`);
    }
    if (config.hoursOfStatisticsKept !== 2) {
      lines.push(` history hours-of-statistics-kept ${config.hoursOfStatisticsKept}`);
    }
    if (config.precision !== 'milliseconds') lines.push(` precision ${config.precision}`);
    lines.push('!');
  }

  for (const runtime of engine.listOperations()) {
    const line = scheduleLine(runtime);
    if (line) lines.push(line);
  }

  for (const reaction of engine.listReactions()) {
    const parts = [`ip sla reaction-configuration ${reaction.operationId}`,
      `react ${reaction.element}`];
    switch (reaction.thresholdType) {
      case 'consecutive':
        parts.push(`threshold-type consecutive ${reaction.consecutiveCount}`);
        break;
      case 'xOfy':
        parts.push(`threshold-type xOfy ${reaction.xOfyX} ${reaction.xOfyY}`);
        break;
      case 'average':
        parts.push(`threshold-type average ${reaction.averageCount}`);
        break;
      case 'immediate':
        parts.push('threshold-type immediate');
        break;
      default:
        break;
    }
    parts.push(`threshold-value ${reaction.thresholdUpper} ${reaction.thresholdLower}`);
    parts.push(`action-type ${reaction.actionType}`);
    lines.push(parts.join(' '));
  }

  for (const trigger of engine.listReactionTriggers()) {
    lines.push(`ip sla reaction-trigger ${trigger.source} ${trigger.target}`);
  }

  const responder = engine.getResponder();
  if (responder.isEnabled()) {
    const permanent = responder.listPorts().filter((entry) => entry.permanent);
    if (permanent.length === 0) lines.push('ip sla responder');
    for (const entry of permanent) {
      lines.push(`ip sla responder ${entry.protocol}`
        + `${entry.address ? ` ipaddress ${entry.address}` : ''} port ${entry.port}`);
    }
  }
  if (engine.getKeyChain()) lines.push(`ip sla key-chain ${engine.getKeyChain()}`);
  if (!engine.globalEnabled) lines.push('no ip sla enable');
  if (engine.loggingTrapsEnabled) lines.push('ip sla logging traps');

  if (lines.length > 0 && lines[lines.length - 1] !== '!') lines.push('!');
  return lines;
}

export function trackRunningConfigLines(router: Router): string[] {
  const lines: string[] = [];
  for (const object of router.getTrackService().all()) {
    lines.push(...trackLines(object));
    lines.push('!');
  }
  return lines;
}
