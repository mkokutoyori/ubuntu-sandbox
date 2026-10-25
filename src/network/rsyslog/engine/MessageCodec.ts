import { RsyslogMessage, type JsonValue } from '../Message';
import { jsonText } from '../Json';
import { parseJsonC } from './JsonC';
import { ObjectStreamError, ObjectWriter, type ObjectRecord, type PropertyValue } from './ObjectStream';
import { syslogTimeToUnixSeconds, type SyslogTime } from '@/network/syslog/codec/SyslogTime';

export const MESSAGE_OBJECT_ID = 'msg';
export const MESSAGE_OBJECT_VERSION = 1;

const FLAG_INTERNAL = 0x001;
const FLAG_IGNORE_DATE = 0x004;
const FLAG_MARK = 0x008;
const FLAG_PARSE_HOSTNAME = 0x020;
const FLAG_NO_PRI_IN_RAW = 0x100;

export interface MessageCodecContext {
  readonly localHostName: string;
  readonly defaultTimeZone: string | null;
  readonly compactJson: boolean;
}

export interface MessageImage {
  readonly protocolVersion: number;
  readonly severity: number;
  readonly facility: number;
  readonly flags: number;
  readonly generatedAt: number;
  readonly receivedAt: SyslogTime;
  readonly timestamp: SyslogTime;
  readonly tag: string;
  readonly rawMsg: string;
  readonly offset: number;
  readonly hostname: string | null;
  readonly inputName: string;
  readonly fromHost: string;
  readonly fromHostIp: string;
  readonly fromHostPort: string;
  readonly structuredData: string | null;
  readonly json: string | null;
  readonly localVariables: string | null;
  readonly appName: string | null;
  readonly procId: string | null;
  readonly msgId: string | null;
  readonly ruleset: string | null;
}

function flagsOf(message: RsyslogMessage): number {
  let flags = 0;
  if (message.internal) flags |= FLAG_INTERNAL;
  if (message.ignoreDate) flags |= FLAG_IGNORE_DATE;
  if (message.mark) flags |= FLAG_MARK;
  if (message.parseHostname) flags |= FLAG_PARSE_HOSTNAME;
  if (message.noPriInRaw) flags |= FLAG_NO_PRI_IN_RAW;
  return flags;
}

function messageOffset(message: RsyslogMessage): { rawMsg: string; offset: number } {
  if (message.rawMsg.endsWith(message.msg)) return { rawMsg: message.rawMsg, offset: message.rawMsg.length - message.msg.length };
  return { rawMsg: message.msg, offset: 0 };
}

export function imageOf(message: RsyslogMessage, context: Pick<MessageCodecContext, 'compactJson'>): MessageImage {
  const { rawMsg, offset } = messageOffset(message);
  return {
    protocolVersion: message.protocolVersion,
    severity: message.severity,
    facility: message.facility,
    flags: flagsOf(message),
    generatedAt: syslogTimeToUnixSeconds(message.receivedAt),
    receivedAt: message.receivedAt,
    timestamp: message.timestamp,
    tag: message.tag,
    rawMsg,
    offset,
    hostname: message.hostname,
    inputName: message.inputName,
    fromHost: message.fromHost ?? '',
    fromHostIp: message.fromHostIp ?? '',
    fromHostPort: message.fromHostPort ?? '',
    structuredData: message.structuredData,
    json: Object.keys(message.cee).length > 0 ? jsonText(message.cee, context.compactJson) : null,
    localVariables: Object.keys(message.localVariables).length > 0 ? jsonText(message.localVariables, context.compactJson) : null,
    appName: message.appName,
    procId: message.procId,
    msgId: message.msgId,
    ruleset: message.rulesetName,
  };
}

