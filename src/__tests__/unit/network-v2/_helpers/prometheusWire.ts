export interface DecodedSeries {
  readonly labels: { name: string; value: string }[];
  value: number;
  valueOnWire: boolean;
  timestampMs: number;
  timestampOnWire: boolean;
}

interface Field {
  readonly number: number;
  readonly wireType: number;
  readonly varint: bigint;
  readonly bytes: Uint8Array;
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let index = start;
  for (;;) {
    const byte = bytes[index++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7n;
  }
}

function fieldsOf(bytes: Uint8Array): Field[] {
  const fields: Field[] = [];
  let index = 0;
  while (index < bytes.length) {
    const key = readVarint(bytes, index);
    index = key.next;
    const number = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (wireType === 0) {
      const varint = readVarint(bytes, index);
      index = varint.next;
      fields.push({ number, wireType, varint: varint.value, bytes: new Uint8Array(0) });
    } else if (wireType === 1) {
      fields.push({ number, wireType, varint: 0n, bytes: bytes.slice(index, index + 8) });
      index += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, index);
      index = length.next;
      fields.push({ number, wireType, varint: 0n, bytes: bytes.slice(index, index + Number(length.value)) });
      index += Number(length.value);
    } else {
      throw new Error(`unexpected wire type ${wireType}`);
    }
  }
  return fields;
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

export function decodeWriteRequest(bytes: Uint8Array): DecodedSeries[] {
  return fieldsOf(bytes).filter((field) => field.number === 1).map((timeseries) => {
    const series: DecodedSeries = { labels: [], value: 0, valueOnWire: false, timestampMs: 0, timestampOnWire: false };
    for (const field of fieldsOf(timeseries.bytes)) {
      if (field.number === 1) {
        const parts = fieldsOf(field.bytes);
        series.labels.push({ name: text(parts.find((part) => part.number === 1)?.bytes ?? new Uint8Array(0)), value: text(parts.find((part) => part.number === 2)?.bytes ?? new Uint8Array(0)) });
      } else if (field.number === 2) {
        for (const part of fieldsOf(field.bytes)) {
          if (part.number === 1) {
            series.value = new DataView(part.bytes.buffer, part.bytes.byteOffset, 8).getFloat64(0, true);
            series.valueOnWire = true;
          } else if (part.number === 2) {
            series.timestampMs = Number(BigInt.asIntN(64, part.varint));
            series.timestampOnWire = true;
          }
        }
      }
    }
    return series;
  });
}
