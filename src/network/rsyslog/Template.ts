import { formatTimestamp3164, formatTimestamp3339 } from '@/network/syslog/codec/SyslogTime';
import { posixToJsSource } from '@/network/devices/linux/regex/PosixRegex';
import { jsonEscape } from './Json';
import type { JsonValue, RsyslogMessage } from './Message';
import { baseProperty, describeProperty, type DateFormat, type PropertyDescriptor, type RenderContext } from './Properties';

export class TemplateError extends Error {}

export type EscapeMode = 'none' | 'sql' | 'stdsql' | 'json' | 'jsonf';
export type RegexType = 'BRE' | 'ERE';
export type RegexNoMatch = 'DFLT' | 'BLANK' | 'FIELD' | 'ZERO';
export type CaseConversion = 'none' | 'lower' | 'upper';
export type ControlCharacters = 'none' | 'escape' | 'escape-octal' | 'space' | 'drop';
export type JsonFormat = 'none' | 'csv' | 'json' | 'jsonf' | 'jsonr' | 'jsonfr';
export type DataType = 'string' | 'number' | 'bool' | 'auto';
export type OnEmpty = 'keep' | 'skip' | 'null';
export type StrgenName =
  | 'RSYSLOG_TraditionalFileFormat' | 'RSYSLOG_FileFormat' | 'RSYSLOG_ForwardFormat' | 'RSYSLOG_TraditionalForwardFormat';

export const REGEX_MAX_MATCHES = 10;
export const STRGEN_NAMES: readonly StrgenName[] = [
  'RSYSLOG_TraditionalFileFormat', 'RSYSLOG_FileFormat', 'RSYSLOG_ForwardFormat', 'RSYSLOG_TraditionalForwardFormat',
];

export interface FieldOptions {
  dropLastLf: boolean;
  spaceIfNoFirstSpace: boolean;
  mandatory: boolean;
  omitIfZero: boolean;
  fixedWidth: boolean;
  compressSpaces: boolean;
  dateInUtc: boolean;
  fromPositionEndRelative: boolean;
  securePath: 'none' | 'drop' | 'replace';
  controlCharacters: ControlCharacters;
  format: JsonFormat;
  dataType: DataType;
  onEmpty: OnEmpty;
}

export interface RegexSpec {
  readonly type: RegexType;
  readonly source: string;
  readonly matcher: RegExp | null;
  matchToUse: number;
  subMatchToUse: number;
  noMatch: RegexNoMatch;
}

export interface ConstantEntry {
  readonly kind: 'constant';
  text: string;
  fieldName: string | null;
  jsonField: boolean;
}

export interface FieldEntry {
  readonly kind: 'field';
  descriptor: PropertyDescriptor;
  fieldName: string;
  options: FieldOptions;
  caseConversion: CaseConversion;
  dateFormat: DateFormat;
  complex: boolean;
  fromPosition: number;
  toPosition: number;
  fieldNumber: number | null;
  fieldDelimiter: number;
  regex: RegexSpec | null;
  badRegex: boolean;
}

export type TemplateEntry = ConstantEntry | FieldEntry;

export interface Template {
  readonly name: string;
  readonly kind: 'entries' | 'subtree' | 'strgen';
  entries: TemplateEntry[];
  escape: EscapeMode;
  jsonTree: boolean;
  caseSensitive: boolean;
  subtree: PropertyDescriptor | null;
  strgen: StrgenName | null;
}

export type TemplateParamValue = string | number | boolean;
export interface TemplateObject {
  readonly params: Readonly<Record<string, TemplateParamValue>>;
  readonly entries: readonly { readonly kind: 'constant' | 'property'; readonly params: Readonly<Record<string, TemplateParamValue>> }[];
}

export type Report = (message: string) => void;

const IGNORE: Report = () => undefined;

function defaultOptions(): FieldOptions {
  return {
    dropLastLf: false, spaceIfNoFirstSpace: false, mandatory: false, omitIfZero: false, fixedWidth: false,
    compressSpaces: false, dateInUtc: false, fromPositionEndRelative: false, securePath: 'none', controlCharacters: 'none',
    format: 'none', dataType: 'string', onEmpty: 'keep',
  };
}

