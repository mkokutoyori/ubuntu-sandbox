import { auparseEvents, type AuparseEvent } from './AuparseEvent';
import { Interpreter } from './AuditInterpret';
import { resolveLogSource, type AuditLoginHost } from './AuditLoginHost';
import { ToolOutput, type ToolResult } from './AuditToolHost';

interface Row {
  sec: number;
  uid: number;
  name: string;
  host: string | null;
  term: string | null;
}

const USAGE = 'usage: aulastlog [--stdin] [--user name]\n';
const pad2 = (value: number): string => String(value).padStart(2, '0');

function formatLatest(host: AuditLoginHost, sec: number): string {
  const tm = host.localTime(sec);
  return `${pad2(tm.mon + 1)}/${pad2(tm.mday)}/${pad2(tm.year % 100)} ${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)}`;
}

export function runAulastlog(host: AuditLoginHost, args: string[], stdin: string | null = null): ToolResult {
  const out = new ToolOutput();
  const done = (code: number): ToolResult => ({ stdout: out.stdout, stderr: out.stderr, exitCode: code, interleaved: out.interleaved });
  let user: string | null = null;
  let useStdin = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user' || args[i] === '-u') {
      i++;
      if (i < args.length) user = args[i];
      else {
        out.eprintf(USAGE);
        return done(1);
      }
    } else if (args[i] === '--stdin') useStdin = true;
    else {
      out.eprintf(USAGE);
      return done(1);
    }
  }
  const rows: Row[] = [];
  for (const entry of host.passwdEntries()) {
    if (user === null || user === entry.name) rows.push({ sec: 0, uid: entry.uid, name: entry.name, host: null, term: null });
  }
  if (user !== null && rows.length === 0) {
    out.printf(`Unknown User: ${user}\n`);
    return done(1);
  }
  const source = resolveLogSource(host, { file: null, stdin, useStdin });
  if (source.kind === 'error') {
    out.eprintf(source.stderr);
    out.printf(`Error - ${source.message}\n`);
    return done(1);
  }
  const eoe = host.auditConfig()?.eoeTimeout ?? 2;
  const events = auparseEvents(source.texts, eoe, new Interpreter(host));
  let index = -1;
  let current: AuparseEvent | null = null;
  let started = false;
  const nextEvent = (): number => {
    index++;
    current = index < events.length ? events[index] : null;
    return current === null ? 0 : 1;
  };
  const matches = (event: AuparseEvent): boolean => event.rawValueInRecord('type') === 'USER_LOGIN' && event.rawValueInRecord('res') === 'success';
  const searchNext = (): number => {
    if (!started) {
      if (nextEvent() <= 0) return 0;
      started = true;
    } else if (nextEvent() <= 0) return 0;
    do {
      const event = current as AuparseEvent;
      event.firstRecord();
      do {
        if (matches(event)) {
          event.firstField();
          return 1;
        }
      } while (event.nextRecord() > 0);
    } while (nextEvent() > 0);
    return 0;
  };
  while (searchNext() > 0) {
    const event = current as AuparseEvent;
    if (event.findField('auid') !== null) {
      const uid = event.fieldInt() >>> 0;
      const row = rows.find((candidate) => candidate.uid === uid);
      if (row !== undefined) {
        row.sec = event.time.sec;
        const hostName = event.findField('hostname');
        if (hostName !== null) row.host = hostName;
        const terminal = event.findField('terminal');
        if (terminal !== null) row.term = terminal;
      }
    }
    if (nextEvent() < 0) break;
  }
  out.printf('Username         Port         From                       Latest\n');
  for (const row of rows) {
    const latest = row.sec === 0 ? '**Never logged in**' : formatLatest(host, row.sec);
    out.printf(`${row.name.padEnd(16)} ${(row.term ?? '').slice(0, 12).padEnd(12)} ${(row.host ?? '').slice(0, 26).padEnd(26)} ${latest}\n`);
  }
  return done(0);
}
