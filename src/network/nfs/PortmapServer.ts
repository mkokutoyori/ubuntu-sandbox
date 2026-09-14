import type { RpcCallContext, RpcProgramHandler } from './RpcService';
import {
  PORTMAP_PROGRAM, PORTMAP_V2, PortmapProcedure, RpcProtocol,
  decodeMapping, encodeBoolean, encodeMappingList, encodePort,
  type PortmapMapping,
} from './wire/PortmapCodec';

function mappingKey(program: number, version: number, protocol: RpcProtocol): string {
  return `${program}/${version}/${protocol}`;
}

export class PortmapServer implements RpcProgramHandler {
  readonly program = PORTMAP_PROGRAM;
  readonly lowVersion = PORTMAP_V2;
  readonly highVersion = PORTMAP_V2;

  private readonly mappings = new Map<string, PortmapMapping>();

  hasProcedure(_version: number, procedure: number): boolean {
    return procedure >= PortmapProcedure.NULL && procedure <= PortmapProcedure.DUMP;
  }

  set(mapping: PortmapMapping): boolean {
    const key = mappingKey(mapping.program, mapping.version, mapping.protocol);
    if (this.mappings.has(key)) return false;
    this.mappings.set(key, mapping);
    return true;
  }

  unset(program: number, version: number): boolean {
    let removed = false;
    for (const protocol of [RpcProtocol.TCP, RpcProtocol.UDP]) {
      removed = this.mappings.delete(mappingKey(program, version, protocol)) || removed;
    }
    return removed;
  }

  portFor(program: number, version: number, protocol: RpcProtocol): number {
    return this.mappings.get(mappingKey(program, version, protocol))?.port ?? 0;
  }

  list(): PortmapMapping[] {
    return [...this.mappings.values()];
  }

  invoke({ call }: RpcCallContext): Uint8Array {
    switch (call.procedure as PortmapProcedure) {
      case PortmapProcedure.NULL:
        return new Uint8Array(0);
      case PortmapProcedure.SET:
        return encodeBoolean(this.set(decodeMapping(call.payload)));
      case PortmapProcedure.UNSET: {
        const mapping = decodeMapping(call.payload);
        return encodeBoolean(this.unset(mapping.program, mapping.version));
      }
      case PortmapProcedure.GETPORT: {
        const mapping = decodeMapping(call.payload);
        return encodePort(this.portFor(mapping.program, mapping.version, mapping.protocol));
      }
      case PortmapProcedure.DUMP:
        return encodeMappingList(this.list());
      default:
        return new Uint8Array(0);
    }
  }
}