function newField(descriptor: PropertyDescriptor, fieldName: string): FieldEntry {
  return {
    kind: 'field', descriptor, fieldName, options: defaultOptions(), caseConversion: 'none', dateFormat: 'default',
    complex: false, fromPosition: 0, toPosition: 0, fieldNumber: null, fieldDelimiter: 9, regex: null, badRegex: false,
  };
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

const INT_MAX = 2147483647;

function parseNonNegativeInt(text: string, start: number, report: Report, what: string): { value: number; next: number } {
  let position = start;
  let value = 0;
  let overflow = false;
  while (isDigit(text[position])) {
    const digit = text.charCodeAt(position) - 48;
    position++;
    if (value > Math.floor((INT_MAX - digit) / 10)) {
      overflow = true;
      value = INT_MAX;
      while (isDigit(text[position])) position++;
      break;
    }
    value = value * 10 + digit;
  }
  if (overflow) report(`error: ${what} in template is too large - using ${INT_MAX}`);
  return { value, next: position };
}

export function compileRegex(type: RegexType, source: string): RegExp | null {
  try {
    const js = posixToJsSource(source, { extended: type === 'ERE' });
    return new RegExp(js, 'd');
  } catch {
    return null;
  }
}

const DATE_OPTIONS: Readonly<Record<string, DateFormat>> = {
  'date-mysql': 'mysql', 'date-pgsql': 'pgsql', 'date-rfc3164': 'rfc3164', 'date-rfc3164-buggyday': 'rfc3164-buggyday',
  'date-rfc3339': 'rfc3339', 'date-unixtimestamp': 'unixtimestamp', 'date-subseconds': 'subseconds', 'date-wdayname': 'wdayname',
  'date-wday': 'wday', 'date-year': 'year', 'date-month': 'month', 'date-day': 'day', 'date-hour': 'hour',
  'date-minute': 'minute', 'date-second': 'second', 'date-tzoffshour': 'tzoffshour', 'date-tzoffsmin': 'tzoffsmin',
  'date-tzoffsdirection': 'tzoffsdirection', 'date-ordinal': 'ordinal', 'date-week': 'week', 'date-iso-week': 'iso-week',
  'date-iso-week-year': 'iso-week-year',
};

const FORMAT_OPTIONS: readonly JsonFormat[] = ['csv', 'json', 'jsonf', 'jsonr', 'jsonfr'];

function applyFieldOption(entry: FieldEntry, option: string, report: Report): void {
  const options = entry.options;
  const date = DATE_OPTIONS[option];
  if (date !== undefined) { entry.dateFormat = date; return; }
  switch (option) {
    case 'date-utc': options.dateInUtc = true; return;
    case 'lowercase': entry.caseConversion = 'lower'; return;
    case 'uppercase': entry.caseConversion = 'upper'; return;
    case 'sp-if-no-1st-sp': options.spaceIfNoFirstSpace = true; return;
    case 'compressspace': options.compressSpaces = true; return;
    case 'escape-cc': options.controlCharacters = 'escape'; return;
    case 'drop-cc': options.controlCharacters = 'drop'; return;
    case 'space-cc': options.controlCharacters = 'space'; return;
    case 'drop-last-lf': options.dropLastLf = true; return;
    case 'secpath-drop': options.securePath = 'drop'; return;
    case 'secpath-replace': options.securePath = 'replace'; return;
    case 'pos-end-relative': options.fromPositionEndRelative = true; return;
    case 'fixed-width': options.fixedWidth = true; return;
    case 'mandatory-field': options.mandatory = true; return;
    default:
  }
  if ((FORMAT_OPTIONS as readonly string[]).includes(option)) {
    if (options.format !== 'none') {
      report(`error: can only specify one option out of (json, jsonf, jsonr, jsonfr, csv) - ${option} ignored`);
    } else options.format = option as JsonFormat;
    return;
  }
  report(`template error: invalid field option '${option}' specified - ignored`);
}

function parseFieldOptions(text: string, start: number, entry: FieldEntry, report: Report): number {
  let position = start;
  while (position < text.length && text[position] !== '%' && text[position] !== ':') {
    let option = '';
    while (option.length < 63 && position < text.length && !'%:,'.includes(text[position])) {
      option += text[position].toLowerCase();
      position++;
    }
    while (position < text.length && !'%:,'.includes(text[position])) position++;
    if (text[position] === ',') position++;
    applyFieldOption(entry, option, report);
  }
  return position;
}

function startsWithWord(text: string, position: number, word: string): boolean {
  return text.startsWith(word, position) && (text[position + word.length] === ',' || text[position + word.length] === ':');
}

function parseParameter(text: string, start: number, templateName: string, report: Report): { entry: FieldEntry; next: number } {
  let position = start;
  let propertyName = '';
  while (position < text.length && text[position] !== '%' && text[position] !== ':') propertyName += text[position++];
  const descriptor = describeProperty(propertyName);
  const entry = newField(descriptor, propertyName);
  let regexType: RegexType = 'BRE';
  let regexRequested = false;
  let regexBad = false;
  let subMatch = 0;
  let match = 0;
  let noMatch: RegexNoMatch = 'DFLT';

  if (text[position] === ':') {
    entry.complex = true;
    position++;
    if (text[position] === 'R') {
      position++;
      if (text[position] === ',') {
        position++;
        if (startsWithWord(text, position, 'BRE')) { regexType = 'BRE'; position += 3; }
        else if (startsWithWord(text, position, 'ERE')) { regexType = 'ERE'; position += 3; }
        else report(`error: invalid regular expression type, rest of line ${text.slice(position)}`);
      }
      if (text[position] === ',') {
        position++;
        if (isDigit(text[position])) { subMatch = text.charCodeAt(position) - 48; position++; }
      }
      if (text[position] === ',') {
        position++;
        if (startsWithWord(text, position, 'DFLT')) { noMatch = 'DFLT'; position += 4; }
        else if (startsWithWord(text, position, 'BLANK')) { noMatch = 'BLANK'; position += 5; }
        else if (startsWithWord(text, position, 'FIELD')) { noMatch = 'FIELD'; position += 5; }
        else if (startsWithWord(text, position, 'ZERO')) { noMatch = 'ZERO'; position += 4; }
        else if (text[position] === ',') noMatch = 'DFLT';
        else report(`template ${templateName} error: invalid regular expression type, rest of line ${text.slice(position)}`);
      }
      if (text[position] === ',') {
        position++;
        if (isDigit(text[position])) { match = text.charCodeAt(position) - 48; position++; }
      }
      if (text[position] !== ':') {
        report(`error: invalid character in frompos after "R", property: '%${text.slice(start)}'`);
      } else regexRequested = true;
    } else if (text[position] === 'F') {
      position++;
      if (text[position] === ':') {
        entry.fieldNumber = 0;
        entry.fieldDelimiter = 9;
      } else if (text[position] === ',') {
        position++;
        entry.fieldNumber = 0;
        if (!isDigit(text[position])) {
          report(`error: invalid character in frompos after "F,", property: '%${text.slice(start)}' - using 9 (HT) as field delimiter`);
          entry.fieldDelimiter = 9;
        } else {
          const parsed = parseNonNegativeInt(text, position, report, 'delimiter value');
          position = parsed.next;
          if (parsed.value > 255) {
            report(`error: non-USASCII delimiter character value ${parsed.value} in template - using 9 (HT) as substitute`);
            entry.fieldDelimiter = 9;
          } else {
            entry.fieldDelimiter = parsed.value;
            if (text[position] === ',') {
              position++;
              const from = parseNonNegativeInt(text, position, report, 'frompos value');
              position = from.next;
              entry.fromPosition = from.value;
            } else if (text[position] !== ':') {
              throw new TemplateError(
                `error: invalid character '${text[position] ?? ''}' in frompos after "F,", property: '${text.slice(start)}' be sure to use DECIMAL character codes!`,
              );
            }
          }
        }
      } else {
        report(`error: invalid character in frompos after "F", property: '%${text.slice(start)}'`);
      }
    } else {
      const from = parseNonNegativeInt(text, position, report, 'frompos value');
      position = from.next;
      entry.fromPosition = from.value;
      while (position < text.length && text[position] !== '%' && text[position] !== ':') position++;
    }
  }

  let regexSource = '';
  if (text[position] === ':') {
    position++;
    if (regexRequested) {
      const end = text.indexOf('--end', position);
      if (end < 0) {
        regexRequested = false;
      } else {
        regexSource = text.slice(position, end);
        if (compileRegex(regexType, regexSource) === null) regexBad = true;
        position = end + 5;
      }
    } else if (text[position] === '$') {
      position++;
      entry.toPosition = 9999999;
    } else {
      if (entry.fieldNumber !== null) {
        const parsed = parseNonNegativeInt(text, position, report, 'field number');
        position = parsed.next;
        entry.fieldNumber = parsed.value;
        if (text[position] === ',') {
          position++;
          const to = parseNonNegativeInt(text, position, report, 'topos value');
          position = to.next;
          entry.toPosition = to.value;
        }
      } else {
        const to = parseNonNegativeInt(text, position, report, 'topos value');
        position = to.next;
        entry.toPosition = to.value;
      }
      while (position < text.length && text[position] !== '%' && text[position] !== ':') position++;
    }
  }

  if (text[position] === ':') {
    position++;
    position = parseFieldOptions(text, position, entry, report);
  }

  if (entry.options.fromPositionEndRelative) {
    if (entry.toPosition > entry.fromPosition) [entry.fromPosition, entry.toPosition] = [entry.toPosition, entry.fromPosition];
  } else if (entry.toPosition < entry.fromPosition) {
    [entry.fromPosition, entry.toPosition] = [entry.toPosition, entry.fromPosition];
  }

  if (text[position] === ':') {
    position++;
    let outName = '';
    while (position < text.length && text[position] !== ':' && text[position] !== '%') outName += text[position++];
    entry.fieldName = outName;
  } else if (descriptor.id === 'cee' || descriptor.id === 'local-var') {
    entry.fieldName = propertyName.slice(2);
  }
  if (position < text.length) position++;

  if (regexRequested) {
    entry.regex = {
      type: regexType, source: regexSource, matcher: regexBad ? null : compileRegex(regexType, regexSource),
      matchToUse: match, subMatchToUse: subMatch, noMatch,
    };
    entry.badRegex = regexBad;
  }
  return { entry, next: position };
}

function parseConstant(text: string, start: number, withEscapes: boolean): { entry: ConstantEntry; next: number } {
  let position = start;
  let value = '';
  while (position < text.length && text[position] !== '%' && !(withEscapes && text[position] === '"')) {
    if (withEscapes && text[position] === '\\') {
      position++;
      const escaped = text[position];
      if (escaped === undefined) {
        value += '\\';
      } else if (escaped === 'n') { value += '\n'; position++; }
      else if (escaped === 'r') { value += '\r'; position++; }
      else if (escaped === '\\') { value += '\\'; position++; }
      else if (escaped === '%') { value += '%'; position++; }
      else if (isDigit(escaped)) {
        const parsed = parseNonNegativeInt(text, position, IGNORE, 'numeric escape value');
        position = parsed.next;
        value += String.fromCharCode(Math.min(parsed.value, 255));
      } else { value += escaped; position++; }
    } else value += text[position++];
  }
  return { entry: { kind: 'constant', text: value, fieldName: null, jsonField: false }, next: position };
}

function applyCaseSensitivity(template: Template): void {
  if (template.caseSensitive) return;
  for (const entry of template.entries) {
    if (entry.kind !== 'field') continue;
    const id = entry.descriptor.id;
    if (id === 'cee' || id === 'local-var' || id === 'global-var') {
      entry.fieldName = entry.fieldName.toLowerCase();
      entry.descriptor = { id, name: entry.descriptor.name.toLowerCase() };
    }
  }
}

function newTemplate(name: string, kind: Template['kind']): Template {
  return { name, kind, entries: [], escape: 'none', jsonTree: false, caseSensitive: false, subtree: null, strgen: null };
}

function jsonKey(entry: TemplateEntry): string | null {
  if (entry.fieldName === null || entry.fieldName.length === 0) return null;
  if (entry.kind === 'constant') return entry.jsonField ? entry.fieldName : null;
  return entry.options.format === 'jsonf' || entry.options.format === 'jsonfr' ? entry.fieldName : null;
}

function warnDuplicateJsonKeys(template: Template, report: Report): void {
  template.entries.forEach((entry, index) => {
    const key = jsonKey(entry);
    if (key === null) return;
    for (let earlier = 0; earlier < index; earlier++) {
      if (jsonKey(template.entries[earlier]) === key) {
        report(`template '${template.name}': duplicate JSON key '${key}' encountered; later definition takes precedence`);
        break;
      }
    }
  });
}

function finishTemplate(template: Template, report: Report): Template {
  applyCaseSensitivity(template);
  if (template.escape === 'jsonf') warnDuplicateJsonKeys(template, report);
  return template;
}

export function parseStringTemplate(name: string, text: string, report: Report = IGNORE): Template {
  const template = newTemplate(name, 'entries');
  let position = 0;
  while (position < text.length) {
    if (text[position] === '%') {
      const parsed = parseParameter(text, position + 1, name, report);
      template.entries.push(parsed.entry);
      position = parsed.next;
    } else {
      const parsed = parseConstant(text, position, false);
      template.entries.push(parsed.entry);
      position = parsed.next;
    }
  }
  return finishTemplate(template, report);
}

export function parseLegacyTemplate(name: string, restOfLine: string, report: Report = IGNORE): Template | null {
  let position = 0;
  while (/\s/.test(restOfLine[position] ?? '')) position++;
  if (restOfLine[position] === '=') {
    const strgenName = restOfLine.slice(position + 1).trim().split(/\s+/)[0];
    return strgenTemplate(name, strgenName, report);
  }
  if (restOfLine[position] !== '"') {
    report(`Template '${name}' invalid, does not start with '"'!`);
    return null;
  }
  position++;
  const template = newTemplate(name, 'entries');
  let done = position >= restOfLine.length;
  while (!done) {
    if (position >= restOfLine.length) {
      done = true;
    } else if (restOfLine[position] === '%') {
      try {
        const parsed = parseParameter(restOfLine, position + 1, name, report);
        template.entries.push(parsed.entry);
        position = parsed.next;
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
        return null;
      }
    } else {
      const parsed = parseConstant(restOfLine, position, true);
      template.entries.push(parsed.entry);
      position = parsed.next;
    }
    if (restOfLine[position] === '"') {
      position++;
      done = true;
    }
  }
  while (position < restOfLine.length) {
    while (/\s/.test(restOfLine[position] ?? '')) position++;
    if (restOfLine[position] !== ',') break;
    position++;
    while (/\s/.test(restOfLine[position] ?? '')) position++;
    let option = '';
    while (option.length < 127 && position < restOfLine.length && !'=,\n'.includes(restOfLine[position])) {
      option += restOfLine[position++].toLowerCase();
    }
    if (restOfLine[position] === '\n') position++;
    switch (option) {
      case 'stdsql': template.escape = 'stdsql'; break;
      case 'json': template.escape = 'json'; break;
      case 'sql': template.escape = 'sql'; break;
      case 'nosql': template.escape = 'none'; break;
      case 'casesensitive': template.caseSensitive = true; break;
      case 'jsonf': template.escape = 'jsonf'; template.jsonTree = false; break;
      case 'jsonftree': template.escape = 'jsonf'; template.jsonTree = true; break;
      default:
    }
  }
  return finishTemplate(template, report);
}

export function strgenTemplate(name: string, strgenName: string, report: Report = IGNORE): Template | null {
  const known = STRGEN_NAMES.find((candidate) => candidate === strgenName);
  if (known === undefined) {
    report(`Template '${name}': error defining template via strgen module: strgen '${strgenName}' not found`);
    return null;
  }
  const template = newTemplate(name, 'strgen');
  template.strgen = known;
  return template;
}

function asString(value: TemplateParamValue | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function asBoolean(value: TemplateParamValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value === 'on' || value === '1' || value === 'yes' || value === 'true';
}

function asInteger(value: TemplateParamValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function choose<T extends string>(value: TemplateParamValue | undefined, table: Readonly<Record<string, T>>, what: string, label: string): T | undefined {
  if (value === undefined) return undefined;
  const found = table[String(value)];
  if (found === undefined) throw new TemplateError(`invalid ${what} '${String(value)}' for ${label}`);
  return found;
}

const CONSTANT_PARAMS = new Set(['value', 'format', 'outname']);
const PROPERTY_PARAMS = new Set([
  'name', 'outname', 'dateformat', 'date.inutc', 'compressspace', 'caseconversion', 'controlcharacters', 'securepath', 'format',
  'position.from', 'position.to', 'position.relativetoend', 'field.number', 'field.delimiter', 'regex.expression', 'regex.type',
  'regex.nomatchmode', 'regex.match', 'regex.submatch', 'droplastlf', 'fixedwidth', 'datatype', 'onempty', 'mandatory',
  'omitifzero', 'spifno1stsp',
]);
const TEMPLATE_PARAMS = new Set([
  'name', 'type', 'string', 'plugin', 'subtree', 'option.stdsql', 'option.sql', 'option.json', 'option.jsonf', 'option.jsonftree',
  'option.casesensitive',
]);

function rejectUnknown(params: Readonly<Record<string, TemplateParamValue>>, allowed: Set<string>, what: string, report: Report): void {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key.toLowerCase())) report(`${what} parameter '${key}' not known -- typo in config file?`);
  }
}

