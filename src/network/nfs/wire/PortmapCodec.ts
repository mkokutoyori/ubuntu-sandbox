import { XdrReader, XdrWriter } from './Xdr';

export const PORTMAP_PROGRAM = 100000;
export const PORTMAP_V2 = 2;
export const PORTMAP_PORT = 111;

export enum PortmapProcedure {
  NULL = 0,
  SET = 1,
  UNSET = 2,
  GETPORT = 3,
  DUMP = 4,
  CALLIT = 5,
}

export enum RpcProtocol {
  TCP = 6,
  UDP = 17,
}

export interface PortmapMapping {
  readonly program: number;
  readonly version: number;
  readonly protocol: RpcProtocol;
  readonly port: number;
}

export function encodeMapping(mapping: PortmapMapping): Uint8Array {
  const w = new XdrWriter();
  w.uint32(mapping.program);
  w.uint32(mapping.version);
  w.uint32(mapping.protocol);
  w.uint32(mapping.port);
  return w.toBytes();
}

export function decodeMapping(bytes: Uint8Array): PortmapMapping {
  const r = new XdrReader(bytes);
  return {
    program: r.uint32(),
    version: r.uint32(),
    protocol: r.uint32() as RpcProtocol,
    port: r.uint32(),
  };
}

export function encodePort(port: number): Uint8Array {
  return new XdrWriter().uint32(port).toBytes();
}

export function decodePort(bytes: Uint8Array): number {
  return new XdrReader(bytes).uint32();
}

export function encodeBoolean(value: boolean): Uint8Array {
  return new XdrWriter().boolean(value).toBytes();
}

export function encodeMappingList(mappings: readonly PortmapMapping[]): Uint8Array {
  const w = new XdrWriter();
  for (const mapping of mappings) {
    w.boolean(true);
    w.uint32(mapping.program);
    w.uint32(mapping.version);
    w.uint32(mapping.protocol);
    w.uint32(mapping.port);
  }
  w.boolean(false);
  return w.toBytes();
}

export function decodeMappingList(bytes: Uint8Array): PortmapMapping[] {
  const r = new XdrReader(bytes);
  const out: PortmapMapping[] = [];
  while (r.boolean()) {
    out.push({
      program: r.uint32(),
      version: r.uint32(),
      protocol: r.uint32() as RpcProtocol,
      port: r.uint32(),
    });
  }
  return out;
}
