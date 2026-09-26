import {
  OID_IF_ADMIN_STATUS_PREFIX, OID_IF_INDEX_PREFIX, OID_IF_NAME_PREFIX, OID_IF_OPER_STATUS_PREFIX,
  OID_SYS_NAME, v, vb, type SnmpValue, type SnmpVarBinding,
} from '../../../../snmp/types';
import { OID_LINK_DOWN, OID_LINK_UP, type SnmpNotification } from '../../../../snmp/SnmpNotification';
import { OID_BGP_ESTABLISHED_NOTIFICATION, bgpPeerNotification } from '../../../../snmp/Bgp4MibNotifications';
import { ospfNbrStateChange } from '../../../../snmp/OspfTrapMibNotifications';
import type { IPAddress } from '../../../../core/types';
import type {
  FirewallSnmpIdentity, FirewallTrap, FirewallTrapContext, FirewallTrapFact, MemoryTrapCondition,
  SnmpTrapEvent,
} from '../../mgmt/FirewallSnmp';

const FORTINET = '1.3.6.1.4.1.12356';
const FG_MODEL = `${FORTINET}.101.1`;
const FG_SYSTEM_INFO = `${FORTINET}.101.4.1`;
const FN_SYS_SERIAL = `${FORTINET}.100.1.1.1.0`;
const FN_TRAPS = `${FORTINET}.100.1.3.0`;
const FN_GEN_TRAP_MSG = `${FORTINET}.100.1.3.1.1`;
const FG_TRAPS = `${FORTINET}.101.2.0`;
const FG_MANAGEMENT_TRAPS = `${FORTINET}.101.6.0`;
const FG_MANAGEMENT_TRAP_OBJECTS = `${FORTINET}.101.6.2`;
const FG_ANTIVIRUS_TRAP_OBJECTS = `${FORTINET}.101.8.3`;
const FG_IPS_TRAP_OBJECTS = `${FORTINET}.101.9.3`;
const FG_VPN_TRAP_OBJECTS = `${FORTINET}.101.12.3`;
const FG_LOAD_BALANCE_TRAP_OBJECTS = `${FORTINET}.101.16.1`;
const ENT_CONFIG_CHANGE = '1.3.6.1.2.1.47.2.0.1';
const IPV6_ADDRESS_OCTETS = 16;
const UNSPECIFIED_ADDRESS = '0.0.0.0';

const MEMORY_MESSAGES: Readonly<Record<MemoryTrapCondition, string | null>> = Object.freeze({
  'used-high': null,
  'free-low': 'free memory percentage is too low',
  'freeable-high': 'freeable memory percentage is too high',
});

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

function trap(event: SnmpTrapEvent | null, oid: string, objects: readonly SnmpVarBinding[]): FirewallTrap {
  const notification: SnmpNotification = { oid, objects };
  return { event, notification };
}

function instances(context: FirewallTrapContext, oids: readonly string[]): SnmpVarBinding[] {
  return oids.flatMap((oid) => {
    const value = context.value(oid);
    return value === null ? [] : [vb(oid, value)];
  });
}

function ipv6Octets(address: { getHextets(): number[] } | null): Uint8Array {
  const octets = new Uint8Array(IPV6_ADDRESS_OCTETS);
  address?.getHextets().forEach((hextet, index) => {
    octets[index * 2] = hextet >> 8;
    octets[index * 2 + 1] = hextet & 0xff;
  });
  return octets;
}

function address(value: IPAddress): SnmpValue {
  return v('ipv4', value.toString());
}

