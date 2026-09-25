import { v, type SnmpValue } from '../../../../snmp/types';
import type { FirewallSnmpIdentity } from '../../mgmt/FirewallSnmp';

const FORTINET = '1.3.6.1.4.1.12356';
const FG_MODEL = `${FORTINET}.101.1`;
const FG_SYSTEM_INFO = `${FORTINET}.101.4.1`;
const FN_SYS_SERIAL = `${FORTINET}.100.1.1.1.0`;

const FG_MODEL_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  'FortiGate-VM64': 30,
});

const MEBIBYTE = 1024 * 1024;

export interface FortiSnmpFacts {
  model(): string;
  firmwareVersion(): string;
  managementVdomIndex(): number;
  cpuUsagePercent(): number;
  memory(): { readonly usedKib: number; readonly totalKib: number };
  logDisk(): { readonly usedBytes: number; readonly capacityBytes: number } | null;
  activeSessions(family: 'ipv4' | 'ipv6'): number;
  setupRate(minutes: number): number;
  uptimeHundredths(): number;
  serial(): string;
}

export function fortiGateSnmpIdentity(facts: FortiSnmpFacts): FirewallSnmpIdentity {
  const modelNumber = FG_MODEL_NUMBERS[facts.model()];
  const objects = new Map<string, () => SnmpValue>([
    [FN_SYS_SERIAL, () => v('octet-string', facts.serial())],
    [`${FG_SYSTEM_INFO}.1.0`, () => v('octet-string', facts.firmwareVersion())],
    [`${FG_SYSTEM_INFO}.2.0`, () => v('integer', facts.managementVdomIndex())],
    [`${FG_SYSTEM_INFO}.3.0`, () => v('gauge32', facts.cpuUsagePercent())],
    [`${FG_SYSTEM_INFO}.4.0`, () => {
      const memory = facts.memory();
      return v('gauge32', Math.round((memory.usedKib / memory.totalKib) * 100));
    }],
    [`${FG_SYSTEM_INFO}.5.0`, () => v('gauge32', facts.memory().totalKib)],
    [`${FG_SYSTEM_INFO}.8.0`, () => v('gauge32', facts.activeSessions('ipv4'))],
    [`${FG_SYSTEM_INFO}.11.0`, () => v('gauge32', facts.setupRate(1))],
    [`${FG_SYSTEM_INFO}.12.0`, () => v('gauge32', facts.setupRate(10))],
    [`${FG_SYSTEM_INFO}.13.0`, () => v('gauge32', facts.setupRate(30))],
    [`${FG_SYSTEM_INFO}.14.0`, () => v('gauge32', facts.setupRate(60))],
    [`${FG_SYSTEM_INFO}.15.0`, () => v('gauge32', facts.activeSessions('ipv6'))],
    [`${FG_SYSTEM_INFO}.20.0`, () => v('counter64', facts.uptimeHundredths())],
  ]);
  if (facts.logDisk() !== null) {
    objects.set(`${FG_SYSTEM_INFO}.6.0`,
      () => v('gauge32', Math.floor((facts.logDisk()?.usedBytes ?? 0) / MEBIBYTE)));
    objects.set(`${FG_SYSTEM_INFO}.7.0`,
      () => v('gauge32', Math.floor((facts.logDisk()?.capacityBytes ?? 0) / MEBIBYTE)));
  }
  return {
    sysObjectId: modelNumber === undefined ? FG_MODEL : `${FG_MODEL}.${modelNumber}`,
    objects,
  };
}