function lowerKeys(params: Readonly<Record<string, TemplateParamValue>>): Record<string, TemplateParamValue> {
  const out: Record<string, TemplateParamValue> = {};
  for (const [key, value] of Object.entries(params)) out[key.toLowerCase()] = value;
  return out;
}

export function unescapeConfigString(text: string): string {
  return text.replace(/\\(.)/gs, (_whole, character: string) => {
    switch (character) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return character;
    }
  });
}

function constantFromParams(raw: Readonly<Record<string, TemplateParamValue>>, report: Report): ConstantEntry {
  rejectUnknown(raw, CONSTANT_PARAMS, 'constant', report);
  const params = lowerKeys(raw);
  const value = asString(params.value);
  if (value === undefined) throw new TemplateError('constant template entry is missing mandatory value parameter');
  const outname = asString(params.outname);
  let jsonField = false;
  if (params.format !== undefined) {
    if (String(params.format) !== 'jsonf') throw new TemplateError(`invalid format type '${String(params.format)}' for constant`);
    jsonField = true;
  }
  if (jsonField && outname === undefined) throw new TemplateError('constant set to format jsonf, but outname not specified - aborting');
  const text = unescapeConfigString(value);
  if (jsonField && outname !== undefined) {
    const fragment = `"${jsonEscape(outname, true)}": "${jsonEscape(text, true)}"`;
    return { kind: 'constant', text: fragment, fieldName: outname, jsonField: true };
  }
  return { kind: 'constant', text, fieldName: outname ?? null, jsonField: false };
}