function jsonObject(raw: string | null): { [key: string]: JsonValue } {
  if (raw === null) return {};
  const parsed = parseJsonC(raw);
  return parsed !== undefined && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export function messageOf(image: MessageImage, context: Pick<MessageCodecContext, 'localHostName' | 'defaultTimeZone'>): RsyslogMessage {
  const message = new RsyslogMessage({
    rawMsg: image.rawMsg,
    receivedAt: image.receivedAt,
    inputName: image.inputName,
    fromHost: image.fromHost === '' ? null : image.fromHost,
    fromHostIp: image.fromHostIp === '' ? null : image.fromHostIp,
    fromHostPort: image.fromHostPort === '' ? null : image.fromHostPort,
    internal: (image.flags & FLAG_INTERNAL) !== 0,
    parseHostname: (image.flags & FLAG_PARSE_HOSTNAME) !== 0,
    ignoreDate: (image.flags & FLAG_IGNORE_DATE) !== 0,
    noPriInRaw: (image.flags & FLAG_NO_PRI_IN_RAW) !== 0,
    defaultTimeZone: context.defaultTimeZone,
    mark: (image.flags & FLAG_MARK) !== 0,
    localHostName: context.localHostName,
  });
  message.parsePriFromRaw();
  message.facility = image.facility;
  message.severity = image.severity;
  message.protocolVersion = image.protocolVersion === 1 ? 1 : 0;
  message.timestamp = image.timestamp;
  message.tag = image.tag;
  message.hostname = image.hostname;
  message.structuredData = image.structuredData;
  message.appName = image.appName;
  message.procId = image.procId;
  message.msgId = image.msgId;
  message.rulesetName = image.ruleset;
  message.cee = jsonObject(image.json);
  message.localVariables = jsonObject(image.localVariables);
  message.msg = image.rawMsg.slice(image.offset);
  message.parseSuccess = true;
  return message;
}

export function serializeMessage(message: RsyslogMessage, context: Pick<MessageCodecContext, 'compactJson'>): string {
  const image = imageOf(message, context);
  const writer = new ObjectWriter(MESSAGE_OBJECT_ID, MESSAGE_OBJECT_VERSION)
    .number('iProtocolVersion', image.protocolVersion)
    .number('iSeverity', image.severity)
    .number('iFacility', image.facility)
    .number('msgFlags', image.flags)
    .number('ttGenTime', image.generatedAt)
    .time('tRcvdAt', image.receivedAt)
    .time('tTIMESTAMP', image.timestamp)
    .string('pszTAG', image.tag)
    .string('pszRawMsg', image.rawMsg)
    .string('pszHOSTNAME', image.hostname)
    .string('pszInputName', image.inputName)
    .string('pszRcvFrom', image.fromHost)
    .string('pszRcvFromIP', image.fromHostIp)
    .string('pszStrucData', image.structuredData);
  if (image.json !== null) writer.string('json', image.json);
  if (image.localVariables !== null) writer.string('localvars', image.localVariables);
  return writer
    .string('pCSAPPNAME', image.appName)
    .string('pCSPROCID', image.procId)
    .string('pCSMSGID', image.msgId)
    .string('pszRuleset', image.ruleset)
    .number('offMSG', image.offset)
    .finish();
}

function lookup(record: ObjectRecord): Map<string, PropertyValue> {
  return new Map(record.properties.map((property) => [property.name, property.value]));
}

function text(properties: Map<string, PropertyValue>, name: string): string | null {
  const value = properties.get(name);
  return value?.kind === 'string' ? value.value : null;
}

function numeric(properties: Map<string, PropertyValue>, name: string): number | null {
  const value = properties.get(name);
  return value?.kind === 'number' ? value.value : null;
}

function moment(properties: Map<string, PropertyValue>, name: string): SyslogTime {
  const value = properties.get(name);
  if (value?.kind !== 'time') throw new ObjectStreamError(`property ${name} is missing`);
  return value.value;
}

export function deserializeMessage(record: ObjectRecord, context: MessageCodecContext): RsyslogMessage {
  if (record.id !== MESSAGE_OBJECT_ID) throw new ObjectStreamError(`unexpected object '${record.id}'`);
  const properties = lookup(record);
  const offset = numeric(properties, 'offMSG');
  const rawMsg = text(properties, 'pszRawMsg');
  if (offset === null || rawMsg === null) throw new ObjectStreamError('incomplete message record');
  return messageOf({
    protocolVersion: numeric(properties, 'iProtocolVersion') ?? 0,
    severity: numeric(properties, 'iSeverity') ?? 0,
    facility: numeric(properties, 'iFacility') ?? 0,
    flags: numeric(properties, 'msgFlags') ?? 0,
    generatedAt: numeric(properties, 'ttGenTime') ?? 0,
    receivedAt: moment(properties, 'tRcvdAt'),
    timestamp: moment(properties, 'tTIMESTAMP'),
    tag: text(properties, 'pszTAG') ?? '',
    rawMsg,
    offset,
    hostname: text(properties, 'pszHOSTNAME'),
    inputName: text(properties, 'pszInputName') ?? '',
    fromHost: text(properties, 'pszRcvFrom') ?? '',
    fromHostIp: text(properties, 'pszRcvFromIP') ?? '',
    fromHostPort: '',
    structuredData: text(properties, 'pszStrucData'),
    json: text(properties, 'json'),
    localVariables: text(properties, 'localvars'),
    appName: text(properties, 'pCSAPPNAME'),
    procId: text(properties, 'pCSPROCID'),
    msgId: text(properties, 'pCSMSGID'),
    ruleset: text(properties, 'pszRuleset'),
  }, context);
}
