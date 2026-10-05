import {
  REGISTRY_ROOT_NAMES,
  type RegistryAddress,
  type RegistryValue,
  type RegistryValueType,
} from './PSRegistryProvider';

export interface RegFileSource {
  keyView(address: RegistryAddress): { values: readonly RegistryValue[]; subkeys: readonly string[] } | null;
}

export interface RegFileKey {
  readonly path: string;
  readonly values: ReadonlyArray<{ readonly name: string; readonly type: RegistryValueType; readonly value: string | number }>;
  readonly deleted: boolean;
}

const HEADER = 'Windows Registry Editor Version 5.00';

const HEX_TYPES: Readonly<Record<string, RegistryValueType>> = {
  '0': 'None', '1': 'String', '2': 'ExpandString', '3': 'Binary', '4': 'DWord', '5': 'DWordBigEndian',
  '6': 'Link', '7': 'MultiString', '8': 'ResourceList', '9': 'ResourceList', 'b': 'QWord',
};

const HEX_CODES: Readonly<Record<RegistryValueType, string>> = {
  None: '0', String: '1', ExpandString: '2', Binary: '3', DWord: '4', DWordBigEndian: '5',
  Link: '6', MultiString: '7', ResourceList: '9', QWord: 'b',
};

const quote = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const unquote = (text: string): string => text.slice(1, -1).replace(/\\(["\\])/g, '$1');

function utf16Bytes(text: string): string[] {
  const bytes: string[] = [];
  for (const unit of text) {
    const code = unit.charCodeAt(0);
    bytes.push((code & 0xff).toString(16).padStart(2, '0'), (code >> 8).toString(16).padStart(2, '0'));
  }
  return bytes;
}

function textFromUtf16(bytes: readonly string[]): string {
  let text = '';
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    text += String.fromCharCode(Number.parseInt(bytes[index], 16) | (Number.parseInt(bytes[index + 1], 16) << 8));
  }
  return text;
}

const NUL = String.fromCharCode(0);

function withoutTrailingNuls(text: string, limit: number): string {
  let end = text.length;
  let removed = 0;
  while (end > 0 && removed < limit && text[end - 1] === NUL) {
    end--;
    removed++;
  }
  return text.slice(0, end);
}

function hexBytes(hex: string): string[] {
  return hex.match(/../g)?.map(pair => pair.toLowerCase()) ?? [];
}

function valueLine(value: RegistryValue): string {
  const left = value.name === '' ? '@' : quote(value.name);
  switch (value.type) {
    case 'String': return `${left}=${quote(String(value.value))}`;
    case 'DWord': return `${left}=dword:${Number(value.value).toString(16).padStart(8, '0')}`;
    case 'ExpandString': return `${left}=hex(2):${[...utf16Bytes(String(value.value)), '00', '00'].join(',')}`;
    case 'MultiString': {
      const parts = String(value.value).split('\\0');
      return `${left}=hex(7):${[...parts.flatMap(part => [...utf16Bytes(part), '00', '00']), '00', '00'].join(',')}`;
    }
    case 'QWord': {
      const hex = Number(value.value).toString(16).padStart(16, '0');
      return `${left}=hex(b):${(hex.match(/../g) ?? []).reverse().join(',')}`;
    }
    default: {
      const bytes = hexBytes(String(value.value));
      return `${left}=hex${value.type === 'Binary' ? '' : `(${HEX_CODES[value.type]})`}:${bytes.join(',')}`;
    }
  }
}

function collect(source: RegFileSource, address: RegistryAddress, lines: string[]): void {
  const view = source.keyView(address);
  if (view === null) return;
  lines.push(`[${[REGISTRY_ROOT_NAMES[address.root], ...address.segments].join('\\')}]`);
  for (const value of view.values) lines.push(valueLine(value));
  lines.push('');
  for (const child of view.subkeys) collect(source, { ...address, segments: [...address.segments, child] }, lines);
}

export function renderRegFile(source: RegFileSource, address: RegistryAddress): string {
  const lines: string[] = [HEADER, ''];
  collect(source, address, lines);
  return lines.join('\r\n');
}

function parseValue(text: string): { name: string; type: RegistryValueType; value: string | number } | null {
  const named = /^(@|"(?:[^"\\]|\\.)*")=(.*)$/.exec(text);
  if (named === null) return null;
  const name = named[1] === '@' ? '' : unquote(named[1]);
  const data = named[2].trim();
  if (data.startsWith('"')) return { name, type: 'String', value: unquote(data) };
  const dword = /^dword:([0-9a-fA-F]{1,8})$/.exec(data);
  if (dword !== null) return { name, type: 'DWord', value: Number.parseInt(dword[1], 16) };
  const hex = /^hex(?:\(([0-9a-fA-F]+)\))?:(.*)$/.exec(data);
  if (hex === null) return null;
  const type = HEX_TYPES[(hex[1] ?? '3').toLowerCase()];
  if (type === undefined) return null;
  const bytes = hex[2].split(',').map(byte => byte.trim()).filter(byte => byte !== '');
  if (type === 'ExpandString') return { name, type, value: withoutTrailingNuls(textFromUtf16(bytes), Infinity) };
  if (type === 'MultiString') return { name, type, value: withoutTrailingNuls(textFromUtf16(bytes), 2).split(NUL).join('\\0') };
  if (type === 'QWord') return { name, type, value: Number.parseInt([...bytes].reverse().join(''), 16) };
  return { name, type, value: bytes.join('').toUpperCase() };
}

export function parseRegFile(text: string): RegFileKey[] | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== HEADER && lines[0]?.trim() !== 'REGEDIT4') return null;
  const keys: Array<{ path: string; values: Array<{ name: string; type: RegistryValueType; value: string | number }>; deleted: boolean }> = [];
  let current: (typeof keys)[number] | null = null;
  let carried = '';
  for (const raw of lines.slice(1)) {
    const line = (carried + raw.trim()).trim();
    if (line.endsWith('\\') && /^(@|").*hex/.test(line)) {
      carried = line.slice(0, -1);
      continue;
    }
    carried = '';
    if (line === '' || line.startsWith(';')) continue;
    const key = /^\[(-?)(.+)\]$/.exec(line);
    if (key !== null) {
      current = { path: key[2], values: [], deleted: key[1] === '-' };
      keys.push(current);
      continue;
    }
    if (current === null) return null;
    const value = parseValue(line);
    if (value === null) return null;
    current.values.push(value);
  }
  return keys;
}
