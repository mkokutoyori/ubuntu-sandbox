import { describeEvent } from './EventDescriptor';

export interface XmlEvent {
  readonly source: string;
  readonly eventId: number;
  readonly entryType: string;
  readonly timeGenerated: Date;
  readonly index: number;
  readonly message: string;
  readonly data?: Record<string, string>;
}

export interface XmlEventContext {
  readonly channel: string;
  readonly computer: string;
}

const USER_DATA_ELEMENTS: Record<number, { element: string; namespace: string }> = {
  1102: { element: 'LogFileCleared', namespace: 'http://manifests.microsoft.com/win/2004/08/windows/eventlog' },
  104: { element: 'LogFileCleared', namespace: 'http://manifests.microsoft.com/win/2004/08/windows/eventlog' },
};

export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function systemTime(date: Date): string {
  return date.toISOString().replace(/Z$/, '0000Z');
}

function systemSection(event: XmlEvent, context: XmlEventContext): string {
  const descriptor = describeEvent(event);
  const guid = descriptor.providerGuid === null ? '' : ` Guid='${descriptor.providerGuid}'`;
  const audit = event.entryType === 'SuccessAudit' || event.entryType === 'FailureAudit';
  return `<System><Provider Name='${xmlEscape(event.source)}'${guid}/>`
    + `<EventID>${event.eventId}</EventID><Version>${descriptor.version}</Version>`
    + `<Level>${descriptor.level}</Level><Task>${descriptor.taskId}</Task><Opcode>${descriptor.opcode}</Opcode>`
    + `<Keywords>${descriptor.keywords}</Keywords>`
    + `<TimeCreated SystemTime='${systemTime(event.timeGenerated)}'/>`
    + `<EventRecordID>${event.index}</EventRecordID><Correlation/>`
    + `<Channel>${xmlEscape(context.channel)}</Channel><Computer>${xmlEscape(context.computer)}</Computer>`
    + `${audit ? '<Security/>' : ''}</System>`;
}

function dataSection(event: XmlEvent): string {
  const fields = Object.entries(event.data ?? {});
  const userData = USER_DATA_ELEMENTS[event.eventId];
  if (userData !== undefined) {
    const body = fields.map(([name, value]) => `<${name}>${xmlEscape(value)}</${name}>`).join('');
    return `<UserData><${userData.element} xmlns='${userData.namespace}'>${body}</${userData.element}></UserData>`;
  }
  const body = fields.map(([name, value]) => `<Data Name='${xmlEscape(name)}'>${xmlEscape(value)}</Data>`).join('');
  return `<EventData>${body}</EventData>`;
}

export function renderEventXml(event: XmlEvent, context: XmlEventContext, rendered = false): string {
  const core = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>`
    + `${systemSection(event, context)}${dataSection(event)}`;
  if (!rendered) return `${core}</Event>`;
  const descriptor = describeEvent(event);
  const task = descriptor.taskName === null ? '' : `<Task>${xmlEscape(descriptor.taskName)}</Task>`;
  const keywords = descriptor.keywordNames.length === 0
    ? '' : `<Keywords>${descriptor.keywordNames.map((k) => `<Keyword>${xmlEscape(k)}</Keyword>`).join('')}</Keywords>`;
  return `${core}<RenderingInfo Culture='en-US'><Message>${xmlEscape(event.message)}</Message>`
    + `<Level>${xmlEscape(descriptor.levelName)}</Level>${task}<Opcode>${descriptor.opcodeName}</Opcode>`
    + `${keywords}<Channel>${xmlEscape(context.channel)}</Channel>`
    + `<Provider>${xmlEscape(event.source)}</Provider></RenderingInfo></Event>`;
}
