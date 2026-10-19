import { formatTimestamp3164, parseTimestamp3164, parseTimestamp3339, type SyslogTime, type Timestamp3164Options } from './SyslogTime';

export const MAX_TAG_SIZE = 512;
export const MAX_HOSTNAME_SIZE = 512;

export interface LegacyParserOptions {
  readonly detectYearAfterTimestamp: boolean;
  readonly permitSquareBracketsInHostname: boolean;
  readonly permitSlashesInHostname: boolean;
  readonly permitAtSignsInHostname: boolean;
  readonly forceTagEndingByColon: boolean;
  readonly removeMsgFirstSpace: boolean;
  readonly detectHeaderless: boolean;
  readonly headerlessHostname: string | null;
  readonly headerlessTag: string | null;
  readonly dropHeaderless: boolean;
  readonly parseHostnameAndTag: boolean;
  readonly timeZoneNames?: Timestamp3164Options['timeZoneNames'];
}

export const DEFAULT_LEGACY_OPTIONS: LegacyParserOptions = {
  detectYearAfterTimestamp: false,
  permitSquareBracketsInHostname: false,
  permitSlashesInHostname: false,
  permitAtSignsInHostname: false,
  forceTagEndingByColon: false,
  removeMsgFirstSpace: false,
  detectHeaderless: false,
  headerlessHostname: null,
  headerlessTag: null,
  dropHeaderless: false,
  parseHostnameAndTag: true,
};

export interface LegacyParseInput {
  readonly afterPri: string;
  readonly receivedAt: SyslogTime;
  readonly fromHost: string | null;
  readonly internal: boolean;
  readonly ignoreDate: boolean;
  readonly parseHostname: boolean;
  readonly invalidFacility: boolean;
}

export interface LegacyParseResult {
  readonly timestamp: SyslogTime;
  readonly hostname: string | null;
  readonly tag: string | null;
  readonly message: string;
  readonly discard: boolean;
  readonly headerless: boolean;
}

const ALNUM = /[A-Za-z0-9]/;

export function parseLegacyBody(input: LegacyParseInput, options: LegacyParserOptions = DEFAULT_LEGACY_OPTIONS): LegacyParseResult {
  let rest = input.afterPri;
  let timestamp = input.receivedAt;
  let hostname: string | null = null;
  let tag: string | null = null;
  let discard = false;
  let headerless = false;

  const finish = (): LegacyParseResult => {
    if (options.removeMsgFirstSpace && rest[0] === ' ') rest = rest.slice(1);
    return { timestamp, hostname, tag, message: rest, discard, headerless };
  };

  if (input.invalidFacility) return finish();

  let index = 0;
  while (index < rest.length && (rest[index] === ' ' || rest[index] === '\t')) index++;
  if (index < rest.length && (rest[index] === '{' || rest[index] === '[')) return finish();

  const tsOptions: Timestamp3164Options = {
    detectYearAfterTimestamp: options.detectYearAfterTimestamp,
    timeZoneNames: options.timeZoneNames,
    parseTimeZone: false,
  };
  let foundTimestamp = false;
  const rfc3339 = parseTimestamp3339(rest);
  if (rfc3339 !== null) {
    timestamp = rfc3339.time;
    rest = rest.slice(rfc3339.consumed);
    foundTimestamp = true;
  } else {
    const legacy = parseTimestamp3164(rest, input.receivedAt, tsOptions);
    if (legacy !== null) {
      timestamp = legacy.time;
      rest = rest.slice(legacy.consumed);
      foundTimestamp = true;
    } else if (rest[0] === ' ' && rest.length > 1) {
      const slightlyMalformed = parseTimestamp3164(rest.slice(1), input.receivedAt, tsOptions);
      if (slightlyMalformed !== null) {
        timestamp = slightlyMalformed.time;
        rest = rest.slice(1 + slightlyMalformed.consumed);
        foundTimestamp = true;
      }
    }
  }

  if (options.detectHeaderless && !foundTimestamp) {
    hostname = options.headerlessHostname ?? input.fromHost ?? 'unknown';
    tag = options.headerlessTag ?? 'headerless';
    headerless = true;
    if (options.dropHeaderless) discard = true;
  }

  if (input.ignoreDate) timestamp = input.receivedAt;

  if (options.parseHostnameAndTag && !input.internal) {
    if (rest.length > 0 && input.parseHostname) {
      let position = 0;
      let hadSquareBracket = false;
      let buffer = '';
      if (options.permitSquareBracketsInHostname && rest[0] === '[') {
        hadSquareBracket = true;
        buffer = '[';
        position = 1;
      }
      while (position < rest.length) {
        const character = rest[position];
        const allowed = ALNUM.test(character) || character === '.' || character === '_' || character === '-'
          || (character === ']' && hadSquareBracket)
          || (character === '@' && options.permitAtSignsInHostname)
          || (character === '/' && options.permitSlashesInHostname);
        if (!allowed || position >= MAX_HOSTNAME_SIZE - 1) break;
        buffer += character;
        position++;
        if (rest[position] === ']') break;
      }
      if (position === rest.length) {
        rest = rest.slice(position);
        hostname = buffer;
      } else {
        let isHostName = false;
        if (position > 0) {
          if (hadSquareBracket) {
            if (rest[position] === ']' && position < MAX_HOSTNAME_SIZE - 1) {
              buffer += ']';
              position++;
              isHostName = true;
            }
          } else if (ALNUM.test(rest[position - 1])) {
            isHostName = true;
          }
          if (rest[position] !== ' ') isHostName = false;
        }
        if (isHostName) {
          hostname = buffer;
          rest = rest.slice(position + 1);
        }
      }
    }

    let tagText = '';
    let tagLength = 0;
    let cursor = 0;
    while (cursor < rest.length && rest[cursor] !== ':' && rest[cursor] !== ' ' && tagLength < MAX_TAG_SIZE - 2) {
      tagText += rest[cursor];
      cursor++;
      tagLength++;
    }
    if (cursor < rest.length && rest[cursor] === ':') {
      tagText += ':';
      cursor++;
      rest = rest.slice(cursor);
    } else if (options.forceTagEndingByColon) {
      const tagStart = input.afterPri.length - rest.length;
      const precededBySpace = tagStart > 0 && input.afterPri[tagStart - 1] === ' ';
      rest = precededBySpace ? ` ${rest}` : rest;
      tagText = '-';
    } else {
      rest = rest.slice(cursor);
    }
    tag = tagText;
  }
  return finish();
}

export interface Rfc3164Header {
  readonly pri: number;
  readonly timestamp: SyslogTime;
  readonly hostname: string;
  readonly tag: string;
  readonly pid?: number;
  readonly content: string;
}

export function formatRfc3164(message: Rfc3164Header): string {
  if (!Number.isInteger(message.pri) || message.pri < 0 || message.pri > 191) throw new RangeError('PRI out of range 0..191');
  const pid = message.pid === undefined ? '' : `[${message.pid}]`;
  return `<${message.pri}>${formatTimestamp3164(message.timestamp)} ${message.hostname} ${message.tag}${pid}: ${message.content}`;
}
