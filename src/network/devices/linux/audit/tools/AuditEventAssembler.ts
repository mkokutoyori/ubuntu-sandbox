import { AUDIT_MESSAGE_TYPES, AUDIT_RANGES } from './AuditMessageTypes';
import { AUDIT } from './AuditConstants';
import { AuditEvent, type AuditEventTime } from './AuditSearchParser';
import { strtoul } from './AuditCString';

const EOE_TIMEOUT = 2;

const NAME_TO_TYPE = new Map<string, number>(AUDIT_MESSAGE_TYPES.map(([value, name]) => [name, value]));
const TYPE_TO_NAME = new Map<number, string>(AUDIT_MESSAGE_TYPES.map(([value, name]) => [value, name]));

export function nameToMessageType(name: string): number {
  const known = NAME_TO_TYPE.get(name);
  if (known !== undefined) return known;
  if (name.startsWith('UNKNOWN[')) {
    const end = name.indexOf(']', 8);
    if (end < 0) return -1;
    return strtoul(name.slice(8, Math.min(end, 15)));
  }
  if (/^\d/.test(name)) return strtoul(name);
  return -1;
}

export function messageTypeToName(type: number): string | null {
  return TYPE_TO_NAME.get(type) ?? null;
}

interface Slot {
  status: 'empty' | 'building' | 'complete';
  event: AuditEvent | null;
}

export interface TimeWindow {
  startTime: number;
  endTime: number;
}

export class AuditEventAssembler {
  private readonly slots: Slot[] = [];
  private ready = 0;
  veryFirstSec = 0;
  veryFirstMilli = 0;

  constructor(private readonly window: TimeWindow, private readonly eoeTimeout = EOE_TIMEOUT) {}

  private extractTimestamp(line: string): AuditEventTime | null {
    const limit = line[0] === 'n' ? 340 : 80;
    const parts = line.slice(0, limit).split(' ').filter((p) => p !== '');
    let index = 0;
    let node: string | null = null;
    if (parts[index] !== undefined && parts[index][0] === 'n') {
      node = parts[index].slice(5);
      index++;
    }
    const typePart = parts[index];
    if (typePart === undefined) return null;
    const typeName = typePart.slice(5);
    const msgPart = parts[index + 1];
    if (msgPart === undefined || msgPart.length <= 18) return null;
    let open = msgPart[9] === '(' ? 9 : msgPart.indexOf('(');
    if (open < 0) return null;
    const close = msgPart.indexOf(')', open + 1);
    const stamp = close >= 0 ? msgPart.slice(open + 1, close) : msgPart.slice(open + 1);
    const sec = strtoul(stamp);
    let milli = 0;
    let serial = 0;
    let rest = stamp;
    const dot = stamp.indexOf('.');
    if (dot >= 0) {
      milli = strtoul(stamp.slice(dot + 1));
      if (milli > 999) return null;
      rest = stamp.slice(dot + 1);
    }
    const colon = rest.indexOf(':');
    if (colon >= 0) serial = strtoul(rest.slice(colon + 1));
    const { startTime, endTime } = this.window;
    if ((startTime && sec < startTime) || (endTime && sec > endTime)) {
      if (this.veryFirstSec === 0) { this.veryFirstSec = sec; this.veryFirstMilli = milli; }
      return null;
    }
    if (this.veryFirstSec === 0 && startTime === 0) { this.veryFirstSec = sec; this.veryFirstMilli = milli; }
    return { sec, milli, serial, node, type: nameToMessageType(typeName) };
  }

  private checkEvents(sec: number): void {
    for (const slot of this.slots) {
      if (slot.status !== 'building' || !slot.event) continue;
      const e = slot.event.e;
      if (e.sec + this.eoeTimeout <= sec) {
        slot.status = 'complete';
        this.ready++;
      } else if (
        e.type === AUDIT.PROCTITLE
        || e.type < AUDIT_RANGES.AUDIT_FIRST_EVENT
        || e.type >= AUDIT.FIRST_ANOM_MSG
        || e.type === AUDIT.KERNEL
        || (e.type >= AUDIT.MAC_UNLBL_ALLOW && e.type <= AUDIT.MAC_CALIPSO_DEL)
      ) {
        slot.status = 'complete';
        this.ready++;
      }
    }
  }

  addRecord(rawLine: string): boolean {
    const line = rawLine.replace(/\n$/, '');
    const e = this.extractTimestamp(line);
    if (!e) return false;
    const node = { message: line, type: e.type, a0: 0n, a1: 0n };
    for (const slot of this.slots) {
      if (slot.status !== 'building' || !slot.event) continue;
      const other = slot.event.e;
      if (other.serial === e.serial && other.milli === e.milli && other.sec === e.sec && other.node === e.node) {
        slot.event.append(node);
        return true;
      }
    }
    if (e.type === AUDIT.EOE) return false;
    const event = new AuditEvent({ ...e });
    event.append(node);
    const free = this.slots.find((s) => s.status === 'empty');
    if (free) { free.status = 'building'; free.event = event; } else this.slots.push({ status: 'building', event });
    this.checkEvents(e.sec);
    return true;
  }

  terminateAll(): void {
    for (const slot of this.slots) {
      if (slot.status === 'building') {
        slot.status = 'complete';
        this.ready++;
      }
    }
  }

  getReady(): AuditEvent | null {
    if (this.ready === 0) return null;
    let lowest: Slot | null = null;
    for (const slot of this.slots) {
      if (slot.status === 'empty' || !slot.event) continue;
      if (lowest === null || compareEvents(lowest.event!.e, slot.event.e) === 1) lowest = slot;
    }
    if (lowest && lowest.status === 'complete') {
      const event = lowest.event;
      lowest.status = 'empty';
      lowest.event = null;
      this.ready--;
      return event;
    }
    return null;
  }
}

function compareEvents(a: AuditEventTime, b: AuditEventTime): number {
  if (a.sec !== b.sec) return a.sec > b.sec ? 1 : -1;
  if (a.milli !== b.milli) return a.milli > b.milli ? 1 : -1;
  if (a.serial !== b.serial) return a.serial > b.serial ? 1 : -1;
  return 0;
}

export function* readEvents(
  assembler: AuditEventAssembler,
  text: string,
  lastFile: boolean,
): Generator<AuditEvent> {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (assembler.addRecord(line + '\n')) {
      let ready = assembler.getReady();
      while (ready) {
        yield ready;
        ready = assembler.getReady();
      }
    }
  }
  if (lastFile) assembler.terminateAll();
  let ready = assembler.getReady();
  while (ready) {
    yield ready;
    ready = assembler.getReady();
  }
}
