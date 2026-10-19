import { formatTimestamp3339, parseTimestamp3339, type SyslogTime } from './SyslogTime';
import { formatStructuredData, isValidSdName, type StructuredDataElement } from './StructuredData';

export const NIL_VALUE = '-';
export const UTF8_BOM = 'ï»¿';

export interface Rfc5424Header {
  readonly pri: number;
  readonly timestamp: SyslogTime | null;
  readonly hostname: string | null;
  readonly appName: string | null;
  readonly procId: string | null;
  readonly msgId: string | null;
  readonly structuredData: readonly StructuredDataElement[];
  readonly message: string | null;
}

function headerField(value: string | null, maximum: number, name: string): string {
  if (value === null || value === '') return NIL_VALUE;
  if (value.length > maximum) throw new RangeError(`${name} exceeds ${maximum} characters`);
  if (!/^[!-~]+$/.test(value)) throw new RangeError(`${name} must be printable US-ASCII`);
  return value;
}

export function formatRfc5424(message: Rfc5424Header): string {
  if (!Number.isInteger(message.pri) || message.pri < 0 || message.pri > 191) throw new RangeError('PRI out of range 0..191');
  for (const element of message.structuredData) {
    if (!isValidSdName(element.id)) throw new RangeError(`invalid SD-ID ${element.id}`);
  }
  const head = [
    `<${message.pri}>1`,
    message.timestamp === null ? NIL_VALUE : formatTimestamp3339(message.timestamp),
    headerField(message.hostname, 255, 'HOSTNAME'),
    headerField(message.appName, 48, 'APP-NAME'),
    headerField(message.procId, 128, 'PROCID'),
    headerField(message.msgId, 32, 'MSGID'),
    formatStructuredData(message.structuredData),
  ].join(' ');
  return message.message === null ? head : `${head} ${message.message}`;
}

export interface ParsedRfc5424 {
  readonly timestamp: SyslogTime | null;
  readonly hostname: string | null;
  readonly appName: string | null;
  readonly procId: string | null;
  readonly msgId: string | null;
  readonly structuredData: string | null;
  readonly message: string;
  readonly timestampFound: boolean;
}

interface Field {
  readonly value: string;
  readonly rest: string;
  readonly terminated: boolean;
}

function takeField(text: string): Field {
  const space = text.indexOf(' ');
  if (space < 0) return { value: text, rest: '', terminated: false };
  return { value: text.slice(0, space), rest: text.slice(space + 1), terminated: true };
}

function takeStructuredData(text: string): { value: string; rest: string } {
  if (text.length === 0 || (text[0] !== '[' && text[0] !== '-')) return { value: '', rest: text };
  let position = 0;
  let value = '';
  if (text[0] === '-') {
    value = '-';
    position = 1;
  } else {
    for (;;) {
      const remaining = text.length - position;
      if (remaining < 2) {
        if (remaining > 0 && text[position] === ']') {
          value += ']';
          position++;
        }
        break;
      }
      if (text[position] === '\\' && text[position + 1] === ']') {
        value += '\\]';
        position += 2;
      } else if (text[position] === ']' && text[position + 1] === ' ') {
        value += ']';
        position += 1;
        break;
      } else {
        value += text[position];
        position++;
      }
    }
  }
  if (position < text.length && text[position] === ' ') position++;
  return { value, rest: text.slice(position) };
}

export function parseRfc5424Body(afterPri: string, receivedAt: SyslogTime): ParsedRfc5424 | null {
  if (afterPri.length < 2 || afterPri[0] !== '1' || afterPri[1] !== ' ') return null;
  let rest = afterPri.slice(2);
  let timestamp: SyslogTime | null = null;
  let timestampFound = true;
  if (rest.startsWith('- ')) {
    timestamp = receivedAt;
    rest = rest.slice(2);
  } else {
    const parsed = parseTimestamp3339(rest);
    if (parsed === null) timestampFound = false;
    else {
      timestamp = parsed.time;
      rest = rest.slice(parsed.consumed);
    }
  }
  if (!timestampFound) {
    return { timestamp: null, hostname: null, appName: null, procId: null, msgId: null, structuredData: null, message: rest, timestampFound };
  }
  const hostname = takeField(rest);
  const appName = takeField(hostname.rest);
  const procId = takeField(appName.rest);
  const msgId = takeField(procId.rest);
  const structured = takeStructuredData(msgId.rest);
  return {
    timestamp,
    hostname: hostname.value,
    appName: appName.value,
    procId: procId.value,
    msgId: msgId.value,
    structuredData: structured.value,
    message: structured.rest,
    timestampFound,
  };
}
