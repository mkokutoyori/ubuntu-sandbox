import type { IpSlaEngine, SlaOperationRuntime } from '../../ipsla/IpSlaEngine';
import { SENSE_OF_RETURN_CODE, type SlaOperationType } from '../../ipsla/types';
import { averageRtt } from '../../ipsla/statistics';
import { v, type SnmpValue } from '../types';

export const RTT_MON_CTRL_ADMIN = '1.3.6.1.4.1.9.9.42.1.2.1.1';
export const RTT_MON_ECHO_ADMIN = '1.3.6.1.4.1.9.9.42.1.2.2.1';
export const RTT_MON_CTRL_OPER = '1.3.6.1.4.1.9.9.42.1.2.9.1';
export const RTT_MON_LATEST_RTT_OPER = '1.3.6.1.4.1.9.9.42.1.2.10.1';
export const RTT_MON_JITTER_STATS = '1.3.6.1.4.1.9.9.42.1.5.2.1';

const RTT_TYPE_CODES: Record<SlaOperationType, number> = {
  'icmp-echo': 1,
  'path-echo': 2,
  'udp-echo': 5,
  'tcp-connect': 6,
  'http': 7,
  'dns': 8,
  'udp-jitter': 9,
  'icmp-jitter': 17,
  unknown: 0,
};

const OPER_STATE_CODES = { active: 1, pending: 2, inactive: 3 } as const;

export interface MibRegistrar {
  (oid: string, read: () => SnmpValue): void;
}

/**
 * Projection CISCO-RTTMON-MIB.
 *
 * Chaque OID est un accesseur PARESSEUX sur l'état vivant du moteur, pas
 * une copie prise à l'enregistrement : un `snmpget` répond la mesure de
 * l'instant, comme sur un vrai routeur, et il n'y a rien à resynchroniser
 * après chaque sonde.
 */
export function registerRttMonOperation(
  register: MibRegistrar,
  engine: IpSlaEngine,
  operationId: number,
): void {
  const runtime = (): SlaOperationRuntime | undefined => engine.getOperation(operationId);
  const at = (base: string, column: number) => `${base}.${column}.${operationId}`;

  register(at(RTT_MON_CTRL_ADMIN, 2), () =>
    v('octet-string', runtime()?.config.owner ?? ''));
  register(at(RTT_MON_CTRL_ADMIN, 3), () =>
    v('octet-string', runtime()?.config.tag ?? ''));
  register(at(RTT_MON_CTRL_ADMIN, 4), () =>
    v('integer', RTT_TYPE_CODES[runtime()?.config.type ?? 'unknown']));
  register(at(RTT_MON_CTRL_ADMIN, 5), () =>
    v('integer', runtime()?.config.thresholdMs ?? 0));
  register(at(RTT_MON_CTRL_ADMIN, 6), () =>
    v('integer', runtime()?.config.frequencySeconds ?? 0));
  register(at(RTT_MON_CTRL_ADMIN, 7), () =>
    v('integer', runtime()?.config.timeoutMs ?? 0));
  register(at(RTT_MON_CTRL_ADMIN, 9), () =>
    v('integer', runtime() ? 1 : 2));

  register(at(RTT_MON_ECHO_ADMIN, 2), () =>
    v('octet-string', runtime()?.config.target ?? ''));
  register(at(RTT_MON_ECHO_ADMIN, 3), () =>
    v('integer', runtime()?.config.requestDataSize ?? 0));

  register(at(RTT_MON_CTRL_OPER, 2), () =>
    v('octet-string', runtime()?.lastDiagText ?? ''));
  register(at(RTT_MON_CTRL_OPER, 5), () =>
    v('integer', (runtime()?.counters.connectionLosses ?? 0) > 0 ? 1 : 2));
  register(at(RTT_MON_CTRL_OPER, 6), () =>
    v('integer', (runtime()?.counters.timeouts ?? 0) > 0 ? 1 : 2));
  register(at(RTT_MON_CTRL_OPER, 7), () =>
    v('integer', (runtime()?.counters.overThresholds ?? 0) > 0 ? 1 : 2));
  register(at(RTT_MON_CTRL_OPER, 8), () =>
    v('counter32', runtime()?.aggregate.numRtts ?? 0));
  register(at(RTT_MON_CTRL_OPER, 10), () =>
    v('integer', OPER_STATE_CODES[runtime()?.state ?? 'pending']));
  register(at(RTT_MON_CTRL_OPER, 11), () =>
    v('integer', (runtime()?.counters.verifyErrors ?? 0) > 0 ? 1 : 2));

  register(at(RTT_MON_LATEST_RTT_OPER, 1), () =>
    v('gauge32', Math.round(runtime()?.lastRttMs ?? 0)));
  register(at(RTT_MON_LATEST_RTT_OPER, 2), () => {
    const code = runtime()?.lastReturnCode;
    return v('integer', code ? SENSE_OF_RETURN_CODE[code] : 0);
  });
  register(at(RTT_MON_LATEST_RTT_OPER, 4), () =>
    v('octet-string', runtime()?.lastDiagText ?? ''));
  register(at(RTT_MON_LATEST_RTT_OPER, 6), () =>
    v('octet-string', runtime()?.lastRespondingAddress ?? ''));

  register(at(RTT_MON_JITTER_STATS, 5), () =>
    v('gauge32', Math.round(averageRtt(runtime()?.aggregate
      ?? { numRtts: 0, sumRtt: 0, minRtt: null, maxRtt: null }))));
  register(at(RTT_MON_JITTER_STATS, 26), () =>
    v('counter32', runtime()?.jitter.packetLossSD ?? 0));
  register(at(RTT_MON_JITTER_STATS, 27), () =>
    v('counter32', runtime()?.jitter.packetLossDS ?? 0));
  register(at(RTT_MON_JITTER_STATS, 28), () =>
    v('counter32', runtime()?.jitter.packetOutOfSequence ?? 0));
  register(at(RTT_MON_JITTER_STATS, 29), () =>
    v('counter32', runtime()?.jitter.packetMIA ?? 0));
  register(at(RTT_MON_JITTER_STATS, 30), () =>
    v('counter32', runtime()?.jitter.packetLateArrival ?? 0));
  register(at(RTT_MON_JITTER_STATS, 43), () =>
    v('gauge32', runtime()?.emodel ? Math.round(runtime()!.emodel!.icpif) : 0));
  register(at(RTT_MON_JITTER_STATS, 44), () =>
    v('gauge32', runtime()?.emodel ? Math.round(runtime()!.emodel!.mos * 100) : 0));
}
