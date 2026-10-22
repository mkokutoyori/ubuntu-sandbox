import { MplsLabel } from './MplsLabel';

export const LABEL_STACK_ENTRY_BYTES = 4;
export const MAX_TRAFFIC_CLASS = 7;
export const MAX_MPLS_TTL = 255;

export interface LabelStackEntry {
  readonly label: MplsLabel;
  readonly trafficClass: number;
  readonly bottom: boolean;
  readonly ttl: number;
}

export function makeLabelStackEntry(
  label: MplsLabel, ttl: number, trafficClass = 0, bottom = false,
): LabelStackEntry {
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_MPLS_TTL) {
    throw new RangeError(`Invalid MPLS TTL ${ttl}: must be an integer in 0-${MAX_MPLS_TTL}`);
  }
  if (!Number.isInteger(trafficClass) || trafficClass < 0 || trafficClass > MAX_TRAFFIC_CLASS) {
    throw new RangeError(`Invalid traffic class ${trafficClass}: must be an integer in 0-${MAX_TRAFFIC_CLASS}`);
  }
  return { label, trafficClass, bottom, ttl };
}

export function withBottomOfStack(stack: readonly LabelStackEntry[]): LabelStackEntry[] {
  return stack.map((entry, index) => ({ ...entry, bottom: index === stack.length - 1 }));
}

export function encodeLabelStack(stack: readonly LabelStackEntry[]): Uint8Array {
  const bytes = new Uint8Array(stack.length * LABEL_STACK_ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  withBottomOfStack(stack).forEach((entry, index) => {
    const word = ((entry.label.value << 12) | (entry.trafficClass << 9) | ((entry.bottom ? 1 : 0) << 8) | entry.ttl) >>> 0;
    view.setUint32(index * LABEL_STACK_ENTRY_BYTES, word);
  });
  return bytes;
}

export interface DecodedLabelStack {
  readonly stack: LabelStackEntry[];
  readonly consumed: number;
}

export function decodeLabelStack(bytes: Uint8Array): DecodedLabelStack | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stack: LabelStackEntry[] = [];
  for (let offset = 0; offset + LABEL_STACK_ENTRY_BYTES <= bytes.byteLength; offset += LABEL_STACK_ENTRY_BYTES) {
    const word = view.getUint32(offset);
    const bottom = ((word >>> 8) & 1) === 1;
    stack.push({
      label: MplsLabel.of(word >>> 12),
      trafficClass: (word >>> 9) & 0x7,
      bottom,
      ttl: word & 0xff,
    });
    if (bottom) return { stack, consumed: (stack.length) * LABEL_STACK_ENTRY_BYTES };
  }
  return null;
}
