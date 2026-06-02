export const UDP_PORT_VXLAN = 4789;
export const VXLAN_VNI_MAX = 0xffffff;
export const VXLAN_FLAG_I = 0x08;

export interface VxlanHeader {
  flags: number;
  reserved1: number;
  vni: number;
  reserved2: number;
}

export interface VxlanPacket {
  type: 'vxlan';
  header: VxlanHeader;
  innerFrame: unknown;
}

export interface VxlanRemoteVtep {
  vni: number;
  remoteVtepIp: string;
  remoteMacs: Set<string>;
  lastSeenMs: number;
  packetsIn: number;
  packetsOut: number;
}

export interface VxlanInterface {
  name: string;
  localVtepIp: string | null;
  vnis: Set<number>;
  enabled: boolean;
}

export interface VxlanConfig {
  enabled: boolean;
  interfaces: Map<string, VxlanInterface>;
  remoteVteps: Map<string, VxlanRemoteVtep>;
  macTable: Map<string, { vni: number; remoteVtepIp: string; lastSeenMs: number }>;
  learning: boolean;
  port: number;
}

export function createDefaultVxlanConfig(): VxlanConfig {
  return {
    enabled: true,
    interfaces: new Map(),
    remoteVteps: new Map(),
    macTable: new Map(),
    learning: true,
    port: UDP_PORT_VXLAN,
  };
}

export function defaultInterface(name: string): VxlanInterface {
  return { name, localVtepIp: null, vnis: new Set(), enabled: true };
}

export function defaultRemoteVtep(vni: number, ip: string): VxlanRemoteVtep {
  return {
    vni, remoteVtepIp: ip,
    remoteMacs: new Set(), lastSeenMs: 0,
    packetsIn: 0, packetsOut: 0,
  };
}

export function makeVtepKey(vni: number, remoteVtepIp: string): string {
  return `${vni}|${remoteVtepIp}`;
}

export function makeMacKey(vni: number, mac: string): string {
  return `${vni}|${mac.toLowerCase()}`;
}

export function isValidVni(vni: number): boolean {
  return vni >= 0 && vni <= VXLAN_VNI_MAX;
}