export function fortiGateTraps(fact: FirewallTrapFact, context: FirewallTrapContext): readonly FirewallTrap[] {
  const sender = instances(context, [FN_SYS_SERIAL, OID_SYS_NAME]);
  switch (fact.kind) {
    case 'link': {
      const index = context.interfaceIndex(fact.port);
      if (index === null) return [];
      return [trap(null, fact.up ? OID_LINK_UP : OID_LINK_DOWN, [
        ...instances(context, [
          `${OID_IF_INDEX_PREFIX}.${index}`, `${OID_IF_ADMIN_STATUS_PREFIX}.${index}`,
          `${OID_IF_OPER_STATUS_PREFIX}.${index}`,
        ]),
        ...sender,
      ])];
    }
    case 'interface-address': {
      const index = context.interfaceIndex(fact.port);
      const port = context.port(fact.port);
      if (index === null || port === undefined) return [];
      return [
        trap('intf-ip', `${FN_TRAPS}.201`, [...sender, ...instances(context, [`${OID_IF_INDEX_PREFIX}.${index}`])]),
        trap('fm-if-change', `${FG_MANAGEMENT_TRAPS}.1004`, [
          ...instances(context, [FN_SYS_SERIAL, `${OID_IF_NAME_PREFIX}.${index}`]),
          vb(`${FG_MANAGEMENT_TRAP_OBJECTS}.1.0`, v('ipv4', port.getIPAddress()?.toString() ?? UNSPECIFIED_ADDRESS)),
          vb(`${FG_MANAGEMENT_TRAP_OBJECTS}.2.0`, v('ipv4', port.getSubnetMask()?.toString() ?? UNSPECIFIED_ADDRESS)),
          vb(`${FG_MANAGEMENT_TRAP_OBJECTS}.3.0`, v('octet-string', ipv6Octets(port.getGlobalIPv6()))),
        ]),
        trap('ent-conf-change', ENT_CONFIG_CHANGE, []),
      ];
    }
    case 'cpu-high':
      return [trap('cpu-high', `${FN_TRAPS}.101`, sender)];
    case 'memory': {
      const message = MEMORY_MESSAGES[fact.condition];
      return [trap('mem-low', `${FN_TRAPS}.102`, [
        ...sender, ...(message === null ? [] : [vb(FN_GEN_TRAP_MSG, v('octet-string', message))]),
      ])];
    }
    case 'log-disk-full':
      return [trap('log-full', `${FN_TRAPS}.103`, sender)];
    case 'vpn-tunnel':
      return [trap(fact.up ? 'vpn-tun-up' : 'vpn-tun-down', `${FG_TRAPS}.${fact.up ? 301 : 302}`, [
        ...sender,
        vb(`${FG_VPN_TRAP_OBJECTS}.2.0`, address(fact.local)),
        vb(`${FG_VPN_TRAP_OBJECTS}.3.0`, address(fact.remote)),
        vb(`${FG_VPN_TRAP_OBJECTS}.4.0`, v('octet-string', fact.phase1)),
      ])];
    case 'ha-switch':
      return [trap('ha-switch', `${FG_TRAPS}.401`, sender)];
    case 'ha-heartbeat-failure':
      return [trap('ha-hb-failure', `${FG_TRAPS}.403`, instances(context, [FN_SYS_SERIAL]))];
    case 'ha-member':
      return [trap(fact.up ? 'ha-member-up' : 'ha-member-down', `${FG_TRAPS}.${fact.up ? 405 : 404}`, [
        vb(FN_SYS_SERIAL, v('octet-string', fact.serial)),
      ])];
    case 'conserve-entered':
      return [trap('av-conserve', `${FG_TRAPS}.605`, sender)];
    case 'real-server-down':
      return [trap('load-balance-real-server-down', `${FG_TRAPS}.1101`, [
        ...sender,
        vb(`${FG_LOAD_BALANCE_TRAP_OBJECTS}.1.0`, address(fact.server)),
        vb(`${FG_LOAD_BALANCE_TRAP_OBJECTS}.2.0`, v('octet-string', fact.virtualServer)),
        vb(`${FG_LOAD_BALANCE_TRAP_OBJECTS}.3.0`, v('octet-string', ipv6Octets(null))),
      ])];
    case 'anomaly':
      return [trap('ips-anomaly', `${FG_TRAPS}.504`, [
        ...sender,
        vb(`${FG_IPS_TRAP_OBJECTS}.1.0`, v('integer', fact.signatureId)),
        vb(`${FG_IPS_TRAP_OBJECTS}.2.0`, address(fact.source)),
        vb(`${FG_IPS_TRAP_OBJECTS}.3.0`, v('octet-string', fact.anomaly)),
      ])];
    case 'virus':
      return [trap('av-virus', `${FG_TRAPS}.601`, [
        ...sender, vb(`${FG_ANTIVIRUS_TRAP_OBJECTS}.1.0`, v('octet-string', fact.name)),
      ])];
    case 'oversize':
      return [
        trap('av-oversize', `${FG_TRAPS}.602`, sender),
        fact.blocked
          ? trap('av-oversize-blocked', `${FG_TRAPS}.608`, sender)
          : trap('av-oversize-passed', `${FG_TRAPS}.607`, sender),
      ];
    case 'av-bypass':
      return [trap('av-bypass', `${FG_TRAPS}.606`, sender)];
    case 'ips-fail-open':
      return [trap('ips-fail-open', `${FG_TRAPS}.506`, sender)];
    case 'bgp-peer': {
      const notification = bgpPeerNotification(fact.transition);
      if (notification === null) return [];
      const established = notification.oid === OID_BGP_ESTABLISHED_NOTIFICATION;
      return [{ event: established ? 'bgp-established' : 'bgp-backward-transition', notification }];
    }
    case 'ospf-neighbor': {
      const notification = ospfNbrStateChange(fact.transition);
      return notification === null ? [] : [{ event: 'ospf-nbr-state-change', notification }];
    }
  }
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
    traps: fortiGateTraps,
  };
}
