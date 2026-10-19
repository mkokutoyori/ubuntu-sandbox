import {
  formatSecFrac, formatTimestamp3164, formatTimestamp3339, formatTimestampMySql, formatTimestampPgSql, formatTimestampUnix,
  isoWeek, ordinalDay, syslogTimeFromEpochMs, syslogTimeToEpochMs, weekNumber, weekdayNumber,
  WEEKDAY_NAMES, type SyslogTime,
} from '@/network/syslog/codec/SyslogTime';
import { jsonGet, jsonText, jsonToString } from './Json';
import type { JsonValue, RsyslogMessage } from './Message';

export type DateFormat =
  | 'default' | 'mysql' | 'pgsql' | 'rfc3164' | 'rfc3164-buggyday' | 'rfc3339' | 'unixtimestamp' | 'subseconds'
  | 'wdayname' | 'wday' | 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'tzoffshour' | 'tzoffsmin'
  | 'tzoffsdirection' | 'ordinal' | 'week' | 'iso-week' | 'iso-week-year';

export interface RenderContext {
  now(): SyslogTime;
  nowUtc(): SyslogTime;
  localHostName(): string;
  uptimeSeconds(): number;
  globalVariables: { [key: string]: JsonValue };
}

export type PropertyId =
  | 'msg' | 'timestamp' | 'hostname' | 'syslogtag' | 'rawmsg' | 'rawmsg-after-pri' | 'inputname' | 'fromhost' | 'fromhost-ip'
  | 'fromhost-port' | 'pri' | 'pri-text' | 'iut' | 'syslogfacility' | 'syslogfacility-text' | 'syslogseverity'
  | 'syslogseverity-text' | 'timegenerated' | 'programname' | 'protocol-version' | 'structured-data' | 'app-name' | 'procid'
  | 'msgid' | 'jsonmesg' | 'parsesuccess' | 'uuid'
  | 'now' | 'year' | 'month' | 'day' | 'hour' | 'hhour' | 'qhour' | 'minute' | 'wday'
  | 'now-utc' | 'year-utc' | 'month-utc' | 'day-utc' | 'hour-utc' | 'hhour-utc' | 'qhour-utc' | 'minute-utc' | 'wday-utc'
  | 'now-unixtimestamp' | 'myhostname' | 'all-json' | 'all-json-plain' | 'bom' | 'uptime'
  | 'cee' | 'local-var' | 'global-var' | 'invalid';

export interface PropertyDescriptor {
  readonly id: PropertyId;
  readonly name: string;
}

const ALIASES: Readonly<Record<string, PropertyId>> = {
  'msg': 'msg', 'timestamp': 'timestamp', 'timereported': 'timestamp', 'hostname': 'hostname', 'source': 'hostname',
  'syslogtag': 'syslogtag', 'rawmsg': 'rawmsg', 'rawmsg-after-pri': 'rawmsg-after-pri', 'inputname': 'inputname',
  'fromhost': 'fromhost', 'fromhost-ip': 'fromhost-ip', 'fromhost-port': 'fromhost-port', 'pri': 'pri', 'pri-text': 'pri-text',
  'iut': 'iut', 'syslogfacility': 'syslogfacility', 'syslogfacility-text': 'syslogfacility-text',
  'syslogseverity': 'syslogseverity', 'syslogpriority': 'syslogseverity', 'syslogseverity-text': 'syslogseverity-text',
  'syslogpriority-text': 'syslogseverity-text', 'timegenerated': 'timegenerated', 'timereceived': 'timegenerated',
  'programname': 'programname', 'protocol-version': 'protocol-version', 'structured-data': 'structured-data',
  'app-name': 'app-name', 'procid': 'procid', 'msgid': 'msgid', 'jsonmesg': 'jsonmesg', 'parsesuccess': 'parsesuccess',
  'uuid': 'uuid',
  '$now': 'now', '$year': 'year', '$month': 'month', '$day': 'day', '$hour': 'hour', '$hhour': 'hhour', '$qhour': 'qhour',
  '$minute': 'minute', '$wday': 'wday', '$now-utc': 'now-utc', '$year-utc': 'year-utc', '$month-utc': 'month-utc',
  '$day-utc': 'day-utc', '$hour-utc': 'hour-utc', '$hhour-utc': 'hhour-utc', '$qhour-utc': 'qhour-utc',
  '$minute-utc': 'minute-utc', '$wday-utc': 'wday-utc', '$now-unixtimestamp': 'now-unixtimestamp',
  '$myhostname': 'myhostname', '$!all-json': 'all-json', '$!all-json-plain': 'all-json-plain', '$bom': 'bom', '$uptime': 'uptime',
};

