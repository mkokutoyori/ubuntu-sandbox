import {
  decodeMrpdu, encodeMrpdu, incrementValue,
  type AttributeEvent, type Mrpdu, type VectorAttribute,
} from '../mrp/MrpPdu';

export const MVRP_ETHERTYPE = 0x88f5;
export const MVRP_CUSTOMER_ADDRESS = '01:80:c2:00:00:21';
export const MVRP_PROVIDER_ADDRESS = '01:80:c2:00:00:0d';
export const MVRP_PROTOCOL_VERSION = 0x00;
export const MVRP_VID_VECTOR_TYPE = 1;
export const MVRP_ATTRIBUTE_LENGTH = 2;
export const MVRP_MAX_VID = 4094;

export interface MvrpDeclaration {
  readonly vid: number;
  readonly event: AttributeEvent;
}

export interface MvrpMessageContent {
  readonly leaveAll: boolean;
  readonly declarations: readonly MvrpDeclaration[];
}

function vidBytes(vid: number): Uint8Array {
  return Uint8Array.of(vid >> 8, vid & 0xff);
}

function runsOf(declarations: readonly MvrpDeclaration[]): MvrpDeclaration[][] {
  const runs: MvrpDeclaration[][] = [];
  for (const declaration of declarations) {
    const run = runs[runs.length - 1];
    if (run !== undefined && run[run.length - 1].vid + 1 === declaration.vid) run.push(declaration);
    else runs.push([declaration]);
  }
  return runs;
}

export function encodeMvrp(content: MvrpMessageContent): Uint8Array {
  for (const { vid } of content.declarations) {
    if (!Number.isInteger(vid) || vid < 0 || vid > MVRP_MAX_VID) {
      throw new RangeError(`VID ${vid} is outside the 0 through 4094 an MVRP FirstValue can carry`);
    }
  }
  const sorted = [...content.declarations].sort((a, b) => a.vid - b.vid);
  const vectors: VectorAttribute[] = runsOf(sorted).map((run, index) => ({
    leaveAll: content.leaveAll && index === 0,
    firstValue: vidBytes(run[0].vid),
    events: run.map(declaration => declaration.event),
  }));
  if (content.leaveAll && vectors.length === 0) {
    vectors.push({ leaveAll: true, firstValue: vidBytes(1), events: [] });
  }
  const pdu: Mrpdu = {
    protocolVersion: MVRP_PROTOCOL_VERSION,
    messages: vectors.length === 0 ? [] : [{
      attributeType: MVRP_VID_VECTOR_TYPE, attributeLength: MVRP_ATTRIBUTE_LENGTH, vectors,
    }],
  };
  return encodeMrpdu(pdu);
}

export interface MvrpDecodeResult {
  readonly ok: boolean;
  readonly leaveAll?: boolean;
  readonly declarations?: readonly MvrpDeclaration[];
  readonly error?: string;
}

export function decodeMvrp(bytes: Uint8Array): MvrpDecodeResult {
  const decoded = decodeMrpdu(bytes);
  if (!decoded.ok || decoded.pdu === undefined) return { ok: false, error: decoded.error };
  const declarations: MvrpDeclaration[] = [];
  let leaveAll = false;
  for (const message of decoded.pdu.messages) {
    if (message.attributeType !== MVRP_VID_VECTOR_TYPE) continue;
    if (message.attributeLength !== MVRP_ATTRIBUTE_LENGTH) return { ok: false, error: 'MVRP AttributeLength is 2' };
    for (const vector of message.vectors) {
      if (vector.leaveAll) leaveAll = true;
      vector.events.forEach((event, offset) => {
        const value = incrementValue(vector.firstValue, offset);
        declarations.push({ vid: (value[0] << 8) | value[1], event });
      });
    }
  }
  if (declarations.some(declaration => declaration.vid > MVRP_MAX_VID)) {
    return { ok: false, error: 'VID above 4094 in an MVRP vector' };
  }
  return { ok: true, leaveAll, declarations };
}
