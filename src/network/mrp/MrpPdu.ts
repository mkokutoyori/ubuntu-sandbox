export const ATTRIBUTE_EVENTS = ['new', 'joinIn', 'in', 'joinMt', 'mt', 'lv'] as const;
export type AttributeEvent = (typeof ATTRIBUTE_EVENTS)[number];

export interface VectorAttribute {
  readonly leaveAll: boolean;
  readonly firstValue: Uint8Array;
  readonly events: readonly AttributeEvent[];
}

export interface MrpMessage {
  readonly attributeType: number;
  readonly attributeLength: number;
  readonly vectors: readonly VectorAttribute[];
}

export interface Mrpdu {
  readonly protocolVersion: number;
  readonly messages: readonly MrpMessage[];
}

export interface MrpPduFormat {
  readonly attributeListLength: boolean;
}

export interface MrpDecodeResult {
  readonly ok: boolean;
  readonly pdu?: Mrpdu;
  readonly error?: string;
}

export const MAX_EVENTS_PER_VECTOR = 8191;
const THREE_PACKED_MAX = 5 * 36 + 5 * 6 + 5;

export function packThreeEvents(events: readonly AttributeEvent[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(events.length / 3));
  for (let at = 0; at < out.length; at++) {
    const code = (slot: number): number => {
      const event = events[at * 3 + slot];
      return event === undefined ? 0 : ATTRIBUTE_EVENTS.indexOf(event);
    };
    out[at] = code(0) * 36 + code(1) * 6 + code(2);
  }
  return out;
}

export function unpackThreeEvents(bytes: Uint8Array, count: number): AttributeEvent[] | undefined {
  const events: AttributeEvent[] = [];
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] > THREE_PACKED_MAX) return undefined;
    const slots = [Math.floor(bytes[at] / 36), Math.floor(bytes[at] / 6) % 6, bytes[at] % 6];
    for (const slot of slots) {
      if (events.length < count) events.push(ATTRIBUTE_EVENTS[slot]);
    }
  }
  return events;
}

export function encodeMrpdu(pdu: Mrpdu, format: MrpPduFormat = { attributeListLength: false }): Uint8Array {
  const out: number[] = [pdu.protocolVersion & 0xff];
  for (const message of pdu.messages) {
    if (message.attributeType === 0) throw new RangeError('AttributeType 0 is reserved');
    const list: number[] = [];
    for (const vector of message.vectors) {
      if (vector.firstValue.length !== message.attributeLength) {
        throw new RangeError('FirstValue length differs from AttributeLength');
      }
      if (vector.events.length > MAX_EVENTS_PER_VECTOR) throw new RangeError('too many events in one vector');
      if (!vector.leaveAll && vector.events.length === 0) {
        throw new RangeError('a NullLeaveAllEvent vector carries at least one event');
      }
      const header = (vector.leaveAll ? 8192 : 0) + vector.events.length;
      list.push(header >> 8, header & 0xff, ...vector.firstValue, ...packThreeEvents(vector.events));
    }
    list.push(0, 0);
    out.push(message.attributeType, message.attributeLength);
    if (format.attributeListLength) out.push(list.length >> 8, list.length & 0xff);
    out.push(...list);
  }
  out.push(0, 0);
  return Uint8Array.from(out);
}

function failure(error: string): MrpDecodeResult {
  return { ok: false, error };
}

export function decodeMrpdu(bytes: Uint8Array, format: MrpPduFormat = { attributeListLength: false }): MrpDecodeResult {
  if (bytes.length < 1) return failure('empty PDU');
  const protocolVersion = bytes[0];
  const messages: MrpMessage[] = [];
  let at = 1;

  while (at < bytes.length) {
    if (bytes[at] === 0) break;
    const attributeType = bytes[at++];
    if (at >= bytes.length) return failure('truncated message header');
    const attributeLength = bytes[at++];
    if (attributeLength === 0) return failure('AttributeLength is nonzero');
    if (format.attributeListLength) at += 2;
    const vectors: VectorAttribute[] = [];

    for (;;) {
      if (at >= bytes.length) break;
      if (bytes[at] === 0 && (at + 1 >= bytes.length || bytes[at + 1] === 0)) { at += 2; break; }
      if (at + 2 + attributeLength > bytes.length) return failure('incomplete VectorAttribute');
      const header = (bytes[at] << 8) | bytes[at + 1];
      const leaveAll = (header >> 13) === 1;
      const count = header & 0x1fff;
      if ((header >> 13) > 1) return failure('reserved LeaveAllEvent value');
      if (!leaveAll && count === 0) return failure('NullLeaveAllEvent with no event');
      at += 2;
      const firstValue = bytes.slice(at, at + attributeLength);
      at += attributeLength;
      const packed = Math.ceil(count / 3);
      if (at + packed > bytes.length) return failure('incomplete VectorAttribute');
      const events = unpackThreeEvents(bytes.slice(at, at + packed), count);
      if (events === undefined) return failure('AttributeEvent outside 0 through 5');
      at += packed;
      vectors.push({ leaveAll, firstValue, events });
    }
    messages.push({ attributeType, attributeLength, vectors });
  }
  return { ok: true, pdu: { protocolVersion, messages } };
}

export function incrementValue(value: Uint8Array, by: number): Uint8Array {
  const out = value.slice();
  let carry = by;
  for (let at = out.length - 1; at >= 0 && carry > 0; at--) {
    const sum = out[at] + carry;
    out[at] = sum & 0xff;
    carry = sum >> 8;
  }
  return out;
}
