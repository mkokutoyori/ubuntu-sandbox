import type { FirewallLogDraft } from '../../../logging/FirewallLogStore';
import type { LocalTrafficFacts } from '../../../Firewall';
import { serviceLabel, TRAFFIC_LOGID_LOCAL, UNKNOWN_INTERFACE } from './trafficLog';

export function localTrafficLog(
  facts: LocalTrafficFacts, now: number, sessionId: number,
): FirewallLogDraft {
  const inbound = facts.kind !== 'local-out';
  const flow = facts.flow;

  return {
    at: now,
    type: 'traffic',
    subtype: 'local',
    level: 'notice',
    id: TRAFFIC_LOGID_LOCAL,
    fields: {
      sessionid: sessionId,
      srcip: flow.sourceIP,
      srcport: flow.sourcePort,
      srcintf: inbound ? facts.iface : UNKNOWN_INTERFACE,
      dstip: flow.destIP,
      dstport: flow.destPort,
      dstintf: inbound ? UNKNOWN_INTERFACE : facts.iface,
      proto: flow.protocol,
      action: facts.kind === 'local-in-allow' || facts.kind === 'local-out'
        ? 'accept' : 'deny',
      policyid: '0',
      policytype: 'local-in-policy',
      service: serviceLabel(flow.protocol, flow.destPort),
    },
  };
}
