import { newProtocolCounters, tcpTotals, type ProtocolCounters } from './ProtocolCounters';

export interface SnmpSnapshot {
  counters: ProtocolCounters;
  currEstab: number;
}

export function snmpSnapshot(counters?: ProtocolCounters): SnmpSnapshot {
  return {
    counters: counters ?? newProtocolCounters(),
    currEstab: counters === undefined ? 0 : tcpTotals(counters).CurrEstab,
  };
}
