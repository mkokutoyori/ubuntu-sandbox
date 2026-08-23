import type { FirewallLogDraft } from '../../../logging/FirewallLogStore';
import type { FirewallSession, SessionCloseReason } from '../../../session/SessionTable';
import type { SecurityRule } from '../../../model/SecurityRule';

export const TRAFFIC_LOGID_CLOSE = '0000000013';
export const TRAFFIC_LOGID_START = '0000000020';
export const TRAFFIC_LOGID_DENY = '0000000015';

const PROTOCOL_SERVICE: Readonly<Record<number, string>> = Object.freeze({
  1: 'PING', 6: 'tcp/', 17: 'udp/',
});

export interface LoggedIdentity {
  readonly user: string;
  readonly groups: readonly string[];
  readonly source: string;
  readonly server?: string;
}

export interface TrafficLogFacts {
  readonly session: FirewallSession;
  readonly rule?: SecurityRule;
  readonly now: number;
  readonly identity?: LoggedIdentity;
}

export function identityFields(
  identity: LoggedIdentity | undefined,
): Record<string, string> {
  if (!identity) return {};
  const fields: Record<string, string> = { user: identity.user };
  if (identity.groups.length > 0) fields.group = identity.groups.join(',');
  fields.authserver = identity.server ?? identity.source;
  return fields;
}

export function shouldLogTraffic(rule: SecurityRule | undefined): boolean {
  return rule?.logEnd === true;
}

export function shouldLogTrafficStart(rule: SecurityRule | undefined): boolean {
  return rule?.logStart === true;
}

export function trafficStartLog(facts: TrafficLogFacts): FirewallLogDraft {
  return {
    at: facts.now,
    type: 'traffic',
    subtype: 'forward',
    level: 'notice',
    id: TRAFFIC_LOGID_START,
    fields: { ...common(facts), action: 'start', duration: 0, sentbyte: 0, rcvdbyte: 0 },
  };
}

export function trafficCloseLog(
  facts: TrafficLogFacts, reason: SessionCloseReason,
): FirewallLogDraft {
  const session = facts.session;
  const duration = Math.max(0, Math.floor((facts.now - session.createdAt) / 1000));

  return {
    at: facts.now,
    type: 'traffic',
    subtype: 'forward',
    level: 'notice',
    id: TRAFFIC_LOGID_CLOSE,
    fields: {
      ...common(facts),
      action: closeAction(reason),
      duration,
      sentbyte: session.counters.bytesC2S,
      rcvdbyte: session.counters.bytesS2C,
      sentpkt: session.counters.packetsC2S,
      rcvdpkt: session.counters.packetsS2C,
    },
  };
}

export function trafficDenyLog(facts: {
  readonly now: number;
  readonly sourceIP: string;
  readonly sourcePort: number;
  readonly destIP: string;
  readonly destPort: number;
  readonly protocol: number;
  readonly ingressInterface: string;
  readonly egressInterface: string;
  readonly policyId: string;
  readonly identity?: LoggedIdentity;
}): FirewallLogDraft {
  return {
    at: facts.now,
    type: 'traffic',
    subtype: 'forward',
    level: 'warning',
    id: TRAFFIC_LOGID_DENY,
    fields: {
      srcip: facts.sourceIP,
      srcport: facts.sourcePort,
      srcintf: facts.ingressInterface,
      dstip: facts.destIP,
      dstport: facts.destPort,
      dstintf: facts.egressInterface,
      proto: facts.protocol,
      action: 'deny',
      policyid: facts.policyId,
      service: serviceLabel(facts.protocol, facts.destPort),
      sentbyte: 0,
      rcvdbyte: 0,
      ...identityFields(facts.identity),
    },
  };
}

function common(facts: TrafficLogFacts): Record<string, string | number> {
  const session = facts.session;
  const flow = session.c2s;
  const translation = session.translation;

  const fields: Record<string, string | number> = {
    sessionid: session.id,
    srcip: flow.sourceIP,
    srcport: flow.sourcePort,
    srcintf: session.ingressInterface,
    dstip: flow.destIP,
    dstport: flow.destPort,
    dstintf: session.egressInterface,
    proto: flow.protocol,
    policyid: facts.rule?.id ?? session.policyId ?? '0',
    policyname: facts.rule?.name ?? '',
    service: serviceLabel(flow.protocol, flow.destPort),
    ...identityFields(facts.identity),
  };

  if (translation === undefined) {
    fields.trandisp = 'noop';
    return fields;
  }

  const snat = translation.translatedSource !== translation.originalSource;
  const dnat = translation.translatedDest !== translation.originalDest;
  fields.trandisp = snat && dnat ? 'dnat+snat' : snat ? 'snat' : 'dnat';
  if (snat) {
    fields.transip = translation.translatedSource;
    fields.transport = translation.translatedSourcePort;
  }
  if (dnat) {
    fields.tranip = translation.translatedDest;
    fields.tranport = translation.translatedDestPort;
  }
  return fields;
}

function closeAction(reason: SessionCloseReason): string {
  if (reason === 'timeout') return 'timeout';
  if (reason === 'clear') return 'clear_session';
  return 'close';
}

function serviceLabel(protocol: number, port: number): string {
  const prefix = PROTOCOL_SERVICE[protocol];
  if (prefix === undefined) return `ip/${protocol}`;
  if (protocol === 1) return prefix;
  return `${prefix}${port}`;
}

export interface ConfigChangeFacts {
  readonly now: number;
  readonly action: 'Add' | 'Edit' | 'Delete';
  readonly path: readonly string[];
  readonly key?: string;
  readonly attributes: readonly string[];
  readonly user: string;
  readonly ui: string;
  readonly transactionId: number;
}

const CONFIG_LOGID = '0100044547';

export function configChangeLog(facts: ConfigChangeFacts): FirewallLogDraft {
  const cfgpath = facts.path.join('.');
  const object = facts.key === undefined ? '' : facts.key;
  const target = object.length > 0 ? `${cfgpath} ${object}` : cfgpath;

  return {
    at: facts.now,
    type: 'event',
    subtype: 'system',
    level: 'information',
    id: CONFIG_LOGID,
    fields: {
      logdesc: 'Object attribute configured',
      user: facts.user,
      ui: facts.ui,
      action: facts.action,
      cfgtid: facts.transactionId,
      cfgpath,
      cfgobj: object.length > 0 ? object : undefined,
      cfgattr: facts.attributes.length > 0 ? facts.attributes.join('|') : undefined,
      msg: `${facts.action} ${target}`,
    },
  };
}