const DATE_FORMAT_NAMES: Readonly<Record<string, DateFormat>> = {
  mysql: 'mysql', pgsql: 'pgsql', rfc3164: 'rfc3164', 'rfc3164-buggyday': 'rfc3164-buggyday', rfc3339: 'rfc3339',
  unixtimestamp: 'unixtimestamp', subseconds: 'subseconds', wdayname: 'wdayname', wday: 'wday', year: 'year', month: 'month',
  day: 'day', hour: 'hour', minute: 'minute', second: 'second', tzoffshour: 'tzoffshour', tzoffsmin: 'tzoffsmin',
  tzoffsdirection: 'tzoffsdirection', ordinal: 'ordinal', week: 'week',
};

function propertyFromParams(templateName: string, raw: Readonly<Record<string, TemplateParamValue>>, report: Report): FieldEntry {
  rejectUnknown(raw, PROPERTY_PARAMS, 'property', report);
  const params = lowerKeys(raw);
  const name = asString(params.name) ?? '';
  const descriptor = describeProperty(name);
  let outname = asString(params.outname);
  if (outname === undefined) outname = name.startsWith('$!') ? name.slice(2) : name;
  const entry = newField(descriptor, outname);
  const options = entry.options;

  options.dataType = choose(params.datatype, { string: 'string', number: 'number', bool: 'bool', auto: 'auto' }, 'dataType', 'property') ?? 'string';
  options.onEmpty = choose(params.onempty, { keep: 'keep', skip: 'skip', null: 'null' }, 'onEmpty value', 'property') ?? 'keep';
  entry.dateFormat = choose(params.dateformat, DATE_FORMAT_NAMES, 'date format', 'property') ?? 'default';
  entry.caseConversion = choose(params.caseconversion, { lower: 'lower', upper: 'upper' }, 'caseconversion type', 'property') ?? 'none';
  options.controlCharacters = choose(
    params.controlcharacters,
    { escape: 'escape', 'escape-octal': 'escape-octal', space: 'space', drop: 'drop' }, 'controlcharacter mode', 'property',
  ) ?? 'none';
  options.securePath = choose(params.securepath, { drop: 'drop', replace: 'replace' }, 'securepath mode', 'property') ?? 'none';
  options.format = choose(
    params.format, { csv: 'csv', json: 'json', jsonf: 'jsonf', jsonr: 'jsonr', jsonfr: 'jsonfr' }, 'format type', 'property',
  ) ?? 'none';
  const regexType = choose(params['regex.type'], { BRE: 'BRE', ERE: 'ERE' }, 'regex.type', 'property') ?? 'BRE';
  const noMatch = choose(
    params['regex.nomatchmode'], { DFLT: 'DFLT', BLANK: 'BLANK', FIELD: 'FIELD', ZERO: 'ZERO' }, 'format type', 'property',
  ) ?? 'DFLT';

  options.dropLastLf = asBoolean(params.droplastlf);
  options.fixedWidth = asBoolean(params.fixedwidth);
  options.mandatory = asBoolean(params.mandatory);
  options.omitIfZero = asBoolean(params.omitifzero);
  options.spaceIfNoFirstSpace = asBoolean(params.spifno1stsp);
  options.compressSpaces = asBoolean(params.compressspace);
  options.dateInUtc = asBoolean(params['date.inutc']);
  options.fromPositionEndRelative = asBoolean(params['position.relativetoend']);

  let from = asInteger(params['position.from']) ?? -1;
  let to = asInteger(params['position.to']) ?? 0;
  const toSet = params['position.to'] !== undefined;
  const fieldNumber = asInteger(params['field.number']) ?? -1;
  const regexExpression = asString(params['regex.expression']);

  if (!toSet && from !== -1) to = 2000000000;
  if (from === -1 && toSet) from = 0;
  if (options.fromPositionEndRelative) {
    if (to > from) throw new TemplateError(`position.to=${to} is higher than postion.from=${from} in 'relativeToEnd' mode`);
  } else if (to >= 0 && to < from) {
    throw new TemplateError(`position.to=${to} is lower than postion.from=${from}`);
  }
  if (fieldNumber !== -1 && regexExpression !== undefined) {
    throw new TemplateError('both field extraction and regex extraction specified - this is not possible, remove one');
  }
  const matchToUse = asInteger(params['regex.match']) ?? 0;
  const subMatchToUse = asInteger(params['regex.submatch']) ?? 0;
  if (regexExpression !== undefined) {
    for (const [label, selector] of [['regex.match', matchToUse], ['regex.submatch', subMatchToUse]] as const) {
      if (selector < 0 || selector >= REGEX_MAX_MATCHES) {
        throw new TemplateError(`template ${templateName} error: ${label}=${selector} is invalid (supported range 0..${REGEX_MAX_MATCHES - 1})`);
      }
    }
  }

  entry.complex = [
    'droplastlf', 'fixedwidth', 'spifno1stsp', 'position.from', 'position.to', 'field.number', 'field.delimiter',
    'regex.expression', 'regex.type', 'regex.nomatchmode', 'regex.match', 'regex.submatch', 'format', 'controlcharacters',
    'securepath', 'caseconversion', 'compressspace',
  ].some((key) => params[key] !== undefined);

  if (fieldNumber !== -1) {
    entry.fieldNumber = fieldNumber;
    entry.fieldDelimiter = asInteger(params['field.delimiter']) ?? 9;
  }
  if (from !== -1) {
    entry.fromPosition = from;
    entry.toPosition = to;
  }
  if (regexExpression !== undefined) {
    const matcher = compileRegex(regexType, regexExpression);
    if (matcher === null) throw new TemplateError(`error compiling regex '${regexExpression}'`);
    entry.regex = { type: regexType, source: regexExpression, matcher, matchToUse, subMatchToUse, noMatch };
  }
  return entry;
}

