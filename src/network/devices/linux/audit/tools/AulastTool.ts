import { AUDIT } from './AuditConstants';
import { AUDIT_NUMBERS } from './AuditNormalizeTables';
import { auparseEvents, type AuparseEvent } from './AuparseEvent';
import { Interpreter } from './AuditInterpret';
import { resolveLogSource, type AuditLoginHost } from './AuditLoginHost';
import { ToolOutput, type ToolResult } from './AuditToolHost';

const LOG_IN = 0;
const SESSION_START = 1;
const LOG_OUT = 2;
const DOWN = 3;
const CRASH = 4;
const GONE = 5;

class Node {
  next: Node | null = null;
  session = 0;
  start = 0;
  end = 0;
  auid = 0;
  pid = 0;
  name: string | null = null;
  term: string | null = null;
  host: string | null = null;
  result = -1;
  status = LOG_IN;
  loginuidProof = 0;
  userLoginProof = 0;
  userEndProof = 0;
}

class SessionList {
  head: Node | null = null;
  cur: Node | null = null;

  first(): void {
    this.cur = this.head;
  }

  next(): Node | null {
    if (this.cur === null) return null;
    this.cur = this.cur.next;
    return this.cur;
  }

  append(node: Node): void {
    node.next = null;
    if (this.head === null) this.head = node;
    else if (this.cur !== null) {
      while (this.cur.next !== null) this.cur = this.cur.next;
      this.cur.next = node;
    }
    this.cur = node;
  }

  deleteCurrent(): void {
    let prev = this.head;
    let cur = this.head;
    while (cur !== null) {
      if (cur === this.cur) {
        if (cur === prev && cur === this.head) {
          this.head = cur.next;
          this.cur = cur.next;
        } else {
          (prev as Node).next = cur.next;
          this.cur = prev;
        }
        return;
      }
      prev = cur;
      cur = cur.next;
    }
  }

  findAuid(auid: number, pid: number, session: number): Node | null {
    for (let node = this.head; node !== null; node = node.next) {
      if (node.pid === pid && node.auid === auid && node.session === session) {
        this.cur = node;
        return node;
      }
    }
    return null;
  }

