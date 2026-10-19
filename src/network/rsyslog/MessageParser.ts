import { DEFAULT_LEGACY_OPTIONS, parseLegacyBody, type LegacyParserOptions } from '@/network/syslog/codec/Rfc3164';
import { parseRfc5424Body } from '@/network/syslog/codec/Rfc5424';
import type { RsyslogMessage } from './Message';

export interface ParserGlobals {
  escapeControlCharactersOnReceive: boolean;
  controlCharacterEscapePrefix: string;
  escape8BitCharactersOnReceive: boolean;
  escapeControlCharacterTab: boolean;
  escapeControlCharactersCStyle: boolean;
  dropTrailingLFOnReception: boolean;
  dropTrailingCROnReception: boolean;
  spaceLFOnReceive: boolean;
  permitSlashInProgramname: boolean;
  maxLine: number;
}

export const DEFAULT_PARSER_GLOBALS: ParserGlobals = {
  escapeControlCharactersOnReceive: true,
  controlCharacterEscapePrefix: '#',
  escape8BitCharactersOnReceive: false,
  escapeControlCharacterTab: true,
  escapeControlCharactersCStyle: false,
  dropTrailingLFOnReception: true,
  dropTrailingCROnReception: false,
  spaceLFOnReceive: false,
  permitSlashInProgramname: false,
  maxLine: 8192,
};

export type ParseOutcome = 'ok' | 'could-not-parse';

export interface MessageParserModule {
  readonly name: string;
  parse(message: RsyslogMessage): ParseOutcome;
}

const C_STYLE_ESCAPES: Readonly<Record<number, string>> = {
  0: '0', 7: 'a', 8: 'b', 27: 'e', 12: 'f', 10: 'n', 13: 'r', 9: 't', 11: 'v',
};

function octal(code: number): string {
  return `${(code >> 6) & 7}${(code >> 3) & 7}${code & 7}`;
}

function hex(code: number): string {
  return code.toString(16).toUpperCase().padStart(2, '0');
}

export function sanitizeRawMessage(raw: string, globals: ParserGlobals): string {
  let text = raw;
  if (text.endsWith('\u0000')) text = text.slice(0, -1);
  if (globals.dropTrailingLFOnReception && text.endsWith('\n')) text = text.slice(0, -1);
  if (globals.dropTrailingCROnReception && text.endsWith('\r')) text = text.slice(0, -1);

  let output = '';
  const encoder = new TextEncoder();
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 32) {
      if (globals.spaceLFOnReceive && code === 10) { output += ' '; continue; }
      if (code === 9 && !globals.escapeControlCharacterTab) { output += character; continue; }
      if (code === 0 || globals.escapeControlCharactersOnReceive) {
        if (globals.escapeControlCharactersCStyle) {
          output += `\\${C_STYLE_ESCAPES[code] ?? `x${hex(code)}`}`;
        } else {
          output += globals.controlCharacterEscapePrefix + octal(code);
        }
        continue;
      }
      output += character;
    } else if (code > 127 && globals.escape8BitCharactersOnReceive) {
      for (const byte of encoder.encode(character)) {
        output += globals.escapeControlCharactersCStyle
          ? `\\x${hex(byte)}`
          : globals.controlCharacterEscapePrefix + octal(byte);
      }
    } else {
      output += character;
    }
  }
  return output.length > globals.maxLine ? output.slice(0, globals.maxLine) : output;
}

export class Rfc5424Parser implements MessageParserModule {
  readonly name = 'rsyslog.rfc5424';

  parse(message: RsyslogMessage): ParseOutcome {
    const afterPri = message.rawMsgAfterPri;
    const parsed = parseRfc5424Body(afterPri, message.receivedAt);
    if (parsed === null) return 'could-not-parse';
    message.protocolVersion = 1;
    if (parsed.timestampFound && parsed.timestamp !== null) {
      message.timestamp = message.ignoreDate ? message.receivedAt : parsed.timestamp;
      message.hostname = parsed.hostname;
      message.appName = parsed.appName;
      message.procId = parsed.procId;
      message.msgId = parsed.msgId;
      message.structuredData = parsed.structuredData;
    }
    message.msg = parsed.message;
    return 'ok';
  }
}

export interface Rfc3164ParserSettings extends LegacyParserOptions {
  readonly headerlessRuleset: string | null;
}

export const DEFAULT_RFC3164_SETTINGS: Rfc3164ParserSettings = { ...DEFAULT_LEGACY_OPTIONS, headerlessRuleset: null };

export class Rfc3164Parser implements MessageParserModule {
  constructor(
    readonly name: string = 'rsyslog.rfc3164',
    private readonly settings: Rfc3164ParserSettings = DEFAULT_RFC3164_SETTINGS,
  ) {}

  parse(message: RsyslogMessage): ParseOutcome {
    message.protocolVersion = 0;
    const result = parseLegacyBody({
      afterPri: message.rawMsgAfterPri,
      receivedAt: message.receivedAt,
      fromHost: message.fromHost,
      internal: message.internal,
      ignoreDate: message.ignoreDate,
      parseHostname: message.parseHostname,
      invalidFacility: message.hasInvalidFacility,
    }, this.settings);
    if (result.discard) {
      message.discarded = true;
      return 'ok';
    }
    message.timestamp = result.timestamp;
    if (result.hostname !== null) message.hostname = result.hostname;
    if (result.tag !== null) message.tag = result.tag;
    if (result.headerless && this.settings.headerlessRuleset !== null) message.rulesetName = this.settings.headerlessRuleset;
    message.msg = result.message;
    return 'ok';
  }
}

export function defaultParserChain(): MessageParserModule[] {
  return [new Rfc5424Parser(), new Rfc3164Parser()];
}

export function parseReceivedMessage(
  message: RsyslogMessage, parsers: readonly MessageParserModule[], globals: ParserGlobals = DEFAULT_PARSER_GLOBALS,
): ParseOutcome | 'empty' {
  if (message.rawMsg.length === 0) return 'empty';
  message.rawMsg = sanitizeRawMessage(message.rawMsg, globals);
  if (message.rawMsg.length === 0) return 'empty';
  message.parsePriFromRaw();
  for (const parser of parsers) {
    if (parser.parse(message) !== 'could-not-parse') return 'ok';
  }
  return 'could-not-parse';
}