export function describeProperty(name: string): PropertyDescriptor {
  const alias = ALIASES[name.toLowerCase()];
  if (alias !== undefined) return { id: alias, name };
  if (name.startsWith('$!') || name.startsWith('!')) return { id: 'cee', name: name.replace(/^\$?!/, '') };
  if (name.startsWith('$.') || name.startsWith('.')) return { id: 'local-var', name: name.replace(/^\$?\./, '') };
  if (name.startsWith('$/') || name.startsWith('/')) return { id: 'global-var', name: name.replace(/^\$?\//, '') };
  return { id: 'invalid', name };
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function yearText(year: number): string {
  return year >= 1967 && year <= 2099 ? String(year) : 'YEAR OUT OF RANGE(1967-2099)';
}

function toUtc(time: SyslogTime): SyslogTime {
  const converted = syslogTimeFromEpochMs(syslogTimeToEpochMs(time), 0, time.secfracPrecision, time.timeType);
  return { ...converted, secfrac: time.secfrac };
}

export function formatDate(time: SyslogTime, format: DateFormat): string {
  switch (format) {
    case 'default':
    case 'rfc3164': return formatTimestamp3164(time, false);
    case 'rfc3164-buggyday': return formatTimestamp3164(time, true);
    case 'mysql': return formatTimestampMySql(time);
    case 'pgsql': return formatTimestampPgSql(time);
    case 'rfc3339': return formatTimestamp3339(time);
    case 'unixtimestamp': return formatTimestampUnix(time);
    case 'subseconds': return formatSecFrac(time);
    case 'wdayname': return WEEKDAY_NAMES[weekdayNumber(time)];
    case 'wday': return String(weekdayNumber(time));
    case 'year': return yearText(time.year);
    case 'month': return two(time.month);
    case 'day': return two(time.day);
    case 'hour': return two(time.hour);
    case 'minute': return two(time.minute);
    case 'second': return two(time.second);
    case 'tzoffshour': return two(time.offsetHour);
    case 'tzoffsmin': return two(time.offsetMinute);
    case 'tzoffsdirection': return time.offsetMode === '+' ? '+' : '-';
    case 'ordinal': return String(ordinalDay(time) + 1).padStart(3, '0');
    case 'week': return two(weekNumber(time));
    case 'iso-week': return two(isoWeek(time).week);
    case 'iso-week-year': return yearText(isoWeek(time).year);
    default: return 'INVALID eFmt OPTION!';
  }
}

export function formatDateForProperty(time: SyslogTime, format: DateFormat, inUtc: boolean): string {
  return formatDate(inUtc ? toUtc(time) : time, format);
}

function nowText(id: PropertyId, context: RenderContext): string {
  const utc = id.endsWith('-utc');
  const time = utc ? context.nowUtc() : context.now();
  switch (id.replace(/-utc$/, '')) {
    case 'now': return `${String(time.year).padStart(4, '0')}-${two(time.month)}-${two(time.day)}`;
    case 'year': return String(time.year).padStart(4, '0');
    case 'month': return two(time.month);
    case 'day': return two(time.day);
    case 'hour': return two(time.hour);
    case 'hhour': return two(Math.floor(time.minute / 30));
    case 'qhour': return two(Math.floor(time.minute / 15));
    case 'minute': return two(time.minute);
    case 'wday': return String(weekdayNumber(time));
    default: return '';
  }
}

export function messageAsJson(message: RsyslogMessage): { [key: string]: JsonValue } {
  return {
    msg: message.msg,
    rawmsg: message.rawMsg,
    timereported: formatTimestamp3339(message.timestamp),
    hostname: message.hostnameOrSender,
    syslogtag: message.effectiveTag,
    inputname: message.inputName,
    fromhost: message.fromHost ?? '',
    'fromhost-ip': message.fromHostIp ?? '',
    'fromhost-port': message.fromHostPort ?? '',
    pri: String(message.pri),
    syslogfacility: String(message.facility),
    syslogseverity: String(message.severity),
    timegenerated: formatTimestamp3339(message.receivedAt),
    programname: message.programName,
    'protocol-version': message.protocolVersion === 1 ? '1' : '0',
    'structured-data': message.effectiveStructuredData,
    'app-name': message.effectiveAppName,
    procid: message.effectiveProcId,
    msgid: message.effectiveMsgId,
    uuid: null,
    '$!': Object.keys(message.cee).length === 0 ? null : message.cee,
  };
}

function variableText(root: { [key: string]: JsonValue }, path: string): string {
  if (path === '' || path === '!') return jsonText(root);
  const value = jsonGet(root, path);
  return value === undefined ? '' : jsonToString(value);
}

export function baseProperty(
  descriptor: PropertyDescriptor, message: RsyslogMessage, context: RenderContext, date: { format: DateFormat; utc: boolean },
): string {
  switch (descriptor.id) {
    case 'msg': return message.msg;
    case 'timestamp': return formatDateForProperty(message.timestamp, date.format, date.utc);
    case 'hostname': return message.hostnameOrSender;
    case 'syslogtag': return message.effectiveTag;
    case 'rawmsg': return message.rawMsg;
    case 'rawmsg-after-pri': return message.rawMsgAfterPri;
    case 'inputname': return message.inputName;
    case 'fromhost': return message.fromHost ?? '';
    case 'fromhost-ip': return message.fromHostIp ?? '';
    case 'fromhost-port': return message.fromHostPort ?? '';
    case 'pri': return String(message.pri);
    case 'pri-text': return message.priText;
    case 'iut': return '1';
    case 'syslogfacility': return String(message.facility);
    case 'syslogfacility-text': return message.facilityText;
    case 'syslogseverity': return String(message.severity);
    case 'syslogseverity-text': return message.severityText;
    case 'timegenerated': return formatDateForProperty(message.receivedAt, date.format, date.utc);
    case 'programname': return message.programName;
    case 'protocol-version': return message.protocolVersion === 1 ? '1' : '0';
    case 'structured-data': return message.effectiveStructuredData;
    case 'app-name': return message.effectiveAppName;
    case 'procid': return message.effectiveProcId;
    case 'msgid': return message.effectiveMsgId;
    case 'jsonmesg': return jsonText(messageAsJson(message));
    case 'parsesuccess': return message.parseSuccess ? 'OK' : 'FAIL';
    case 'uuid': return '';
    case 'now-unixtimestamp': return formatTimestampUnix(context.nowUtc());
    case 'myhostname': return context.localHostName();
    case 'all-json': return Object.keys(message.cee).length === 0 ? '{}' : jsonText(message.cee);
    case 'all-json-plain': return Object.keys(message.cee).length === 0 ? '{}' : jsonText(message.cee, true);
    case 'bom': return 'ï»¿';
    case 'uptime': return String(Math.floor(context.uptimeSeconds()));
    case 'cee': return variableText(message.cee, descriptor.name);
    case 'local-var': return variableText(message.localVariables, descriptor.name);
    case 'global-var': return variableText(context.globalVariables, descriptor.name);
    case 'invalid': return '**INVALID PROPERTY NAME**';
    default: return nowText(descriptor.id, context);
  }
}
