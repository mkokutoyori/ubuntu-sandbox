type AddressName = (address: string) => string;
type Emit = (text: string) => void;

const EOL = 0;
const NOP = 1;
const TIMESTAMP = 68;
const RECORD_ROUTE = 7;
const STRICT_SOURCE_ROUTE = 137;
const LOOSE_SOURCE_ROUTE = 131;
const ROUTER_ALERT = 148;
const TS_ONLY = 0;
const TS_AND_ADDRESS = 1;
const TS_PRESPECIFIED = 3;

const OPTION_NAMES: Readonly<Record<number, string>> = {
  [EOL]: 'EOL', [NOP]: 'NOP', [TIMESTAMP]: 'timestamp', 130: 'security', [RECORD_ROUTE]: 'RR',
  [STRICT_SOURCE_ROUTE]: 'SSRR', [LOOSE_SOURCE_ROUTE]: 'LSRR', [ROUTER_ALERT]: 'RA', 82: 'traceroute',
};

class TruncatedOption extends Error {}

function at(bytes: readonly number[], index: number): number {
  if (index >= bytes.length) throw new TruncatedOption();
  return bytes[index];
}

function dotted(bytes: readonly number[], index: number, name: AddressName): string {
  at(bytes, index + 3);
  return name(`${bytes[index]}.${bytes[index + 1]}.${bytes[index + 2]}.${bytes[index + 3]}`);
}

function route(bytes: readonly number[], start: number, length: number, name: AddressName, emit: Emit): void {
  if (length < 3) {
    emit(` [bad length ${length}]`);
    return;
  }
  if ((length + 1) & 3) emit(` [bad length ${length}]`);
  const pointer = at(bytes, start + 2) - 1;
  if (pointer < 3 || ((pointer + 1) & 3) !== 0 || pointer > length + 1) emit(` [bad ptr ${at(bytes, start + 2)}]`);
  for (let offset = 3; offset < length; offset += 4) {
    emit(` ${dotted(bytes, start + offset, name)}`);
    if (pointer > offset) emit(',');
  }
}

function timestamp(bytes: readonly number[], start: number, length: number, name: AddressName, emit: Emit): void {
  if (length < 4) {
    emit(`[bad length ${length}]`);
    return;
  }
  emit(' TS{');
  const flags = at(bytes, start + 3);
  const kind = flags & 0x0f;
  const hop = kind !== TS_ONLY ? 8 : 4;
  if ((length - 4) & (hop - 1)) emit(`[bad length ${length}]`);
  const pointer = at(bytes, start + 2) - 1;
  let offset = 0;
  if (pointer < 4 || ((pointer - 4) & (hop - 1)) !== 0 || pointer > length + 1) emit(`[bad ptr ${at(bytes, start + 2)}]`);
  if (kind === TS_ONLY) emit('TSONLY');
  else if (kind === TS_AND_ADDRESS) emit('TS+ADDR');
  else if (kind === TS_PRESPECIFIED) emit('PRESPEC');
  else emit(`[bad ts type ${kind}]`);
  if (kind === TS_ONLY || kind === TS_AND_ADDRESS || kind === TS_PRESPECIFIED) {
    let separator = ' ';
    for (offset = 4; offset < length; offset += hop) {
      if (pointer === offset) separator = ' ^ ';
      at(bytes, start + offset + hop - 1);
      const value = ((bytes[start + offset + hop - 4] << 24) | (bytes[start + offset + hop - 3] << 16) | (bytes[start + offset + hop - 2] << 8) | bytes[start + offset + hop - 1]) >>> 0;
      emit(`${separator}${value}@${hop !== 8 ? '' : dotted(bytes, start + offset, name)}`);
      separator = ' ';
    }
  }
  emit(pointer === offset ? ' ^ ' : '');
  const notRecorded = flags >> 4;
  emit(notRecorded ? ` [${notRecorded} hops not recorded]} ` : '}');
}

function walk(bytes: readonly number[], declared: number, name: AddressName, emit: Emit): void {
  let separator = '';
  let start = 0;
  let remaining = declared;
  while (remaining > 0) {
    emit(separator);
    separator = ',';
    const code = at(bytes, start);
    emit(OPTION_NAMES[code] ?? `unknown ${code}`);
    let length = 1;
    if (code !== NOP && code !== EOL) {
      length = at(bytes, start + 1);
      if (length < 2) {
        emit(` [bad length ${length}]`);
        return;
      }
    }
    if (length > remaining) {
      emit(` [bad length ${length}]`);
      return;
    }
    at(bytes, start + length - 1);
    if (code === EOL) return;
    if (code === TIMESTAMP) timestamp(bytes, start, length, name, emit);
    else if (code === RECORD_ROUTE || code === STRICT_SOURCE_ROUTE || code === LOOSE_SOURCE_ROUTE) route(bytes, start, length, name, emit);
    else if (code === ROUTER_ALERT) {
      if (length < 4) emit(` [bad length ${length}]`);
      else {
        const value = (at(bytes, start + 2) << 8) | at(bytes, start + 3);
        if (value !== 0) emit(` value ${value}`);
      }
    }
    start += length;
    remaining -= length;
  }
}

export interface IpOptionsText {
  readonly text: string;
  readonly truncated: boolean;
}

export function ipOptionsText(bytes: readonly number[], declared: number, name: AddressName): IpOptionsText {
  let text = '';
  try {
    walk(bytes, declared, name, (piece) => { text += piece; });
  } catch (error) {
    if (error instanceof TruncatedOption) return { text: `${text} [truncated-option]`, truncated: true };
    throw error;
  }
  return { text, truncated: false };
}
