import type { RuleAction } from '../../model/SecurityRule';
import type { ZoneType } from '../../model/SecurityZone';
import type { FirewallProfile } from '../../FirewallProfile';

export const ASA_PIPELINE: readonly string[] = Object.freeze([
  'vdom-bind',
  'ingress-zone',
  'session-lookup',
  'tcp-state-check',
  'nat-destination',
  'route-lookup',
  'ttl-decrement',
  'mtu-check',
  'egress-zone',
  'policy-lookup',
  'nat-source',
  'session-install',
]);

export const ASA_PROFILE: FirewallProfile = Object.freeze({
  vendor: 'asa',
  displayName: 'Cisco Secure Firewall ASA',
  osName: 'asa',
  defaultVersion: '9.16(1)',

  pipeline: Object.freeze({ nat: ASA_PIPELINE, transparent: ASA_PIPELINE }),
  natOrder: Object.freeze({
    destinationNatBeforePolicy: true,
    sourceNatBeforePolicy: false,
    policySeesPreNatSource: true,
    policySeesPreNatDestination: false,
    policySeesPostNatZone: true,
  }),
  applicationShift: false,
  selfTrafficHandling: 'control-plane-acl',

  policyKeyedBy: 'interface',
  implicitPolicy: 'security-level',
  implicitRuleEditable: false,
  supportedActions: Object.freeze<RuleAction[]>(['allow', 'deny']),
  supportsNegation: false,
  natIsPolicyField: false,

  zoneModel: 'both',
  defaultIntraZoneAction: 'deny',
  zoneTypes: Object.freeze<ZoneType[]>(['layer3', 'layer2']),

  objectsMandatoryInPolicy: false,
  maxGroupNesting: 10,

  timeouts: Object.freeze({
    tcpEstablished: 3600,
    tcpHandshake: 30,
    tcpTimeWait: 120,
    udp: 120,
    icmp: 2,
    other: 120,
  }),
  tcpSynCheckDefault: true,

  deploymentScope: 'device',
  configurationModel: 'immediate',
  virtualizationName: 'context',

  portPrefix: 'GigabitEthernet0/',
  portCount: 8,
  portFirstIndex: 0,

  chassis: Object.freeze({
    cpuCount: 1,
    memoryMb: 8192,
    firmwareMemoryMb: 1024,
    packetsPerSecondPerCpu: 1_000_000,
  }),

  syslogCatalog: Object.freeze({
    'session-built': Object.freeze({ id: '302013', severity: 'informational' as const }),
    'session-torn-down': Object.freeze({ id: '302014', severity: 'informational' as const }),
    'policy-deny': Object.freeze({ id: '106023', severity: 'warnings' as const }),
    'translation-created': Object.freeze({ id: '305011', severity: 'informational' as const }),
  }),

});

export const ASA_NAT_SECTIONS = Object.freeze({
  manual: 1,
  auto: 2,
  autoAfter: 3,
});

export const ASA_IMPLICIT_SECURITY_LEVEL = 0;

export const ASA_DEFAULT_SECURITY_LEVELS: Readonly<Record<string, number>> = Object.freeze({
  inside: 100,
});

export function asaDefaultSecurityLevel(zoneName: string): number {
  return ASA_DEFAULT_SECURITY_LEVELS[zoneName] ?? ASA_IMPLICIT_SECURITY_LEVEL;
}
