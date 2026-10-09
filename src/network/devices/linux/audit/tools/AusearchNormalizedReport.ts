import type { AuditEvent } from './AuditSearchParser';
import { AuparseFeed, type FeedEvent } from './AuparseFeed';
import { AuditNormalizer } from './AuditNormalize';
import { AuparseEvent, parseUpRecord, type AuparseRecord } from './AuparseEvent';
import { AUDIT } from './AuditConstants';
import { messageTypeToName } from './AuditEventAssembler';
import { Interpreter } from './AuditInterpret';
import type { EscapeMode } from './AuditPrint';
import type { AuditSearchHost, ToolOutput } from './AuditToolHost';

export interface ExtraColumns {
  time: boolean;
  labels: boolean;
  obj2: boolean;
  keys: boolean;
}

const pad = (value: number, width = 2, fill = '0'): string => String(value).padStart(width, fill);

interface LocalFields {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  gmtoff: number;
}

export class NormalizedReport {
  private headerDone = false;
  private readonly interpreter: Interpreter;

  constructor(
    private readonly host: AuditSearchHost,
    private readonly out: ToolOutput,
    private readonly escapeMode: EscapeMode,
    private readonly extra: ExtraColumns,
  ) {
    this.interpreter = new Interpreter(host);
  }

  private fieldsAt(sec: number): LocalFields {
    const tm = this.host.localTime(sec);
    const asUtc = Date.UTC(tm.year, tm.mon, tm.mday, tm.hour, tm.min, tm.sec) / 1000;
    return { year: tm.year, month: tm.mon + 1, day: tm.mday, weekday: tm.wday === 0 ? 7 : tm.wday, hour: tm.hour, minute: tm.min, second: tm.sec, gmtoff: asUtc - sec };
  }

  private build(event: FeedEvent): { au: AuparseEvent; normalizer: AuditNormalizer } | null {
    const records: AuparseRecord[] = [];
    let cwd: string | null = null;
    for (const line of event.lines) {
      const parsed = parseUpRecord(line, records.length);
      if (parsed === null) continue;
      if (parsed.cwd !== null) cwd = parsed.cwd;
      records.push(parsed);
    }
    if (records.length === 0) return null;
    const au = new AuparseEvent(records, event.time, cwd, this.interpreter, this.escapeMode);
    return { au, normalizer: new AuditNormalizer(au, this.host) };
  }

  report(event: AuditEvent, mode: 'csv' | 'text', eoeTimeout: number): void {
    const feed = new AuparseFeed(eoeTimeout, (ready) => (mode === 'csv' ? this.csv(ready) : this.text(ready)));
    for (const node of event.records) feed.feed(node.message);
    feed.flush();
  }

  private interpretedResult(au: AuparseEvent, positive: string, negative: string): string {
    const item = au.interpretField() ?? '';
    let success = false;
    if (item === 'yes') success = true;
    else if (item.startsWith('suc')) success = true;
    else if (au.fieldType() === 'SECCOMP' && item === 'allow') success = true;
    return success ? positive : negative;
  }

