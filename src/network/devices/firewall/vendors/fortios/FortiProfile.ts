import { PREDEFINED_ADDRESSES, PREDEFINED_SERVICES } from './schema/predefined';
import type { RuleAction } from '../../model/SecurityRule';
import type { ZoneType } from '../../model/SecurityZone';
import type { FirewallProfile, FirewallPortSpec } from '../../FirewallProfile';

export const FORTIOS_PIPELINE: readonly string[] = Object.freeze([
  'ha-standby',
  'vdom-bind',
  'switch-bridge',
  'ingress-zone',
  'dos-policy',
  'session-lookup',
  'tcp-state-check',
  'nat-destination',
  'policy-route',
  'sdwan',
  'route-lookup',
  'ttl-decrement',
  'mtu-check',
  'egress-zone',
  'policy-lookup',
  'auth-check',
  'utm-inspect',
  'nat-source',
  'session-install',
]);

export const FORTIOS_TRANSPARENT_PIPELINE: readonly string[] = Object.freeze([
  'ha-standby',
  'vdom-bind',
  'switch-bridge',
  'ingress-zone',
  'dos-policy',
  'session-lookup',
  'tcp-state-check',
  'mac-lookup',
  'ttl-decrement',
  'mtu-check',
  'egress-zone',
  'policy-lookup',
  'auth-check',
  'utm-inspect',
  'session-install',
]);

const FORTIGATE_60F_PORTS: readonly FirewallPortSpec[] = Object.freeze([
  {
    name: 'port1', role: 'lan' as const,
    ip: '192.168.1.99', mask: '255.255.255.0',
    allowaccess: Object.freeze(['ping', 'https', 'ssh', 'http', 'fgfm']),
  },
  ...([2, 3, 4, 5, 6, 7] as const).map(n => ({
    name: `port${n}`, role: 'lan' as const,
  })),
  { name: 'wan1', role: 'wan' as const, allowaccess: Object.freeze(['ping']) },
  { name: 'wan2', role: 'wan' as const },
  { name: 'dmz', role: 'dmz' as const },
]);

export const FORTIOS_PROFILE: FirewallProfile = Object.freeze({
  vendor: 'fortios',
  displayName: 'Fortinet FortiGate',
  osName: 'fortios',
  defaultVersion: '7.6.3',
  predefinedAddresses: PREDEFINED_ADDRESSES,
  predefinedServices: PREDEFINED_SERVICES,

  pipeline: Object.freeze({
    nat: FORTIOS_PIPELINE,
    transparent: FORTIOS_TRANSPARENT_PIPELINE,
  }),
  natOrder: Object.freeze({
    destinationNatBeforePolicy: true,
    sourceNatBeforePolicy: false,
    policySeesPreNatSource: true,
    policySeesPreNatDestination: false,
    policySeesPostNatZone: true,
  }),
  applicationShift: false,
  selfTrafficHandling: 'local-in-policy',

  policyKeyedBy: 'interface',
  implicitPolicy: 'deny-all',
  implicitRuleEditable: false,
  supportedActions: Object.freeze<RuleAction[]>(['allow', 'deny']),
  supportsNegation: true,
  natIsPolicyField: true,

  zoneModel: 'both',
  defaultIntraZoneAction: 'deny',
  zoneTypes: Object.freeze<ZoneType[]>(['layer3', 'layer2']),

  objectsMandatoryInPolicy: true,
  maxGroupNesting: 10,

  timeouts: Object.freeze({
    tcpEstablished: 3600,
    tcpHandshake: 30,
    tcpTimeWait: 120,
    udp: 180,
    icmp: 60,
    other: 180,
  }),
  tcpSynCheckDefault: true,

  deploymentScope: 'device',
  configurationModel: 'immediate',
  virtualizationName: 'vdom',
  maxVirtualDomains: 10,
  logDisk: {
    label: 'Internal',
    model: 'Virtual disk',
    type: 'SSD',
    device: '/dev/sda',
    capacityBytes: 32 * 1000 ** 3,
    partitionRef: 3,
    partitionBytes: 31 * 1000 ** 3,
  },

  portPrefix: 'port',
  portCount: 8,
  portFirstIndex: 1,
  ports: FORTIGATE_60F_PORTS,

  chassis: Object.freeze({
    cpuCount: 1,
    memoryMb: 1985,
    firmwareMemoryMb: 210,
    packetsPerSecondPerCpu: 700_000,
  }),

  syslogCatalog: Object.freeze({
    'session-built': Object.freeze({ id: '0000000013', severity: 'notifications' as const }),
    'session-torn-down': Object.freeze({ id: '0000000014', severity: 'notifications' as const }),
    'policy-deny': Object.freeze({ id: '0000000015', severity: 'warnings' as const }),
  }),

});