export function templateFromObject(object: TemplateObject, report: Report = IGNORE): Template {
  rejectUnknown(object.params, TEMPLATE_PARAMS, 'template', report);
  const params = lowerKeys(object.params);
  const name = asString(params.name);
  if (name === undefined) throw new TemplateError('template: parameter "name" is required');
  const type = asString(params.type);
  if (type === undefined) throw new TemplateError(`template '${name}': parameter "type" is required`);
  if (!['string', 'plugin', 'list', 'subtree'].includes(type)) throw new TemplateError(`invalid template type '${type}'`);
  const text = asString(params.string);
  const plugin = asString(params.plugin);
  const subtree = asString(params.subtree);
  if (subtree !== undefined && !subtree.startsWith('$!')) {
    throw new TemplateError(`invalid subtree parameter, variable must start with '$!' but var name is '${subtree}'`);
  }
  if (text === undefined && type === 'string') throw new TemplateError(`template '${name}' of type string needs string parameter`);
  if (text !== undefined && type !== 'string') report(`template '${name}' is not a string template but has a string specified - ignored`);
  if (plugin === undefined && type === 'plugin') throw new TemplateError(`template '${name}' of type plugin needs plugin parameter`);
  if (plugin !== undefined && type !== 'plugin') report(`template '${name}' is not a plugin template but has a plugin specified - ignored`);
  if (subtree === undefined && type === 'subtree') throw new TemplateError(`template '${name}' of type subtree needs subtree parameter`);
  if (subtree !== undefined && type !== 'subtree') report(`template '${name}' is not a subtree template but has a subtree specified - ignored`);
  if (object.entries.length === 0 && type === 'list') throw new TemplateError(`template '${name}' of type list has no parameters specified`);
  if (object.entries.length > 0 && type !== 'list') report(`template '${name}' is not a list template but has parameters specified - ignored`);

  const sql = asBoolean(params['option.sql']);
  const stdsql = asBoolean(params['option.stdsql']);
  const json = asBoolean(params['option.json']);
  const jsonf = asBoolean(params['option.jsonf']);
  const jsonftree = asBoolean(params['option.jsonftree']);
  if ([sql, stdsql, json, jsonf, jsonftree].filter(Boolean).length > 1) {
    throw new TemplateError(`template '${name}' has multiple incompatible options of sql, stdsql, json, jsonf or jsonftree specified`);
  }

  let template: Template;
  switch (type) {
    case 'string': {
      const built = parseStringTemplate(name, text ?? '', report);
      template = built;
      break;
    }
    case 'plugin': {
      const built = strgenTemplate(name, plugin ?? '', report);
      if (built === null) throw new TemplateError(`template '${name}': error defining template via plugin (strgen) module`);
      template = built;
      break;
    }
    case 'list': {
      template = newTemplate(name, 'entries');
      for (const sub of object.entries) {
        template.entries.push(sub.kind === 'property' ? propertyFromParams(name, sub.params, report) : constantFromParams(sub.params, report));
      }
      break;
    }
    default: {
      template = newTemplate(name, 'subtree');
      template.subtree = describeProperty(subtree ?? '');
    }
  }
  if (stdsql) template.escape = 'stdsql';
  else if (sql) template.escape = 'sql';
  else if (json) template.escape = 'json';
  else if (jsonf || jsonftree) template.escape = 'jsonf';
  template.jsonTree = jsonftree;
  template.caseSensitive = asBoolean(params['option.casesensitive']);
  return finishTemplate(template, report);
}