  private csv(event: FeedEvent): void {
    const built = this.build(event);
    if (built === null) {
      this.out.eprintf('Error - no elements in record.');
      return;
    }
    const { au, normalizer } = built;
    const extra = this.extra;
    if (!this.headerDone) {
      this.headerDone = true;
      this.out.printf(`NODE,EVENT,DATE,TIME,${extra.time ? 'YEAR,MONTH,DAY,WEEKDAY,HOUR,MILLI,GMT_OFFSET,' : ''}SERIAL_NUM,EVENT_KIND,SESSION,SUBJ_PRIME,SUBJ_SEC,SUBJ_KIND,${extra.labels ? 'SUBJ_LABEL,' : ''}ACTION,RESULT,OBJ_PRIME,OBJ_SEC,${extra.obj2 ? 'OBJ2,' : ''}${extra.labels ? 'OBJ_LABEL,' : ''}OBJ_KIND,HOW${extra.keys ? ',KEY' : ''}\n`);
    }
    const when = this.fieldsAt(au.time.sec);
    let line = '';
    if (au.time.host !== null) {
      au.firstRecord();
      line += au.interpretField() ?? '';
    }
    line += ',';
    const typeName = au.typeName(messageTypeToName);
    if (typeName !== null) line += typeName;
    line += ',';
    const rc = normalizer.normalize(extra.labels ? 'all' : 'no-attrs');
    line += `${pad(when.month)}/${pad(when.day)}/${pad(when.year % 100)},`;
    line += `${pad(when.hour)}:${pad(when.minute)}:${pad(when.second)},`;
    if (extra.time) {
      const sign = when.gmtoff >= 0 ? '+' : '-';
      const total = Math.abs(when.gmtoff);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total - hours * 3600) % 60);
      line += `${when.year},${pad(when.month)},${pad(when.day)},${when.weekday},${pad(when.hour, 2, ' ')},${au.time.milli},${sign}${pad(hours)}:${pad(minutes)},`;
    }
    line += `${au.time.serial},`;
    if (rc !== 0) {
      this.out.printf(line);
      this.out.eprintf(`error normalizing ${typeName}\n`);
      this.out.printf(`,,,,,,,,,${extra.labels ? ',,' : ''}${extra.keys ? ',' : ''}\n`);
      return;
    }
    line += `${normalizer.eventKind() ?? 'unknown'},`;
    if (normalizer.seekSession() === 1) line += au.interpretField() ?? '';
    line += ',';
    if (normalizer.seekSubjectPrimary() === 1) {
      let subject = au.interpretField() ?? '';
      if (subject === 'unset') subject = 'system';
      line += subject;
    }
    line += ',';
    if (normalizer.seekSubjectSecondary() === 1) line += au.interpretField() ?? '';
    line += ',';
    const subjectKind = normalizer.subjectKind();
    if (subjectKind !== null) line += subjectKind;
    line += ',';
    if (extra.labels) {
      let rcAttr = normalizer.subjectFirstAttribute();
      do {
        if (rcAttr === 1 && au.fieldName() === 'subj') {
          line += au.interpretField() ?? '';
          break;
        }
        rcAttr = normalizer.subjectNextAttribute();
      } while (rcAttr === 1);
      line += ',';
    }
    const action = normalizer.getAction();
    line += `${action ?? 'did-unknown'},`;
    if (normalizer.seekResults() === 1) line += this.interpretedResult(au, 'success', 'failed');
    line += ',';
    if (normalizer.seekObjectPrimary() === 1) {
      let value: string | null;
      if (au.fieldType() === 'ESCAPED_FILE') value = au.interpretRealpath();
      else if (au.type() === AUDIT.CONFIG_CHANGE) value = action !== null && (action === 'set' || action === 'seccomp-logging') ? au.fieldName() : au.interpretField();
      else value = au.interpretField();
      line += value ?? '(null)';
    }
    line += ',';
    if (normalizer.seekObjectSecondary() === 1) line += au.interpretField() ?? '';
    line += ',';
    if (extra.obj2) {
      if (normalizer.seekObjectPrimary2() === 1) {
        const value = au.fieldType() === 'ESCAPED_FILE' ? au.interpretRealpath() : au.interpretField();
        line += value ?? '(null)';
      }
      line += ',';
    }
    if (extra.labels) {
      let rcAttr = normalizer.objectFirstAttribute();
      do {
        if (rcAttr === 1 && au.fieldName() === 'obj') {
          line += au.interpretField() ?? '';
          break;
        }
        rcAttr = normalizer.objectNextAttribute();
      } while (rcAttr === 1);
      line += ',';
    }
    line += `${normalizer.objectKind()},`;
    const how = normalizer.getHow();
    if (how !== null) line += how;
    if (extra.keys) {
      line += ',';
      if (normalizer.seekKey() === 1) line += au.interpretField() ?? '';
    }
    this.out.printf(`${line}\n`);
  }

  private text(event: FeedEvent): void {
    const built = this.build(event);
    if (built === null) {
      this.out.eprintf('Error - no elements in record.');
      return;
    }
    const { au, normalizer } = built;
    const when = this.fieldsAt(au.time.sec);
    const stamp = `${pad(when.hour)}:${pad(when.minute)}:${pad(when.second)} ${pad(when.month)}/${pad(when.day)}/${pad(when.year % 100)}`;
    const type = au.type();
    normalizer.normalize('no-attrs');
    let line = '';
    if (au.time.host !== null) {
      au.firstRecord();
      line += `On ${au.interpretField() ?? ''} at ${stamp} `;
    } else line += `At ${stamp} `;
    let id = -2;
    if (normalizer.seekSubjectPrimary() === 1) {
      let subject = au.interpretField() ?? '';
      id = au.fieldInt();
      if (subject === 'unset') subject = 'system';
      line += subject;
    }
    if (normalizer.seekSubjectSecondary() === 1) {
      const uid = au.fieldInt();
      if (uid !== id && id !== -2 && uid !== -1) line += `, acting as ${au.interpretField() ?? ''},`;
    }
    if (normalizer.seekResults() === 1) line += ` ${this.interpretedResult(au, 'successfully', 'unsuccessfully')} `;
    else line += ' ';
    const action = normalizer.getAction();
    line += `${action ?? 'did-unknown'} `;
    if (normalizer.seekObjectPrimary() === 1) {
      let value: string | null = null;
      if (action !== null && action.includes('violated')) value = 'accessing ';
      const fieldType = au.fieldType();
      if (fieldType === 'ESCAPED_FILE') value = au.interpretRealpath();
      else if (fieldType === 'SOCKADDR') {
        value = au.interpretSockAddress();
        if (value === null) value = au.interpretSockFamily();
      } else if (type === AUDIT.CONFIG_CHANGE) {
        value = action !== null && (action === 'set' || action === 'seccomp-logging') ? au.fieldName() : au.interpretField();
      }
      if (value === null) value = au.interpretField();
      line += `${value ?? '(null)'} `;
    }
    if (normalizer.seekObjectPrimary2() === 1) {
      const value = au.fieldType() === 'ESCAPED_FILE' ? au.interpretRealpath() : au.interpretField();
      line += `to ${value ?? '(null)'} `;
    }
    const how = normalizer.getHow();
    if (how !== null && action !== null && action[0] !== 'e') line += `using ${how}`;
    this.out.printf(`${line}\n`);
  }
}