  findSession(session: number): Node | null {
    for (let node = this.head; node !== null; node = node.next) {
      if (node.session === session) {
        this.cur = node;
        return node;
      }
    }
    return null;
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (value: number): string => String(value).padStart(2, '0');
const unsigned = (value: number): number => value >>> 0;

const USAGE = 'usage: aulast [--bad] [--debug] [--stdin] [--proof] [--extract] [-f file] [--user name] [--tty tty]\n';

class Aulast {
  private readonly sessions = new SessionList();
  private kernel: string | null = null;
  private bad = 0;
  private proof = false;
  private debug = false;
  private terminal: string | null = null;
  private user: string | null = null;
  private extract: string[] | null = null;

  constructor(private readonly host: AuditLoginHost, private readonly out: ToolOutput) {}

  private ctime(sec: number): string {
    const tm = this.host.localTime(sec);
    return `${WEEKDAYS[tm.wday]} ${MONTHS[tm.mon]} ${String(tm.mday).padStart(2, ' ')} ${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)} ${tm.year}`;
  }

  private shortDate(sec: number): string {
    const tm = this.host.localTime(sec);
    return `${pad2(tm.mon + 1)}/${pad2(tm.mday)}/${pad2(tm.year % 100)} ${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)}`;
  }

  private report(node: Node | null): void {
    if (node === null) return;
    if (node.result !== this.bad) return;
    let noTime = false;
    let line = '';
    if (node.name !== null) {
      line += `${node.name.slice(0, 8).padEnd(8)} `;
      if (node.end === 0) {
        node.end = this.host.nowSec();
        noTime = true;
      }
    } else line += `${node.auid === 0 ? '' : String(unsigned(node.auid))}`.padEnd(8) + ' ';
    const term = node.term ?? '';
    line += `${(term.startsWith('/dev/') ? term.slice(5) : term).slice(0, 12).padEnd(12)} `;
    line += `${(node.host ?? '?').slice(0, 16).padEnd(16)} `;
    line += `${this.ctime(node.start).slice(0, 16).padEnd(16)} `;
    switch (node.status) {
      case SESSION_START:
        line += '  still logged in\n';
        break;
      case DOWN:
        line += '- down\n';
        break;
      case CRASH:
        line += '- crash\n';
        break;
      case GONE:
        line += '  gone - no logout\n';
        break;
      case LOG_OUT: {
        if (noTime) line += `- ${' '.padEnd(7)}`;
        else line += `- ${this.ctime(node.end).slice(11).slice(0, 5).padEnd(7)}`;
        const secs = node.end - node.start;
        const mins = Math.trunc(secs / 60) % 60;
        const hours = Math.trunc(secs / 3600) % 24;
        const days = Math.trunc(secs / 86400);
        line += days !== 0 ? `(${days}+${pad2(hours)}:${pad2(mins)})\n` : `(${pad2(hours)}:${pad2(mins)})\n`;
        break;
      }
      default:
        line += '\n';
        break;
    }
    this.out.printf(line);
    if (this.proof) {
      if (node.loginuidProof === 0 && node.result === 1) this.out.printf(`    audit event proof serial number: ${node.userLoginProof}\n`);
      else this.out.printf(`    audit event proof serial numbers: ${node.loginuidProof}, ${node.userLoginProof}, ${node.userEndProof}\n`);
      this.out.printf('    Session data can be found with this search:\n');
      const start = this.shortDate(node.start);
      let search = '';
      if (node.end !== 0) search = `    ausearch --start ${start} --end ${this.shortDate(node.end)}`;
      else search = `    ausearch --start ${start}`;
      this.out.printf(search);
      if (node.name === null) this.out.printf(` --session ${node.session}`);
      if (node.loginuidProof === 0 && node.result === 1) this.out.printf(` -a ${node.userLoginProof}`);
      this.out.printf('\n\n');
    }
  }

  private extractRecord(au: AuparseEvent): void {
    if (this.extract === null) return;
    this.extract.push(`${au.recordText() ?? ''}\n`);
  }

  private createNewSession(au: AuparseEvent): void {
    let pid = -1;
    let auid = -1;
    let ses = -1;
    let account: string | null = null;
    if (au.findField('pid') !== null) pid = au.fieldInt();
    let tauid: string | null;
    if (au.findField('old-auid') !== null) tauid = au.findField('auid');
    else {
      au.firstRecord();
      au.findField('auid');
      au.nextField();
      tauid = au.findField('auid');
    }
    if (tauid !== null) {
      auid = au.fieldInt();
      account = au.interpretField();
    }
    let tses: string | null;
    if (au.findField('old-ses') !== null) tses = au.findField('ses');
    else {
      au.firstRecord();
      au.findField('ses');
      au.nextField();
      tses = au.findField('ses');
    }
    if (tses !== null) ses = au.fieldInt();
    if (pid === -1 || auid === -1 || ses === -1) {
      if (this.debug) this.out.eprintf(`Bad login for event: ${au.time.serial}\n`);
      return;
    }
    const open = this.sessions.findSession(ses >>> 0);
    if (open !== null) {
      open.status = GONE;
      open.end = au.time.sec;
      this.report(open);
      this.sessions.deleteCurrent();
    }
    if (this.user !== null) {
      if ((account !== null && this.user !== account) || account === null) {
        if (this.debug) this.out.eprintf(`login reporting limited to ${this.user} for event: ${au.time.serial}\n`);
        return;
      }
    }
    const node = new Node();
    node.session = ses >>> 0;
    node.start = au.time.sec;
    node.end = 0;
    node.auid = auid >>> 0;
    node.pid = pid;
    node.result = -1;
    node.name = account;
    node.status = LOG_IN;
    node.loginuidProof = au.time.serial;
    this.sessions.append(node);
  }

  private updateSessionLogin(au: AuparseEvent): void {
    let pid = -1;
    let uid = -1;
    let ses = -1;
    let result = -1;
    if (au.findField('pid') !== null) pid = au.fieldInt();
    if (au.findField('ses') !== null) ses = au.fieldInt();
    if (au.findField('uid') !== null) uid = au.fieldInt();
    else {
      au.firstRecord();
      if (au.findField('id') !== null) uid = au.fieldInt();
      au.firstRecord();
    }
    const start = au.time.sec;
    let host = au.findField('hostname');
    if (host !== null && host === '?') host = au.findField('addr');
    let term = au.findField('terminal');
    if (term === null) term = '?';
    let tres = au.findField('res');
    if (tres !== null) tres = au.interpretField();
    if (tres !== null) result = tres === 'success' ? 0 : 1;
    let account: string | null = null;
    if (result === 1) {
      au.firstRecord();
      account = au.findField('acct');
      if (account !== null) account = au.interpretField();
    } else if (pid === -1 || uid === -1 || ses === -1) {
      if (this.debug) this.out.eprintf(`Bad user login for event: ${au.time.serial}\n`);
      return;
    }
    const current = result === 0 ? this.sessions.findAuid(uid >>> 0, pid, ses >>> 0) : null;
    if (current !== null) {
      if (this.terminal !== null && !term.includes(this.terminal)) {
        this.sessions.deleteCurrent();
        if (this.debug) this.out.eprintf(`User login limited to ${this.terminal} for event: ${au.time.serial}\n`);
        return;
      }
      const node = this.sessions.cur as Node;
      node.status = SESSION_START;
      node.term = term;
      if (host !== null) node.host = host;
      node.result = result;
      node.userLoginProof = au.time.serial;
    } else if (this.bad === 1 && result === 1) {
      const node = new Node();
      node.start = start;
      node.end = start;
      node.auid = uid >>> 0;
      node.name = account;
      node.term = term;
      node.host = host;
      node.result = result;
      node.status = LOG_OUT;
      node.loginuidProof = 0;
      node.userLoginProof = au.time.serial;
      node.userEndProof = 0;
      this.report(node);
    } else if (this.debug) this.out.printf('Session not found or updated\n');
  }

  private updateSessionLogout(au: AuparseEvent): void {
    let pid = -1;
    let auid = -1;
    let ses = -1;
    if (au.findField('pid') !== null) pid = au.fieldInt();
    if (au.findField('auid') !== null) auid = au.fieldInt();
    if (au.findField('ses') !== null) ses = au.fieldInt();
    if (pid === -1 || auid === -1 || ses === -1) {
      if (this.debug) this.out.eprintf(`Bad user logout for event: ${au.time.serial}\n`);
      return;
    }
    const current = this.sessions.findAuid(auid >>> 0, pid, ses >>> 0);
    if (current !== null) {
      if (current.start !== 0) {
        current.end = au.time.sec;
        current.status = LOG_OUT;
        current.userEndProof = au.time.serial;
        this.report(current);
      } else if (this.debug) this.out.eprintf(`start time error for event: ${au.time.serial}\n`);
      this.sessions.deleteCurrent();
    }
  }

  private processBootup(au: AuparseEvent): void {
    this.sessions.first();
    let cur = this.sessions.cur;
    while (cur !== null) {
      if (cur.name !== null) {
        cur.userEndProof = au.time.serial;
        cur.status = CRASH;
        cur.end = au.time.sec;
        this.report(cur);
      }
      cur = this.sessions.next();
    }
    this.sessions.first();
    cur = this.sessions.cur;
    while (cur !== null) {
      if (cur.status !== CRASH) {
        cur.userEndProof = au.time.serial;
        cur.status = DOWN;
        cur.end = au.time.sec;
        this.report(cur);
      }
      cur = this.sessions.next();
    }
    this.sessions.head = null;
    this.sessions.cur = null;
    const node = new Node();
    node.session = 0;
    node.auid = 0;
    node.pid = 0;
    node.loginuidProof = au.time.serial;
    this.sessions.append(node);
    node.start = au.time.sec;
    node.name = 'reboot';
    node.term = 'system boot';
    if (this.kernel !== null) node.host = this.kernel;
    node.result = 0;
  }

  private processKernel(au: AuparseEvent): void {
    const kernel = au.findField('kernel');
    if (kernel !== null) this.kernel = kernel;
  }

  private processShutdown(au: AuparseEvent): void {
    this.sessions.first();
    let cur = this.sessions.cur;
    while (cur !== null) {
      if (cur.name !== null) {
        cur.end = au.time.sec;
        cur.status = LOG_OUT;
        cur.userEndProof = au.time.serial;
        this.report(cur);
        this.sessions.deleteCurrent();
        return;
      }
      cur = this.sessions.next();
    }
  }

  run(args: string[], stdin: string | null): number {
    let useStdin = false;
    let file: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const argument = args[i];
      if (argument === '-f') {
        if (!useStdin) {
          i++;
          file = args[i] ?? null;
        } else {
          this.out.eprintf('stdin already given\n');
          return 1;
        }
      } else if (argument === '--bad') this.bad = 1;
      else if (argument === '--proof') this.proof = true;
      else if (argument === '--extract') this.extract = [];
      else if (argument === '--stdin') {
        if (file === null) useStdin = true;
        else {
          this.out.eprintf('file already given\n');
          return 1;
        }
      } else if (argument === '--user') {
        if (this.user === null) {
          i++;
          this.user = args[i] ?? null;
        } else {
          this.out.eprintf(USAGE);
          return 1;
        }
      } else if (argument === '--tty') {
        if (this.terminal === null) {
          i++;
          this.terminal = args[i] ?? null;
        } else {
          this.out.eprintf(USAGE);
          return 1;
        }
      } else if (argument === '--debug') this.debug = true;
      else {
        this.out.eprintf(USAGE);
        return 1;
      }
    }
    if (file === null && !useStdin && this.host.uid() !== 0) this.out.eprintf('You probably need to be root for this to work\n');
    const source = resolveLogSource(this.host, { file, stdin, useStdin });
    if (source.kind === 'error') {
      this.out.eprintf(source.stderr);
      this.out.eprintf(`Error - ${source.message}\n`);
      this.flushExtract();
      return 1;
    }
    const events = auparseEvents(source.texts, this.host.auditConfig()?.eoeTimeout ?? 2, new Interpreter(this.host));
    for (const au of events) {
      const type = au.type();
      switch (type) {
        case AUDIT.LOGIN:
          this.createNewSession(au);
          this.extractRecord(au);
          break;
        case AUDIT.USER_LOGIN:
          this.updateSessionLogin(au);
          this.extractRecord(au);
          break;
        case AUDIT.USER_END:
          this.updateSessionLogout(au);
          this.extractRecord(au);
          break;
        case AUDIT_NUMBERS.SYSTEM_BOOT:
          this.processBootup(au);
          this.extractRecord(au);
          break;
        case AUDIT_NUMBERS.SYSTEM_SHUTDOWN:
          this.processShutdown(au);
          this.extractRecord(au);
          break;
        case AUDIT.DAEMON_START:
          this.processKernel(au);
          this.extractRecord(au);
          break;
        default:
          break;
      }
    }
    this.sessions.first();
    do {
      this.report(this.sessions.cur);
    } while (this.sessions.next() !== null);
    this.flushExtract();
    return 0;
  }

  private flushExtract(): void {
    if (this.extract !== null) this.host.writeFile('aulast.log', this.extract.join(''));
  }
}

export function runAulast(host: AuditLoginHost, args: string[], stdin: string | null = null): ToolResult {
  const out = new ToolOutput();
  const code = new Aulast(host, out).run(args, stdin);
  return { stdout: out.stdout, stderr: out.stderr, exitCode: code, interleaved: out.interleaved };
}