const STANDARD_TEMPLATE_TEXT: ReadonlyArray<readonly [string, string, EscapeMode]> = [
  ['RSYSLOG_DebugFormat',
    "Debug line with all properties:\nFROMHOST: '%FROMHOST%', fromhost-ip: '%fromhost-ip%', HOSTNAME: '%HOSTNAME%', PRI: %PRI%,\nsyslogtag '%syslogtag%', programname: '%programname%', APP-NAME: '%APP-NAME%', PROCID: '%PROCID%', MSGID: '%MSGID%',\nTIMESTAMP: '%TIMESTAMP%', STRUCTURED-DATA: '%STRUCTURED-DATA%',\nmsg: '%msg%'\nescaped msg: '%msg:::drop-cc%'\ninputname: %inputname% rawmsg: '%rawmsg%'\n$!:%$!%\n$.:%$.%\n$/:%$/%\n\n",
    'none'],
  ['RSYSLOG_SyslogProtocol23Format', '<%PRI%>1 %TIMESTAMP:::date-rfc3339% %HOSTNAME% %APP-NAME% %PROCID% %MSGID% %STRUCTURED-DATA% %msg%\n', 'none'],
  ['RSYSLOG_SyslogRFC5424Format', '<%PRI%>1 %TIMESTAMP:::date-rfc3339% %HOSTNAME% %APP-NAME% %PROCID% %MSGID% %STRUCTURED-DATA% %msg%', 'none'],
  [' WallFmt', '\r\n\x07Message from syslogd@%HOSTNAME% at %timegenerated% ...\r\n %syslogtag%%msg%\n\r', 'none'],
  [' StdUsrMsgFmt', ' %syslogtag%%msg%\n\r', 'none'],
  [' StdDBFmt',
    "insert into SystemEvents (Message, Facility, FromHost, Priority, DeviceReportedTime, ReceivedAt, InfoUnitID, SysLogTag) values ('%msg%', %syslogfacility%, '%HOSTNAME%', %syslogpriority%, '%timereported:::date-mysql%', '%timegenerated:::date-mysql%', %iut%, '%syslogtag%')",
    'sql'],
  [' StdPgSQLFmt',
    "insert into SystemEvents (Message, Facility, FromHost, Priority, DeviceReportedTime, ReceivedAt, InfoUnitID, SysLogTag) values ('%msg%', %syslogfacility%, '%HOSTNAME%', %syslogpriority%, '%timereported:::date-pgsql%', '%timegenerated:::date-pgsql%', %iut%, '%syslogtag%')",
    'stdsql'],
  ['RSYSLOG_omudpspoofDfltSourceTpl', '%fromhost-ip%', 'none'],
  ['RSYSLOG_SysklogdFileFormat', '%TIMESTAMP% %HOSTNAME% %syslogtag%%msg:::sp-if-no-1st-sp%%msg%\n', 'none'],
  [' StdJSONFmt',
    '{"message":"%msg:::json%","fromhost":"%HOSTNAME:::json%","facility":"%syslogfacility-text%","priority":"%syslogpriority-text%","timereported":"%timereported:::date-rfc3339%","timegenerated":"%timegenerated:::date-rfc3339%"}',
    'none'],
  [' FullJSONFmt',
    '{"message":"%msg:::json%","fromhost":"%HOSTNAME:::json%","programname":"%programname%","procid":"%PROCID%","msgid":"%MSGID%","facility":"%syslogfacility-text%","priority":"%syslogpriority-text%","timereported":"%timereported:::date-rfc3339%","timegenerated":"%timegenerated:::date-rfc3339%"}',
    'none'],
  [' StdClickHouseFmt',
    "INSERT INTO rsyslog.SystemEvents (severity, facility, timestamp, hostname, tag, message) VALUES (%syslogseverity%, %syslogfacility%, '%timereported:::date-unixtimestamp%', '%hostname%', '%syslogtag%', '%msg%')",
    'stdsql'],
  [' StdOmSenderTrack-senderid', '%fromhost-ip%', 'none'],
  ['RSYSLOG_PerSourceKey', '%hostname%', 'none'],
];

export function standardTemplates(): Template[] {
  const templates: Template[] = [];
  for (const [name, text, escape] of STANDARD_TEMPLATE_TEXT) {
    const template = parseStringTemplate(name, text);
    template.escape = escape;
    templates.push(template);
  }
  for (const strgenName of STRGEN_NAMES) {
    const template = strgenTemplate(strgenName, strgenName);
    if (template !== null) templates.push(template);
  }
  return templates;
}

function isControl(code: number): boolean {
  return code < 32 || code === 127;
}

