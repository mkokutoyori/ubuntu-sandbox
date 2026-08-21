export interface DynamicNetwork {
  readonly id: string;
  readonly prefix: string;
  readonly mask: string;
  readonly area: string;
}

export interface RipConfiguration {
  readonly enabled: boolean;
  readonly version: 1 | 2;
  readonly networks: readonly DynamicNetwork[];
  readonly passiveInterfaces: readonly string[];
  readonly defaultInformationOriginate: boolean;
}

export interface OspfInterfaceSettings {
  readonly name: string;
  readonly iface: string;
  readonly cost: number;
  readonly helloIntervalSec: number;
  readonly deadIntervalSec: number;
  readonly priority: number;
  readonly networkType: string;
  readonly authentication: string;
  readonly md5Keys: readonly { readonly id: number; readonly key: string }[];
}

export interface OspfArea {
  readonly id: string;
  readonly type: string;
}

export interface OspfConfiguration {
  readonly enabled: boolean;
  readonly routerId: string;
  readonly areas: readonly OspfArea[];
  readonly networks: readonly DynamicNetwork[];
  readonly interfaces: readonly OspfInterfaceSettings[];
  readonly passiveInterfaces: readonly string[];
  readonly redistributeConnected: boolean;
  readonly redistributeStatic: boolean;
}

export interface BgpNeighbour {
  readonly ip: string;
  readonly remoteAs: number;
  readonly weight?: number;
}

export interface BgpConfiguration {
  readonly enabled: boolean;
  readonly asn: number;
  readonly routerId: string;
  readonly neighbours: readonly BgpNeighbour[];
  readonly networks: readonly DynamicNetwork[];
}

export const BGP_DEFAULTS: BgpConfiguration = Object.freeze({
  enabled: false,
  asn: 0,
  routerId: '',
  neighbours: Object.freeze([]),
  networks: Object.freeze([]),
});

export const RIP_DEFAULTS: RipConfiguration = Object.freeze({
  enabled: false,
  version: 2,
  networks: Object.freeze([]),
  passiveInterfaces: Object.freeze([]),
  defaultInformationOriginate: false,
});

export const OSPF_DEFAULTS: OspfConfiguration = Object.freeze({
  enabled: false,
  routerId: '',
  areas: Object.freeze([]),
  networks: Object.freeze([]),
  interfaces: Object.freeze([]),
  passiveInterfaces: Object.freeze([]),
  redistributeConnected: false,
  redistributeStatic: false,
});

export interface BgpPeerSummary {
  readonly address: string;
  readonly remoteAs: number;
  readonly state: string;
  readonly isUp: boolean;
  readonly uptimeSec: number;
  readonly prefixesReceived: number;
}

export interface BgpSummaryFacts {
  readonly routerId: string;
  readonly localAs: number;
  readonly neighbours: readonly BgpPeerSummary[];
}
