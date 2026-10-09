import { AUDIT } from './AuditConstants';
import { nameToMessageType } from './AuditEventAssembler';
import { strtoul } from './AuditCString';

export interface FeedEventTime {
  sec: number;
  milli: number;
  serial: number;
  host: string | null;
}

export interface FeedEvent {
  time: FeedEventTime;
  lines: string[];
}

interface Node {
  status: 'empty' | 'building' | 'complete';
  event: FeedEvent | null;
  lastType: number;
}

const AUDIT_FIRST_EVENT = 1300;
const MAC_UNLBL_ALLOW = 1406;
const MAC_CALIPSO_DEL = 1419;
const FIRST_ANOM_MSG = 2100;

function splitToken(text: string, from: number): { token: string; next: number } | null {
  let at = from;
  while (at < text.length && text[at] === ' ') at++;
  if (at >= text.length) return null;
  const end = text.indexOf(' ', at);
  return end < 0 ? { token: text.slice(at), next: text.length } : { token: text.slice(at, end), next: end + 1 };
}

function strToEvent(text: string): FeedEventTime | null {
  const sec = strtoul(text, 10);
  let milli = 0;
  let serial = 0;
  let rest = text;
  const dot = text.indexOf('.');
  if (dot >= 0) {
    milli = strtoul(text.slice(dot + 1), 10);
    if (milli > 999) return null;
    rest = text.slice(dot + 1);
  }
  const colon = rest.indexOf(':');
  if (colon >= 0) serial = strtoul(rest.slice(colon + 1), 10);
  return { sec, milli, serial, host: null };
}

export function extractFeedTimestamp(line: string): FeedEventTime | null {
  const text = line.slice(0, line[0] === 'n' ? 340 : 80);
  let cursor = splitToken(text, 0);
  if (cursor === null) return null;
  let host: string | null = null;
  if (cursor.token[0] === 'n' && cursor.token.length > 5) {
    host = cursor.token.slice(5);
    cursor = splitToken(text, cursor.next);
    if (cursor === null) return null;
  }
  cursor = splitToken(text, cursor.next);
  if (cursor === null) return null;
  const stamp = cursor.token.slice(0, 20);
  if (stamp.length <= 18) return null;
  let open = cursor.token[9] === '(' ? 9 : cursor.token.indexOf('(');
  if (open < 0) return null;
  const close = cursor.token.indexOf(')', open + 1);
  const inner = close >= 0 ? cursor.token.slice(open + 1, close) : cursor.token.slice(open + 1);
  const parsed = strToEvent(inner);
  if (parsed === null) return null;
  parsed.host = host;
  return parsed;
}

function recordType(line: string): number {
  const match = /(?:^|\s)type=(\S+)/.exec(line);
  return match === null ? 0 : nameToMessageType(match[1]);
}

function compare(a: FeedEventTime, b: FeedEventTime): number {
  if (a.sec !== b.sec) return a.sec > b.sec ? 1 : -1;
  if (a.milli !== b.milli) return a.milli > b.milli ? 1 : -1;
  if (a.serial !== b.serial) return a.serial > b.serial ? 1 : -1;
  return 0;
}

function sameEvent(a: FeedEventTime, b: FeedEventTime): boolean {
  if (!(a.serial === b.serial && a.milli === b.milli && a.sec === b.sec)) return false;
  if (a.host !== null && b.host !== null) return a.host === b.host;
  return a.host === null && b.host === null;
}

export class AuparseFeed {
  private readonly nodes: Node[] = [];
  private ready = 0;
  private pending: string[] = [];

  constructor(private readonly eoeTimeout: number, private readonly onEvent: (event: FeedEvent) => void) {}

  private checkEvents(sec: number): void {
    for (const node of this.nodes) {
      if (node.status !== 'building' || node.event === null) continue;
      if (node.event.time.sec + this.eoeTimeout <= sec) {
        node.status = 'complete';
        this.ready++;
      } else if (
        node.lastType === AUDIT.PROCTITLE || node.lastType === AUDIT.EOE || node.lastType < AUDIT_FIRST_EVENT || node.lastType >= FIRST_ANOM_MSG
        || node.lastType === AUDIT.KERNEL || (node.lastType >= MAC_UNLBL_ALLOW && node.lastType <= MAC_CALIPSO_DEL)
      ) {
        node.status = 'complete';
        this.ready++;
      }
    }
  }

  private takeReady(): FeedEvent | null {
    if (this.ready === 0) return null;
    let lowest: Node | null = null;
    for (const node of this.nodes) {
      if (node.status === 'empty' || node.event === null) continue;
      if (lowest === null || compare(lowest.event!.time, node.event.time) === 1) lowest = node;
    }
    if (lowest !== null && lowest.status === 'complete') {
      lowest.status = 'empty';
      this.ready--;
      const event = lowest.event;
      lowest.event = null;
      return event;
    }
    return null;
  }

  private nextEvent(): FeedEvent | null {
    const queued = this.takeReady();
    if (queued !== null) return queued;
    for (;;) {
      const line = this.pending.shift();
      if (line === undefined) return null;
      const time = extractFeedTimestamp(line);
      if (time === null) continue;
      const type = recordType(line);
      const building = this.nodes.find((node) => node.status === 'building' && node.event !== null && sameEvent(node.event.time, time));
      if (building !== undefined && building.event !== null) {
        building.event.lines.push(line);
        building.lastType = type;
        this.checkEvents(time.sec);
        continue;
      }
      if (type === AUDIT.EOE) continue;
      const fresh: Node = { status: 'building', event: { time, lines: [line] }, lastType: type };
      const empty = this.nodes.find((node) => node.status === 'empty');
      if (empty !== undefined) {
        empty.status = fresh.status;
        empty.event = fresh.event;
        empty.lastType = fresh.lastType;
      } else this.nodes.push(fresh);
      this.checkEvents(time.sec);
      const ready = this.takeReady();
      if (ready !== null) return ready;
    }
  }

  private consume(flush: boolean): void {
    for (let event = this.nextEvent(); event !== null; event = this.nextEvent()) this.onEvent(event);
    if (!flush) return;
    for (const node of this.nodes) {
      if (node.status === 'building') {
        node.status = 'complete';
        this.ready++;
      }
    }
    for (let event = this.takeReady(); event !== null; event = this.takeReady()) this.onEvent(event);
  }

  feed(line: string): void {
    this.pending.push(line);
    this.consume(false);
  }

  flush(): void {
    this.consume(true);
  }
}
