import { buildAuparseEvent } from '../tools/AuparseEvent';
import { extractFeedTimestamp } from '../tools/AuparseFeed';
import type { Interpreter } from '../tools/AuditInterpret';
import type { AuditdConfig } from './AuditdConfig';

const INTERPRETATION_SEPARATOR = '\u001d';
const MAX_AUDIT_MESSAGE_LENGTH = 8970;
const POSIX_HOST_NAME_MAX = 255;
const FORMAT_BUFFER_LENGTH = MAX_AUDIT_MESSAGE_LENGTH + POSIX_HOST_NAME_MAX;
const MIN_SPACE_LEFT = 24;
const MAX_FIELD_NAME = 63;
const UID_TYPES = new Set(['UID', 'GID']);
const PLAIN_TYPES = new Set(['SYSCALL', 'ARCH', 'SOCKADDR']);

export function formatRaw(line: string, config: AuditdConfig): string {
  const prefixed = config.nodeNameFormat !== 'NONE' ? `node=${config.nodeName} ${line}` : line;
  const flattened = prefixed.replace(/\n/g, ' ');
  return flattened.endsWith(' ') ? flattened.slice(0, -1) : flattened;
}

function needsEncoding(value: string): boolean {
  for (const byte of new TextEncoder().encode(value)) {
    if (byte === 0x22 || byte < 0x21 || byte >= 0x7f) return true;
  }
  return false;
}

export function encodeNameValue(name: string, value: string): string {
  if (!needsEncoding(value)) return `${name}="${value}"`;
  const hex = Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
  return `${name}=${hex}`;
}

export function formatEnriched(line: string, config: AuditdConfig, interpreter: Interpreter): string {
  const raw = formatRaw(line, config);
  let left = FORMAT_BUFFER_LENGTH - raw.length;
  if (left <= MIN_SPACE_LEFT) return raw;
  const time = extractFeedTimestamp(raw);
  if (time === null) return raw;
  const event = buildAuparseEvent([raw], { sec: time.sec, milli: time.milli, serial: time.serial, host: time.host }, interpreter, 'raw');
  if (event === null) return raw;

  let out = raw;
  let separators = 0;
  event.firstRecord();
  let more = event.firstField();
  while (more > 0 && left > MIN_SPACE_LEFT) {
    const type = event.fieldType();
    const encode = UID_TYPES.has(type);
    if (encode || PLAIN_TYPES.has(type)) {
      if (separators === 0) {
        out += INTERPRETATION_SEPARATOR;
        left--;
      }
      separators++;
      const name = (event.fieldName() ?? '').toUpperCase().slice(0, MAX_FIELD_NAME);
      const value = event.interpretField() ?? '?';
      const field = encode ? encodeNameValue(name, value) : `${name}=${value}`;
      const length = 1 + field.length + 1;
      if (length < left) {
        const space = separators > 1 ? ' ' : '';
        out += space + field;
        left -= space.length + field.length;
      }
    }
    more = event.nextField();
  }
  return out;
}
