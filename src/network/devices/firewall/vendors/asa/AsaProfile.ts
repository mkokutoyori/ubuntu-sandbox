import type { RuleAction } from '../../model/SecurityRule';
import type { ZoneType } from '../../model/SecurityZone';
import type { FirewallProfile } from '../../FirewallProfile';

export const ASA_PIPELINE: readonly string[] = Object.freeze([
  'ingress-zone',
  'session-lookup',
  'tcp-state-check',
  'nat-destination',
  'route-lookup',
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

  pipeline: ASA_PIPELINE,
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

  unimplemented: Object.freeze([
    'show module',
    'verify /md5',
    'threat-detection scanning-threat',
  ]),
});

export const ASA_DEFAULT_SECURITY_LEVELS: Readonly<Record<string, number>> = Object.freeze({
  inside: 100,
  dmz: 50,
  outside: 0,
});
