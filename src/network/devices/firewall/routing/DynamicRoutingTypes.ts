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
  readonly redistributeConnected: boolean;
  readonly redistributeStatic: boolean;
}

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
  redistributeConnected: false,
  redistributeStatic: false,
});
