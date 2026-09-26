import { IPAddress, SubnetMask } from '../../../../../core/types';
import { PortNumber } from '../../../../../core/ports/PortNumber';
import {
  SNMP_TRAP_EVENTS, type SnmpInterfaceSelectMethod, type SnmpManagerHost, type SnmpManagerHostType,
  type SnmpTrapChannel, type SnmpTrapEvent,
} from '../../../mgmt/FirewallSnmp';
import {
  address, addressMask, choice, count, enable, reference, refList, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';

const TRAP_EVENT_HELP: Readonly<Record<SnmpTrapEvent, string>> = Object.freeze({
  'cpu-high': 'Send a trap when CPU usage is high.',
  'mem-low': 'Send a trap when used memory is high, free memory is low, or freeable memory is high.',
  'log-full': 'Send a trap when log disk space becomes low.',
  'intf-ip': 'Send a trap when an interface IP address is changed.',
  'vpn-tun-up': 'Send a trap when a VPN tunnel comes up.',
  'vpn-tun-down': 'Send a trap when a VPN tunnel goes down.',
  'ha-switch': 'Send a trap after an HA failover when the backup unit has taken over.',
  'ha-hb-failure': 'Send a trap when HA heartbeats are not received.',
  'ips-signature': 'Send a trap when IPS detects an attack.',
  'ips-anomaly': 'Send a trap when IPS finds an anomaly.',
  'av-virus': 'Send a trap when AntiVirus finds a virus.',
  'av-oversize': 'Send a trap when AntiVirus finds an oversized file.',
  'av-pattern': 'Send a trap when AntiVirus finds file matching pattern.',
  'av-fragmented': 'Send a trap when AntiVirus finds a fragmented file.',
  'fm-if-change': 'Send a trap when FortiManager interface changes. Send a FortiManager trap.',
  'fm-conf-change': 'Send a trap when a configuration change is made by a FortiGate administrator '
    + 'and the FortiGate is managed by FortiManager.',
  'bgp-established': 'Send a trap when a BGP FSM transitions to the established state.',
  'bgp-backward-transition': 'Send a trap when a BGP FSM goes from a high numbered state to a lower numbered state.',
  'ha-member-up': 'Send a trap when an HA cluster member goes up.',
  'ha-member-down': 'Send a trap when an HA cluster member goes down.',
  'ent-conf-change': 'Send a trap when an entity MIB change occurs (RFC4133).',
  'av-conserve': 'Send a trap when the FortiGate enters conserve mode.',
  'av-bypass': 'Send a trap when the FortiGate enters bypass mode.',
  'av-oversize-passed': 'Send a trap when AntiVirus passes an oversized file.',
  'av-oversize-blocked': 'Send a trap when AntiVirus blocks an oversized file.',
  'ips-pkg-update': 'Send a trap when the IPS signature database or engine is updated.',
  'ips-fail-open': 'Send a trap when the IPS network buffer is full.',
  'temperature-high': 'Send a trap when a temperature sensor registers a temperature that is too high.',
  'voltage-alert': 'Send a trap when a voltage sensor registers a voltage that is outside of the normal range.',
  'power-supply': 'Send a trap when a power supply fails or restores.',
  'faz-disconnect': 'Send a trap when a FortiAnalyzer disconnects from the FortiGate.',
  'faz': 'Send a trap when Fortianalyzer main server failover and alternate server take over, '
    + 'or alternate server failover and main server take over.',
  'fan-failure': 'Send a trap when a fan fails.',
  'wc-ap-up': 'Send a trap when a managed FortiAP comes up.',
  'wc-ap-down': 'Send a trap when a managed FortiAP goes down.',
  'fswctl-session-up': 'Send a trap when a FortiSwitch controller session comes up.',
  'fswctl-session-down': 'Send a trap when a FortiSwitch controller session goes down.',
  'load-balance-real-server-down': 'Send a trap when a server load balance real server goes down.',
  'device-new': 'Send a trap when a new device is found.',
  'per-cpu-high': 'Send a trap when per-CPU usage is high.',
  'dhcp': 'Send a trap when the DHCP server exhausts the IP pool, an IP address already is in use, '
    + 'or a DHCP client interface received a DHCP-NAK.',
  'pool-usage': 'Send a trap about ippool usage.',
  'ippool': 'Send a trap for ippool events.',
  'interface': 'Send a trap for interface event.',
  'ospf-nbr-state-change': 'Send a trap when there has been a change in the state of a non-virtual OSPF neighbor.',
  'ospf-virtnbr-state-change': 'Send a trap when there has been a change in the state of an OSPF virtual neighbor.',
  'enter-intf-bypass': 'Enter interface bypass mode.',
  'exit-intf-bypass': 'Exit interface bypass mode.',
  'dio': 'Send a trap when a digital io event happens.',
});

const EVENTS_OFF_BY_DEFAULT: readonly SnmpTrapEvent[] = Object.freeze([
  'fm-conf-change', 'device-new', 'enter-intf-bypass', 'exit-intf-bypass', 'dio',
]);

const DEFAULT_TRAP_EVENTS: readonly string[] = Object.freeze(
  SNMP_TRAP_EVENTS.filter((event) => !EVENTS_OFF_BY_DEFAULT.includes(event)));

const PERCENT_MIN = 1;
const PERCENT_MAX = 100;

function percent(object: FortiObjectView, attribute: string, byDefault: number): number {
  return Number.parseInt(object.effective(attribute)[0] ?? String(byDefault), 10);
}

export const SYSTEM_SNMP_SYSINFO: FortiTableSpec = {
  path: ['system', 'snmp', 'sysinfo'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 80,
  help: 'SNMP system info configuration.',
  attributes: [
    text('contact-info', 'Contact information.'),
    text('description', 'System description.'),
    text('location', 'System location.'),
    enable('status', 'Enable/disable SNMP.'),
    count('trap-free-memory-threshold', 'Free memory usage when trap is sent.', PERCENT_MIN, PERCENT_MAX, 5),
    count('trap-freeable-memory-threshold', 'Freeable memory usage when trap is sent.',
      PERCENT_MIN, PERCENT_MAX, 60),
    count('trap-high-cpu-threshold', 'CPU usage when trap is sent.', PERCENT_MIN, PERCENT_MAX, 80),
    count('trap-log-full-threshold', 'Log disk usage when trap is sent.', PERCENT_MIN, PERCENT_MAX, 90),
    count('trap-low-memory-threshold', 'Memory usage when trap is sent.', PERCENT_MIN, PERCENT_MAX, 80),
  ],
  onCommit(object, context) {
    context.device.applySnmpSysinfo({
      enabled: object.effective('status')[0] === 'enable',
      description: object.effective('description')[0] ?? '',
      contactInfo: object.effective('contact-info')[0] ?? '',
      location: object.effective('location')[0] ?? '',
      thresholds: {
        freeMemoryPercent: percent(object, 'trap-free-memory-threshold', 5),
        freeableMemoryPercent: percent(object, 'trap-freeable-memory-threshold', 60),
        highCpuPercent: percent(object, 'trap-high-cpu-threshold', 80),
        logFullPercent: percent(object, 'trap-log-full-threshold', 90),
        lowMemoryPercent: percent(object, 'trap-low-memory-threshold', 80),
      },
    });
  },
};

const MIB_VIEW_MAX_INCLUDES = 16;
const MIB_VIEW_MAX_EXCLUDES = 64;
const OBJECT_IDENTIFIER = /^\.?\d+(\.\d+)*$/;

function subtrees(values: readonly string[]): string[] {
  return values.map((value) => value.replace(/^\./, ''));
}

export const SYSTEM_SNMP_MIB_VIEW: FortiTableSpec = {
  path: ['system', 'snmp', 'mib-view'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 81,
  help: 'SNMP Access Control MIB View configuration.',
  attributes: [
    { ...word('name', 'MIB view name.'), readOnly: true },
    { ...word('exclude', 'OID subtrees to be excluded in the view. Maximum 64 allowed.'), multiValue: true, defaultValue: [] },
    { ...word('include', 'OID subtrees to be included in the view. Maximum 16 allowed.'), multiValue: true, defaultValue: [] },
  ],
  onCommit(object, context) {
    const include = object.effective('include');
    const exclude = object.effective('exclude');
    if (include.length > MIB_VIEW_MAX_INCLUDES) return `a MIB view includes at most ${MIB_VIEW_MAX_INCLUDES} subtrees.`;
    if (exclude.length > MIB_VIEW_MAX_EXCLUDES) return `a MIB view excludes at most ${MIB_VIEW_MAX_EXCLUDES} subtrees.`;
    const invalid = [...include, ...exclude].find((oid) => !OBJECT_IDENTIFIER.test(oid));
    if (invalid !== undefined) return `invalid OID "${invalid}".`;
    context.device.applySnmpMibView({
      name: object.key, include: subtrees(include), exclude: subtrees(exclude),
    });
  },
  onDelete(key, context) {
    context.device.removeSnmpMibView(key);
  },
};

const SNMP_COMMUNITY_HOSTS: FortiTableSpec = {
  path: ['hosts'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 83,
  help: 'Configure IPv4 SNMP managers (hosts).',
  attributes: [
    { ...word('id', 'Host entry ID.'), readOnly: true },
    enable('ha-direct', 'Enable/disable direct management of HA cluster members.'),
    choice('host-type', 'Control whether the SNMP manager sends SNMP queries, receives SNMP traps, or both.', [
      { keyword: 'any', description: 'Accept queries from and send traps to this SNMP manager.' },
      { keyword: 'query', description: 'Accept queries from this SNMP manager but do not send traps.' },
      {
        keyword: 'trap',
        description: 'Send traps to this SNMP manager but do not accept SNMP queries from this SNMP manager.',
      },
    ], 'any'),
    {
      ...reference('interface', 'Specify outgoing interface to reach server.', ['system interface']),
      availableWhen: (object) => object.effective('interface-select-method')[0] === 'specify',
    },
    choice('interface-select-method', 'Specify how to select outgoing interface to reach server.', [
      { keyword: 'auto', description: 'Set outgoing interface automatically.' },
      { keyword: 'sdwan', description: 'Set outgoing interface by SD-WAN or policy routing rules.' },
      { keyword: 'specify', description: 'Set outgoing interface manually.' },
    ], 'auto'),
    addressMask('ip', 'IPv4 address of the SNMP manager (host).', ['0.0.0.0', '0.0.0.0']),
    address('source-ip', 'Source IPv4 address for SNMP traps.', '0.0.0.0'),
    count('vrf-select', 'VRF ID used for connection to server.', 0, 511, 0),
  ],
};

const UNSET_ADDRESS = '0.0.0.0';

function managerHosts(object: FortiObjectView): SnmpManagerHost[] {
  return object.childEntries('hosts').map((entry) => {
    const [ip, mask] = entry.effective('ip');
    const source = entry.effective('source-ip')[0] ?? UNSET_ADDRESS;
    const method = (entry.effective('interface-select-method')[0] ?? 'auto') as SnmpInterfaceSelectMethod;
    return {
      id: entry.key,
      address: new IPAddress(ip ?? UNSET_ADDRESS),
      mask: new SubnetMask(mask ?? UNSET_ADDRESS),
      hostType: (entry.effective('host-type')[0] ?? 'any') as SnmpManagerHostType,
      haDirect: entry.effective('ha-direct')[0] === 'enable',
      source: source === UNSET_ADDRESS ? null : new IPAddress(source),
      interfaceSelectMethod: method,
      iface: method === 'specify' ? entry.effective('interface')[0] ?? null : null,
      vrf: Number.parseInt(entry.effective('vrf-select')[0] ?? '0', 10),
    };
  });
}

function trapChannel(object: FortiObjectView, version: 'v1' | 'v2c'): SnmpTrapChannel {
  return {
    enabled: object.effective(`trap-${version}-status`)[0] === 'enable',
    localPort: PortNumber.of(Number.parseInt(object.effective(`trap-${version}-lport`)[0] ?? '162', 10)),
    remotePort: PortNumber.of(Number.parseInt(object.effective(`trap-${version}-rport`)[0] ?? '162', 10)),
  };
}

function queryPort(object: FortiObjectView, attribute: string): PortNumber {
  return PortNumber.of(Number.parseInt(object.effective(attribute)[0] ?? '161', 10));
}

export const SYSTEM_SNMP_COMMUNITY: FortiTableSpec = {
  path: ['system', 'snmp', 'community'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 82,
  help: 'SNMP community configuration.',
  attributes: [
    { ...word('id', 'Community ID.'), readOnly: true },
    reference('mib-view', 'SNMP access control MIB view.', ['system snmp mib-view']),
    word('name', 'Community name.'),
    count('query-v1-port', 'SNMP v1 query port (default = 161).', 1, 65535, 161),
    enable('query-v1-status', 'Enable/disable SNMP v1 queries.', true),
    count('query-v2c-port', 'SNMP v2c query port (default = 161).', 0, 65535, 161),
    enable('query-v2c-status', 'Enable/disable SNMP v2c queries.', true),
    enable('status', 'Enable/disable this SNMP community.', true),
    {
      name: 'events',
      help: 'SNMP trap events.',
      quoted: false,
      multiValue: true,
      parts: [{
        name: 'events', type: 'ENUM', description: 'SNMP trap event.',
        values: SNMP_TRAP_EVENTS.map((event) => ({ keyword: event, description: TRAP_EVENT_HELP[event] })),
      }],
      defaultValue: DEFAULT_TRAP_EVENTS,
    },
    count('trap-v1-lport', 'SNMP v1 trap local port (default = 162).', 1, 65535, 162),
    count('trap-v1-rport', 'SNMP v1 trap remote port (default = 162).', 1, 65535, 162),
    enable('trap-v1-status', 'Enable/disable SNMP v1 traps.', true),
    count('trap-v2c-lport', 'SNMP v2c trap local port (default = 162).', 1, 65535, 162),
    count('trap-v2c-rport', 'SNMP v2c trap remote port (default = 162).', 1, 65535, 162),
    enable('trap-v2c-status', 'Enable/disable SNMP v2c traps.', true),
    refList('vdoms', 'SNMP access control VDOMs.', ['vdom']),
  ],
  children: [SNMP_COMMUNITY_HOSTS],
  maxEntries: () => 3,
  onCommit(object, context) {
    context.device.applySnmpCommunity({
      id: object.key,
      name: object.effective('name')[0] ?? '',
      enabled: object.effective('status')[0] === 'enable',
      hosts: managerHosts(object),
      queryV1: {
        enabled: object.effective('query-v1-status')[0] === 'enable',
        port: queryPort(object, 'query-v1-port'),
      },
      queryV2c: {
        enabled: object.effective('query-v2c-status')[0] === 'enable',
        port: queryPort(object, 'query-v2c-port'),
      },
      mibView: object.effective('mib-view')[0] ?? '',
      vdoms: [...object.effective('vdoms')],
      events: object.effective('events') as readonly SnmpTrapEvent[],
      trapV1: trapChannel(object, 'v1'),
      trapV2c: trapChannel(object, 'v2c'),
    });
  },
  onDelete(key, context) {
    context.device.removeSnmpCommunity(key);
  },
};

export const SNMP_SPECS: readonly FortiTableSpec[] = [
  SYSTEM_SNMP_SYSINFO, SYSTEM_SNMP_MIB_VIEW, SYSTEM_SNMP_COMMUNITY,
];
