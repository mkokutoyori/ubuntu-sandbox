import type { AddressObject } from './model/AddressObject';
import type { ServiceObject } from './model/ServiceObject';
import type { FirewallSyslogCatalog } from './logging/SyslogCatalog';
import type { RuleAction } from './model/SecurityRule';
import type { ZoneType, IntraZoneAction } from './model/SecurityZone';

export type VendorId = 'generic' | 'asa' | 'fortios' | 'panos' | 'junos';

export type ConfigurationModel = 'immediate' | 'candidate';
export type PolicyKeyedBy = 'zone' | 'interface';
export type ImplicitPolicyMode = 'deny-all' | 'security-level';
export type SelfTrafficMode =
  | 'zone-host-inbound' | 'local-in-policy' | 'control-plane-acl' | 'management-profile';
export type DeploymentScope = 'device' | 'context' | 'interface';
export type DeploymentMode = 'nat' | 'transparent';
export type PipelineByMode = Readonly<Record<DeploymentMode, readonly string[]>>;

export interface NatPolicyOrder {
  readonly destinationNatBeforePolicy: boolean;
  readonly sourceNatBeforePolicy: boolean;
  readonly policySeesPreNatSource: boolean;
  readonly policySeesPreNatDestination: boolean;
  readonly policySeesPostNatZone: boolean;
}

export interface SessionTimeoutProfile {
  readonly tcpEstablished: number;
  readonly tcpHandshake: number;
  readonly tcpTimeWait: number;
  readonly udp: number;
  readonly icmp: number;
  readonly other: number;
}

export type FirewallPortRole = 'wan' | 'lan' | 'dmz' | 'mgmt' | 'undefined';

export interface FirewallPortSpec {
  readonly name: string;
  readonly role: FirewallPortRole;
  readonly ip?: string;
  readonly mask?: string;
  readonly allowaccess?: readonly string[];
}

export interface FirewallProfile {
  readonly syslogCatalog?: FirewallSyslogCatalog;
  readonly vendor: VendorId;
  readonly displayName: string;
  readonly osName: string;
  readonly defaultVersion: string;

  readonly pipeline: PipelineByMode;
  readonly natOrder: NatPolicyOrder;
  readonly applicationShift: boolean;
  readonly selfTrafficHandling: SelfTrafficMode;

  readonly policyKeyedBy: PolicyKeyedBy;
  readonly implicitPolicy: ImplicitPolicyMode;
  readonly implicitRuleEditable: boolean;
  readonly supportedActions: readonly RuleAction[];
  readonly supportsNegation: boolean;
  readonly natIsPolicyField: boolean;

  readonly zoneModel: 'zone' | 'security-level' | 'both';
  readonly defaultIntraZoneAction: IntraZoneAction;
  readonly zoneTypes: readonly ZoneType[];

  readonly objectsMandatoryInPolicy: boolean;
  readonly maxGroupNesting: number;
  readonly predefinedAddresses?: readonly AddressObject[];
  readonly predefinedServices?: readonly ServiceObject[];

  readonly timeouts: SessionTimeoutProfile;
  readonly tcpSynCheckDefault: boolean;

  readonly deploymentScope: DeploymentScope;
  readonly configurationModel: ConfigurationModel;
  readonly virtualizationName: string | null;

  readonly portPrefix: string;
  readonly portCount: number;
  readonly portFirstIndex: number;
  readonly ports?: readonly FirewallPortSpec[];

  readonly chassis: ChassisResources;
}

export interface ChassisResources {
  readonly cpuCount: number;
  readonly memoryMb: number;
  readonly firmwareMemoryMb: number;
  readonly packetsPerSecondPerCpu: number;
}

export const GENERIC_CHASSIS: ChassisResources = Object.freeze({
  cpuCount: 1,
  memoryMb: 2048,
  firmwareMemoryMb: 256,
  packetsPerSecondPerCpu: 500_000,
});

export const GENERIC_PIPELINE: readonly string[] = Object.freeze([
  'vdom-bind', 'switch-bridge', 'ingress-zone', 'session-lookup', 'tcp-state-check',
  'nat-destination', 'policy-route', 'route-lookup', 'ttl-decrement', 'mtu-check',
  'egress-zone', 'policy-lookup',
  'auth-check', 'utm-inspect', 'nat-source', 'session-install',
]);

export const GENERIC_TRANSPARENT_PIPELINE: readonly string[] = Object.freeze([
  'vdom-bind', 'switch-bridge', 'ingress-zone', 'session-lookup', 'tcp-state-check',
  'mac-lookup', 'ttl-decrement', 'mtu-check', 'egress-zone', 'policy-lookup', 'auth-check',
  'utm-inspect', 'session-install',
]);

export const GENERIC_PIPELINE_BY_MODE: PipelineByMode = Object.freeze({
  nat: GENERIC_PIPELINE,
  transparent: GENERIC_TRANSPARENT_PIPELINE,
});

export const GENERIC_PROFILE: FirewallProfile = Object.freeze({
  vendor: 'generic',
  displayName: 'Generic Firewall',
  osName: 'generic',
  defaultVersion: '1.0',

  pipeline: GENERIC_PIPELINE_BY_MODE,
  natOrder: Object.freeze({
    destinationNatBeforePolicy: true,
    sourceNatBeforePolicy: false,
    policySeesPreNatSource: true,
    policySeesPreNatDestination: true,
    policySeesPostNatZone: true,
  }),
  applicationShift: false,
  selfTrafficHandling: 'local-in-policy',

  policyKeyedBy: 'zone',
  implicitPolicy: 'deny-all',
  implicitRuleEditable: false,
  supportedActions: Object.freeze<RuleAction[]>(['allow', 'deny']),
  supportsNegation: true,
  natIsPolicyField: false,

  zoneModel: 'zone',
  defaultIntraZoneAction: 'deny',
  zoneTypes: Object.freeze<ZoneType[]>(['layer3']),

  objectsMandatoryInPolicy: false,
  maxGroupNesting: 8,

  timeouts: Object.freeze({
    tcpEstablished: 3600, tcpHandshake: 30, tcpTimeWait: 30,
    udp: 180, icmp: 30, other: 60,
  }),
  tcpSynCheckDefault: true,

  deploymentScope: 'device',
  configurationModel: 'immediate',
  virtualizationName: null,

  portPrefix: 'ethernet1/',
  portCount: 8,
  portFirstIndex: 1,

  chassis: GENERIC_CHASSIS,
});
