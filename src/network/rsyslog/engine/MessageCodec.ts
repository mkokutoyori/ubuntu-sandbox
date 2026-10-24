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

export function serializeMessage(message: RsyslogMessage, context: Pick<MessageCodecContext, 'compactJson'>): string {
  const { rawMsg, offset } = messageOffset(message);
  const writer = new ObjectWriter(MESSAGE_OBJECT_ID, MESSAGE_OBJECT_VERSION)
    .number('iProtocolVersion', message.protocolVersion)
    .number('iSeverity', message.severity)
    .number('iFacility', message.facility)
    .number('msgFlags', flagsOf(message))
    .number('ttGenTime', syslogTimeToUnixSeconds(message.receivedAt))
    .time('tRcvdAt', message.receivedAt)
    .time('tTIMESTAMP', message.timestamp)
    .string('pszTAG', message.tag)
    .string('pszRawMsg', rawMsg)
    .string('pszHOSTNAME', message.hostname)
    .string('pszInputName', message.inputName)
    .string('pszRcvFrom', message.fromHost ?? '')
    .string('pszRcvFromIP', message.fromHostIp ?? '')
    .string('pszStrucData', message.structuredData);
  if (Object.keys(message.cee).length > 0) writer.string('json', jsonText(message.cee, context.compactJson));
  if (Object.keys(message.localVariables).length > 0) writer.string('localvars', jsonText(message.localVariables, context.compactJson));
  return writer
    .string('pCSAPPNAME', message.appName)
    .string('pCSPROCID', message.procId)
    .string('pCSMSGID', message.msgId)
    .string('pszRuleset', message.rulesetName)
    .number('offMSG', offset)
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

function jsonObject(properties: Map<string, PropertyValue>, name: string): { [key: string]: JsonValue } {
  const raw = text(properties, name);
  if (raw === null) return {};
  const parsed = parseJsonC(raw);
  return parsed !== undefined && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export function deserializeMessage(record: ObjectRecord, context: MessageCodecContext): RsyslogMessage {
  if (record.id !== MESSAGE_OBJECT_ID) throw new ObjectStreamError(`unexpected object '${record.id}'`);
  const properties = lookup(record);
  const flags = numeric(properties, 'msgFlags') ?? 0;
  const offset = numeric(properties, 'offMSG');
  const rawMsg = text(properties, 'pszRawMsg');
  if (offset === null || rawMsg === null) throw new ObjectStreamError('incomplete message record');
  const fromHost = text(properties, 'pszRcvFrom');
  const fromHostIp = text(properties, 'pszRcvFromIP');
  const message = new RsyslogMessage({
    rawMsg,
    receivedAt: moment(properties, 'tRcvdAt'),
    inputName: text(properties, 'pszInputName') ?? '',
    fromHost: fromHost === '' ? null : fromHost,
    fromHostIp: fromHostIp === '' ? null : fromHostIp,
    fromHostPort: null,
    internal: (flags & FLAG_INTERNAL) !== 0,
    parseHostname: (flags & FLAG_PARSE_HOSTNAME) !== 0,
    ignoreDate: (flags & FLAG_IGNORE_DATE) !== 0,
    noPriInRaw: (flags & FLAG_NO_PRI_IN_RAW) !== 0,
    defaultTimeZone: context.defaultTimeZone,
    mark: (flags & FLAG_MARK) !== 0,
    localHostName: context.localHostName,
  });
  message.parsePriFromRaw();
  message.facility = numeric(properties, 'iFacility') ?? message.facility;
  message.severity = numeric(properties, 'iSeverity') ?? message.severity;
  message.protocolVersion = numeric(properties, 'iProtocolVersion') === 1 ? 1 : 0;
  message.timestamp = moment(properties, 'tTIMESTAMP');
  message.tag = text(properties, 'pszTAG') ?? '';
  message.hostname = text(properties, 'pszHOSTNAME');
  message.structuredData = text(properties, 'pszStrucData');
  message.appName = text(properties, 'pCSAPPNAME');
  message.procId = text(properties, 'pCSPROCID');
  message.msgId = text(properties, 'pCSMSGID');
  message.rulesetName = text(properties, 'pszRuleset');
  message.cee = jsonObject(properties, 'json');
  message.localVariables = jsonObject(properties, 'localvars');
  message.msg = rawMsg.slice(offset);
  message.parseSuccess = true;
  return message;
}