function asciiCase(text: string, upper: boolean): string {
  return upper ? text.replace(/[a-z]/g, (character) => character.toUpperCase()) : text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function extractField(value: string, entry: FieldEntry): string | null {
  const wanted = entry.fieldNumber ?? 0;
  const delimiter = String.fromCharCode(entry.fieldDelimiter);
  let current = 1;
  let position = 0;
  while (position < value.length && current < wanted) {
    while (position < value.length && value[position] !== delimiter) position++;
    if (value[position] === delimiter) {
      position++;
      current++;
    }
  }
  if (current !== wanted) return null;
  let end = position;
  while (end < value.length && value[end] !== delimiter) end++;
  return value.slice(position, end);
}

function noMatchText(mode: RegexNoMatch, whole: string): string {
  switch (mode) {
    case 'DFLT': return '**NO MATCH**';
    case 'ZERO': return '0';
    case 'FIELD': return whole;
    default: return '';
  }
}

function extractRegex(value: string, regex: RegexSpec): string {
  const matcher = regex.matcher;
  if (matcher === null) return '**NO MATCH** **BAD REGULAR EXPRESSION**';
  let offset = 0;
  let attempt = 0;
  let found: RegExpExecArray | null = null;
  for (;;) {
    const result = matcher.exec(value.slice(offset));
    if (result === null) break;
    if (attempt === regex.matchToUse) {
      found = result;
      break;
    }
    offset += result.index + result[0].length;
    attempt++;
  }
  if (found === null) return noMatchText(regex.noMatch, value);
  const indices = (found as RegExpExecArray & { indices?: ([number, number] | undefined)[] }).indices;
  const span = indices?.[regex.subMatchToUse];
  if (span === undefined) return '';
  return value.slice(offset + span[0], offset + span[1]);
}

function extractSubstring(value: string, entry: FieldEntry): string {
  const length = value.length;
  let from = entry.fromPosition;
  let to = entry.toPosition;
  if (entry.options.fromPositionEndRelative) {
    from = length < from ? 0 : length - from;
    to = length < to ? 0 : length - to;
  } else {
    if (from > 0) from--;
    if (to > 0) to--;
    else if (to < 0) to = to < 1 - length ? 0 : length - 1 + to;
  }
  if (from < 0) from = 0;
  if (from >= length) return '';
  if (from === 0 && to >= length && !entry.options.fixedWidth) return value;
  if (to >= length && !entry.options.fixedWidth) to = length - 1;
  const count = to < from ? 0 : to - from + 1;
  const slice = value.slice(from, from + count);
  return slice.length < count ? slice + ' '.repeat(count - slice.length) : slice;
}

function stripControl(value: string, mode: ControlCharacters): string {
  if (value.length === 0) return value;
  switch (mode) {
    case 'drop': return [...value].filter((character) => !isControl(character.charCodeAt(0))).join('');
    case 'space': return [...value].map((character) => (isControl(character.charCodeAt(0)) ? ' ' : character)).join('');
    case 'escape':
    case 'escape-octal':
      return [...value].map((character) => {
        const code = character.charCodeAt(0);
        if (!isControl(code)) return character;
        return mode === 'escape-octal'
          ? `#${(code >> 6) & 7}${(code >> 3) & 7}${code & 7}`
          : `#${String(Math.floor(code / 100))}${String(Math.floor(code / 10) % 10)}${String(code % 10)}`;
      }).join('');
    default: return value;
  }
}

function securePath(value: string, mode: 'drop' | 'replace'): string {
  let result = mode === 'drop' ? value.replace(/\//g, '') : value.replace(/\//g, '_');
  if (result === '') result = '_';
  else if (result === '.') result = '_';
  else if (result === '..') result = '_.';
  return result;
}

function compressSpaces(value: string): string {
  return value.replace(/ {2,}/g, ' ');
}

function jsonValue(value: string, escapeAll: boolean): string {
  return jsonEscape(value, escapeAll);
}

function formatJsonField(value: string, entry: FieldEntry, escapeAll: boolean): string {
  const options = entry.options;
  let text = value;
  let numeric = true;
  if (text.length === 0) {
    if (options.onEmpty === 'skip') return '';
    numeric = false;
  } else if (options.dataType === 'number') {
    text = text.replace(/^\s+|\s+$/g, '');
    if (options.omitIfZero && text === '0') return '';
  }
  const prefix = `"${entry.fieldName}":`;
  if (text.length === 0 && options.onEmpty === 'null') return `${prefix}null`;
  switch (options.dataType) {
    case 'auto': {
      if (!/^[0-9]*$/.test(text)) numeric = false;
      return numeric ? `${prefix}${jsonValue(text, escapeAll)}` : `${prefix}"${jsonValue(text, escapeAll)}"`;
    }
    case 'string': return `${prefix}"${jsonValue(text, escapeAll)}"`;
    case 'number': return text.length === 0 ? `${prefix}0` : `${prefix}${jsonValue(text, escapeAll)}`;
    default: return text === '0' ? `${prefix}false` : `${prefix}true`;
  }
}

export function renderField(entry: FieldEntry, message: RsyslogMessage, context: RenderContext): string {
  let value = baseProperty(entry.descriptor, message, context, { format: entry.dateFormat, utc: entry.options.dateInUtc });
  if (!entry.complex) return value;
  const options = entry.options;
  if (entry.fieldNumber !== null) {
    const field = extractField(value, entry);
    if (field === null) return '**FIELD NOT FOUND**';
    value = field;
  } else if (entry.regex !== null || entry.badRegex) {
    if (entry.badRegex || entry.regex === null) return '**NO MATCH** **BAD REGULAR EXPRESSION**';
    value = extractRegex(value, entry.regex);
  }
  if (entry.fromPosition !== 0 || entry.toPosition !== 0) value = extractSubstring(value, entry);
  if (value.length > 0 && options.spaceIfNoFirstSpace) value = value[0] === ' ' ? '' : ' ';
  if (value.length > 0) {
    if (entry.caseConversion !== 'none') value = asciiCase(value, entry.caseConversion === 'upper');
    value = stripControl(value, options.controlCharacters);
  }
  if (options.securePath !== 'none') value = securePath(value, options.securePath);
  if (options.dropLastLf && options.controlCharacters !== 'escape' && value.endsWith('\n')) value = value.slice(0, -1);
  if (options.compressSpaces) value = compressSpaces(value);
  switch (options.format) {
    case 'csv': return `"${value.replace(/"/g, '""')}"`;
    case 'json': return jsonValue(value, true);
    case 'jsonr': return jsonValue(value, false);
    case 'jsonf': return formatJsonField(value, entry, true);
    case 'jsonfr': return formatJsonField(value, entry, false);
    default: return value;
  }
}

function escapeForMode(value: string, mode: EscapeMode): string {
  switch (mode) {
    case 'stdsql':
      return value.includes("'") ? value.replace(/'/g, "''") : value;
    case 'sql':
      return /['\\]/.test(value) ? value.replace(/['\\]/g, (character) => `\\${character}`) : value;
    case 'json':
      if (/^["\\]*$/.test(value)) return value;
      return value.replace(/["\\]/g, (character) => `\\${character}`);
    default: return value;
  }
}

interface TreeNode {
  readonly name: string;
  readonly children: TreeNode[];
  entry: TemplateEntry | null;
}

function buildJsonTree(template: Template): TreeNode | null {
  const root: TreeNode = { name: '', children: [], entry: null };
  for (const entry of template.entries) {
    if (entry.fieldName === null || entry.fieldName.length === 0) return null;
    if (jsonKey(entry) === null) return null;
    let parent = root;
    const segments = entry.fieldName.split('.');
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index];
      if (segment.length === 0) return null;
      let child = parent.children.find((candidate) => candidate.name === segment);
      if (child === undefined) {
        child = { name: segment, children: [], entry: null };
        parent.children.push(child);
      } else if (child.entry !== null) return null;
      parent = child;
    }
    const leaf = segments[segments.length - 1];
    if (leaf.length === 0) return null;
    const existing = parent.children.find((candidate) => candidate.name === leaf);
    if (existing === undefined) parent.children.push({ name: leaf, children: [], entry });
    else if (existing.entry === null) return null;
    else existing.entry = entry;
  }
  return root;
}

function leafFragment(node: TreeNode, message: RsyslogMessage, context: RenderContext): string | null {
  const entry = node.entry;
  if (entry === null) return null;
  const value = entry.kind === 'constant' ? entry.text : renderField(entry, message, context);
  if (value.length === 0) return null;
  let body = value;
  const colon = value.indexOf(':');
  if (colon >= 0 && entry.fieldName !== null) {
    const key = value.slice(0, colon).trim();
    if (key.length >= 2 && key.startsWith('"') && key.endsWith('"') && key.slice(1, -1) === entry.fieldName) {
      body = value.slice(colon + 1);
      if (body.length === 0) return null;
    }
  }
  if (entry.kind === 'field' && entry.options.dataType === 'number') {
    body = body.replace(/^\s+|\s+$/g, '');
    if (entry.options.omitIfZero && body === '0') return null;
  }
  if (body.length === 0) return null;
  return `"${node.name}":${body}`;
}

function renderTreeChildren(parent: TreeNode, message: RsyslogMessage, context: RenderContext): string[] {
  const parts: string[] = [];
  for (const child of parent.children) {
    if (child.entry !== null) {
      const fragment = leafFragment(child, message, context);
      if (fragment !== null) parts.push(fragment);
    } else {
      const inner = renderTreeChildren(child, message, context);
      if (inner.length > 0) parts.push(`"${child.name}": {${inner.join(', ')}}`);
    }
  }
  return parts;
}

function strgenOutput(name: StrgenName, message: RsyslogMessage): string {
  const body = message.msg;
  const space = body[0] === ' ' ? '' : ' ';
  const host = message.hostnameOrSender;
  const tag = message.effectiveTag;
  switch (name) {
    case 'RSYSLOG_TraditionalFileFormat':
      return `${formatTimestamp3164(message.timestamp, false)} ${host} ${tag}${space}${body}\n`;
    case 'RSYSLOG_FileFormat':
      return `${formatTimestamp3339(message.timestamp)} ${host} ${tag}${space}${body}\n`;
    case 'RSYSLOG_ForwardFormat':
      return `<${message.pri}>${formatTimestamp3339(message.timestamp)} ${host} ${tag.slice(0, 32)}${space}${body}`;
    default:
      return `<${message.pri}>${formatTimestamp3164(message.timestamp, false)} ${host} ${tag.slice(0, 32)}${space}${body}`;
  }
}

export function renderTemplate(template: Template, message: RsyslogMessage, context: RenderContext): string {
  if (template.kind === 'strgen') return strgenOutput(template.strgen ?? 'RSYSLOG_FileFormat', message);
  if (template.kind === 'subtree') return baseProperty(template.subtree ?? describeProperty(''), message, context, { format: 'default', utc: false });
  if (template.escape === 'jsonf' && template.jsonTree) {
    const root = buildJsonTree(template);
    if (root !== null) return `{${renderTreeChildren(root, message, context).join(', ')}}\n`;
  }
  const flat = template.escape === 'jsonf';
  const parts: string[] = [];
  let output = '';
  for (const entry of template.entries) {
    let value: string;
    if (entry.kind === 'constant') value = entry.text;
    else {
      value = renderField(entry, message, context);
      value = escapeForMode(value, template.escape);
    }
    if (flat) {
      if (value.length > 0) parts.push(value);
    } else output += value;
  }
  return flat ? `{${parts.join(', ')}}\n` : output;
}

export function renderTemplateJson(template: Template, message: RsyslogMessage, context: RenderContext): JsonValue {
  if (template.kind === 'subtree') {
    const descriptor = template.subtree ?? describeProperty('');
    const root = descriptor.name === '' ? message.cee : readTree(message.cee, descriptor.name);
    return root === undefined ? {} : root;
  }
  const result: { [key: string]: JsonValue } = {};
  for (const entry of template.entries) {
    if (entry.kind === 'constant') {
      if (entry.fieldName === null) continue;
      result[entry.fieldName] = entry.text;
      continue;
    }
    const id = entry.descriptor.id;
    if (id === 'cee' || id === 'local-var' || id === 'global-var') {
      const source = id === 'cee' ? message.cee : id === 'local-var' ? message.localVariables : context.globalVariables;
      const found = readTree(source, entry.descriptor.name);
      if (found !== undefined) result[entry.fieldName] = found;
      else if (entry.options.mandatory) result[entry.fieldName] = null;
      continue;
    }
    const text = renderField(entry, message, context);
    if (entry.options.mandatory || text.length > 0) result[entry.fieldName] = text;
  }
  return result;
}

function readTree(root: { [key: string]: JsonValue }, path: string): JsonValue | undefined {
  let current: JsonValue = root;
  for (const segment of path.split('!').filter((part) => part.length > 0)) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const next: JsonValue | undefined = current[segment];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}
