import { AUDIT_RANGES } from './AuditMessageTypes';
import { AUDIT } from './AuditConstants';
import {
  AuditEventAssembler, messageTypeToName, readEvents,
} from './AuditEventAssembler';
import { AVC_UNSET, IntList, StringList } from './AuditLists';
import {
  S_FAILED, S_SUCCESS, S_UNSET, UID_UNSET, LOGINUID_UNSET, defaultSearchFlags, extractSearchItems,
  type AuditEvent, type SearchFlags,
} from './AuditSearchParser';
import { AuditTimeArgs, lookupTime } from './AuditTimeArgs';
import {
  ExitSignal, ToolOutput, formatDateTime, type AuditToolHost, type ToolResult,
} from './AuditToolHost';
import { SYSCALL_TABLES } from './AuditSyscallTables';
import { toInt32 } from './AuditCString';
import { safePrintString, ttyDataText, type EscapeMode } from './AuditPrint';

type ReportType = 'unset' | 'time' | 'summary' | 'avc' | 'mac' | 'config' | 'event' | 'file' | 'host' | 'login'
  | 'acct_mod' | 'pid' | 'syscall' | 'term' | 'user' | 'exe' | 'anomaly' | 'response' | 'crypto' | 'auth' | 'key'
  | 'tty' | 'comm' | 'virt' | 'integ';
type Detail = 'unset' | 'sum' | 'detailed' | 'specific';
type FailedMode = 'both' | 'failed' | 'success';
type ConfAct = 'neither' | 'add' | 'del';

interface Options {
  userFile: string | null;
  forceLogs: boolean;
  noConfig: boolean;
  reportType: ReportType;
  detail: Detail;
  interpret: boolean;
  failed: FailedMode;
  confAct: ConfAct;
  escape: EscapeMode;
  nodes: string[] | null;
  eoeTimeout: number;
  flags: SearchFlags;
}

const DUMMY = 'dummy';

const OPTION_TABLE: Readonly<Record<string, string>> = {
  '-au': 'auth', '--auth': 'auth', '-a': 'avc', '--avc': 'avc', '--add': 'add', '-c': 'config', '--comm': 'comm',
  '--config': 'config', '-cr': 'crypto', '--crypto': 'crypto', '--debug': 'debug', '--delete': 'del', '-e': 'event',
  '--event': 'event', '--escape': 'escape', '--eoe-timeout': 'eoe', '-f': 'file', '--file': 'file', '--failed': 'failed',
  '-h': 'host', '--host': 'host', '--help': 'help', '-i': 'interpret', '--interpret': 'interpret', '-if': 'infile',
  '--input': 'infile', '--input-logs': 'inlogs', '--integrity': 'integ', '-k': 'key', '--key': 'key', '-l': 'login',
  '--login': 'login', '-m': 'mods', '--mods': 'mods', '-ma': 'mac', '--mac': 'mac', '--node': 'node', '-nc': 'noconfig',
  '--no-config': 'noconfig', '-n': 'anomaly', '--anomaly': 'anomaly', '-p': 'pid', '--pid': 'pid', '-r': 'response',
  '--response': 'response', '-s': 'syscall', '--syscall': 'syscall', '--success': 'success', '--summary': 'summarydet',
  '-t': 'logtimes', '--log': 'logtimes', '-te': 'timeend', '--end': 'timeend', '-tm': 'terminals', '--terminal': 'terminals',
  '-ts': 'timestart', '--tty': 'tty', '--start': 'timestart', '-u': 'users', '--user': 'users', '-v': 'version',
  '--version': 'version', '-x': 'exes', '--executable': 'exes', '--virt': 'virt',
};

const USAGE = [
  'usage: aureport [options]',
  '\t-a,--avc\t\t\tAvc report',
  '\t-au,--auth\t\t\tAuthentication report',
  '\t--comm\t\t\t\tCommands run report',
  '\t-c,--config\t\t\tConfig change report',
  '\t-cr,--crypto\t\t\tCrypto report',
  '\t--debug\t\t\t\tWrite malformed events that are skipped to stderr',
  '\t--eoe-timeout secs\t\tEnd of Event Timeout',
  '\t-e,--event\t\t\tEvent report',
  '\t--escape option\t\t\tEscape output',
  '\t-f,--file\t\t\tFile name report',
  '\t--failed\t\t\tonly failed events in report',
  '\t-h,--host\t\t\tRemote Host name report',
  '\t--help\t\t\t\thelp',
  '\t-i,--interpret\t\t\tInterpretive mode',
  '\t-if,--input <Input File name>\tuse this file as input',
  '\t--input-logs\t\t\tUse the logs even if stdin is a pipe',
  '\t--integrity\t\t\tIntegrity event report',
  '\t-k,--key\t\t\tKey report',
  '\t-l,--login\t\t\tLogin report',
  '\t-m,--mods\t\t\tModification to accounts report',
  '\t-ma,--mac\t\t\tMandatory Access Control (MAC) report',
  '\t-n,--anomaly\t\t\taNomaly report',
  "\t-nc,--no-config\t\t\tDon't include config events",
  '\t--node <node name>\t\tOnly events from a specific node',
  '\t-p,--pid\t\t\tPid report',
  '\t-r,--response\t\t\tResponse to anomaly report',
  '\t-s,--syscall\t\t\tSyscall report',
  '\t--success\t\t\tonly success events in report',
  '\t--summary\t\t\tsorted totals for main object in report',
  '\t-t,--log\t\t\tLog time range report',
  '\t-te,--end [end date] [end time]\tending date & time for reports',
  '\t-tm,--terminal\t\t\tTerMinal name report',
  '\t-ts,--start [start date] [start time]\tstarting data & time for reports',
  '\t--tty\t\t\t\tReport about tty keystrokes',
  '\t-u,--user\t\t\tUser name report',
  '\t-v,--version\t\t\tVersion',
  '\t--virt\t\t\t\tVirtualization report',
  '\t-x,--executable\t\t\teXecutable name report',
  '\tIf no report is given, the summary report will be displayed',
  '',
].join('\n');

export const AUREPORT_VERSION = 'aureport version 3.1.2';

interface SummaryData {
  changes: number;
  crypto: number;
  acctChanges: number;
  goodLogins: number;
  badLogins: number;
  goodAuth: number;
  badAuth: number;
  events: number;
  avcs: number;
  mac: number;
  failedSyscalls: number;
  anomalies: number;
  responses: number;
  virt: number;
  integ: number;
  users: StringList;
  terms: StringList;
  files: StringList;
  hosts: StringList;
  exes: StringList;
  comms: StringList;
  avcObjs: StringList;
  keys: StringList;
  pids: IntList;
  sysList: StringList;
  anomList: IntList;
  macList: IntList;
  respList: IntList;
  cryptoList: IntList;
  virtList: IntList;
  integList: IntList;
}

function newSummary(): SummaryData {
  return {
    changes: 0, crypto: 0, acctChanges: 0, goodLogins: 0, badLogins: 0, goodAuth: 0, badAuth: 0, events: 0, avcs: 0,
    mac: 0, failedSyscalls: 0, anomalies: 0, responses: 0, virt: 0, integ: 0,
    users: new StringList(), terms: new StringList(), files: new StringList(), hosts: new StringList(),
    exes: new StringList(), comms: new StringList(), avcObjs: new StringList(), keys: new StringList(),
    pids: new IntList(), sysList: new StringList(), anomList: new IntList(), macList: new IntList(),
    respList: new IntList(), cryptoList: new IntList(), virtList: new IntList(), integList: new IntList(),
  };
}

const R = AUDIT_RANGES;

function cs(value: string | null): string {
  return value ?? '(null)';
}

class Aureport {
  private readonly opts: Options;
  private readonly host: AuditToolHost;
  private readonly out: ToolOutput;
  private readonly time: AuditTimeArgs;
  private readonly sd = newSummary();
  private lineItem = 0;
  private found = false;
  private assembler!: AuditEventAssembler;
  private veryLastSec = 0;
  private veryLastMilli = 0;

  constructor(host: AuditToolHost, out: ToolOutput) {
    this.host = host;
    this.out = out;
    this.time = new AuditTimeArgs(host, out);
    this.opts = {
      userFile: null, forceLogs: false, noConfig: false, reportType: 'unset', detail: 'unset', interpret: false,
      failed: 'both', confAct: 'neither', escape: 'tty', nodes: null, eoeTimeout: 0, flags: defaultSearchFlags(),
    };
  }

  private setReport(type: ReportType): boolean {
    if (this.opts.reportType === 'unset') {
      this.opts.reportType = type;
      return false;
    }
    this.out.eprintf('Error - only one report can be specified');
    return true;
  }

  private setDetail(detail: Detail): void {
    if (this.opts.detail === 'unset' || detail === 'sum') this.opts.detail = detail;
  }

  private usage(): void {
    this.out.printf(USAGE);
  }

  private unimplemented(): never {
    this.out.eprintf('Unimplemented option\n');
    throw new ExitSignal(1);
  }

  checkParams(args: string[]): number {
    const vars = ['aureport', ...args];
    const count = vars.length;
    const f = this.opts.flags;
    let c = 1;
    let retval = 0;
    while (c < count && retval === 0) {
      const optarg = c + 1 < count && vars[c + 1][0] !== '-' ? vars[c + 1] : null;
      const option = OPTION_TABLE[vars[c]];
      const detailedWith = (type: ReportType, apply: () => void, needsNoArg = true): void => {
        if (this.setReport(type)) { retval = -1; return; }
        if (needsNoArg && optarg !== null) this.unimplemented();
        this.setDetail('detailed');
        apply();
      };
      switch (option) {
        case 'infile':
          if (optarg === null) {
            this.out.eprintf(`Argument is required for ${vars[c]}\n`);
            retval = -1;
          } else {
            if (optarg.length >= 4096 - 32) {
              this.out.eprintf(`File name is too long ${optarg}\n`);
              retval = -1;
              break;
            }
            this.opts.userFile = optarg;
            c++;
          }
          break;
        case 'logtimes':
          if (this.setReport('time')) retval = -1; else this.setDetail('detailed');
          break;
        case 'avc':
          if (this.setReport('avc')) retval = -1;
          else { this.setDetail('detailed'); f.eventComm = DUMMY; f.eventSubject = DUMMY; f.eventObject = DUMMY; }
          break;
        case 'auth':
          if (this.setReport('auth')) retval = -1;
          else { this.setDetail('detailed'); f.eventExe = DUMMY; f.eventHostname = DUMMY; f.eventTerminal = DUMMY; f.eventUid = 1; }
          break;
        case 'mac':
          if (this.setReport('mac')) retval = -1;
          else { this.setDetail('detailed'); f.eventLoginuid = 1; f.eventTauid = DUMMY; }
          break;
        case 'integ':
          if (this.setReport('integ')) retval = -1;
          else { this.setDetail('detailed'); f.eventLoginuid = 1; f.eventTauid = DUMMY; }
          break;
        case 'virt':
          if (this.setReport('virt')) retval = -1; else this.setDetail('detailed');
          break;
        case 'config':
          if (this.setReport('config')) retval = -1;
          else { this.setDetail('detailed'); f.eventLoginuid = 1; f.eventTauid = DUMMY; }
          break;
        case 'crypto':
          if (this.setReport('crypto')) retval = -1;
          else { this.setDetail('detailed'); f.eventLoginuid = 1; f.eventTauid = DUMMY; }
          break;
        case 'login':
          if (this.setReport('login')) retval = -1;
          else {
            this.setDetail('detailed');
            f.eventExe = DUMMY; f.eventHostname = DUMMY; f.eventTerminal = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY;
          }
          break;
        case 'mods':
          if (this.setReport('acct_mod')) retval = -1;
          else {
            this.setDetail('detailed');
            f.eventExe = DUMMY; f.eventHostname = DUMMY; f.eventTerminal = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY;
          }
          break;
        case 'event':
          if (this.setReport('event')) retval = -1;
          else { this.setDetail('detailed'); f.eventLoginuid = 1; f.eventTauid = DUMMY; }
          break;
        case 'file':
          detailedWith('file', () => { f.eventFilename = DUMMY; f.eventExe = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY; });
          break;
        case 'host':
          detailedWith('host', () => { f.eventHostname = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY; });
          break;
        case 'interpret':
          this.opts.interpret = true;
          f.reportDefault = false;
          if (optarg !== null) {
            this.out.eprintf(`Argument is NOT required for ${vars[c]}\n`);
            retval = -1;
          }
          break;
        case 'pid':
          detailedWith('pid', () => { f.eventExe = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY; });
          break;
        case 'syscall':
          detailedWith('syscall', () => { f.eventComm = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY; });
          break;
        case 'terminals':
          detailedWith('term', () => { f.eventTerminal = DUMMY; f.eventHostname = DUMMY; f.eventExe = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY; });
          break;
        case 'users':
          detailedWith('user', () => {
            f.eventTerminal = DUMMY; f.eventHostname = DUMMY; f.eventExe = DUMMY; f.eventUid = 1; f.eventLoginuid = 1; f.eventTauid = DUMMY;
          });
          break;
        case 'exes':
          detailedWith('exe', () => { f.eventTerminal = DUMMY; f.eventHostname = DUMMY; f.eventExe = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY; });
          break;
        case 'comm':
          detailedWith('comm', () => { f.eventTerminal = DUMMY; f.eventHostname = DUMMY; f.eventComm = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY; });
          break;
        case 'anomaly':
          detailedWith('anomaly', () => {
            f.eventTerminal = DUMMY; f.eventHostname = DUMMY; f.eventExe = DUMMY; f.eventComm = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY;
          });
          break;
        case 'response':
          detailedWith('response', () => undefined);
          break;
        case 'key':
          detailedWith('key', () => { f.eventExe = DUMMY; f.eventKey = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY; });
          break;
        case 'tty':
          if (this.setReport('tty')) retval = -1;
          else {
            this.setDetail('detailed');
            f.eventSessionId = 1; f.eventLoginuid = 1; f.eventTauid = DUMMY; f.eventTerminal = DUMMY; f.eventComm = DUMMY;
          }
          break;
        case 'timeend':
          if (optarg !== null) {
            if (c + 2 < count && vars[c + 2] && vars[c + 2][0] !== '-') {
              if (optarg.includes(':')) { if (this.time.end(vars[c + 2], optarg) !== 0) retval = -1; }
              else if (this.time.end(optarg, vars[c + 2]) !== 0) retval = -1;
              c++;
            } else if (lookupTime(optarg) !== null) {
              if (this.time.end(optarg, '00:00:00') !== 0) retval = -1;
            } else if (!optarg.includes(':')) {
              if (this.time.end(optarg, null) !== 0) retval = -1;
            } else if (this.time.end(null, optarg) !== 0) retval = -1;
            c++;
            break;
          }
          this.out.eprintf(`${vars[c]} requires either date and/or time\n`);
          retval = -1;
          break;
        case 'timestart':
          if (optarg !== null) {
            if (c + 2 < count && vars[c + 2] && vars[c + 2][0] !== '-') {
              if (optarg.includes(':')) { if (this.time.start(vars[c + 2], optarg) !== 0) retval = -1; }
              else if (this.time.start(optarg, vars[c + 2]) !== 0) retval = -1;
              c++;
            } else if (lookupTime(optarg) !== null) {
              if (this.time.start(optarg, '00:00:00') !== 0) retval = -1;
            } else if (!optarg.includes(':')) {
              if (this.time.start(optarg, '00:00:00') !== 0) retval = -1;
            } else if (this.time.start(null, optarg) !== 0) retval = -1;
            c++;
            break;
          }
          this.out.eprintf(`${vars[c]} requires either date and/or time\n`);
          retval = -1;
          break;
        case 'node':
          if (optarg === null) {
            this.out.eprintf(`Argument is required for ${vars[c]}\n`);
            retval = -1;
          } else {
            c++;
            (this.opts.nodes ??= []).push(optarg);
          }
          break;
        case 'escape':
          if (optarg === null) {
            this.out.eprintf(`Argument is required for ${vars[c]}\n`);
            retval = -1;
          } else {
            if (optarg === 'raw') this.opts.escape = 'raw';
            else if (optarg === 'tty') this.opts.escape = 'tty';
            else if (optarg.startsWith('shell') && optarg.length === 5) this.opts.escape = 'shell';
            else if (optarg === 'shell_quote') this.opts.escape = 'shell_quote';
            else {
              this.out.eprintf(`Unknown option (${optarg})\n`);
              retval = -1;
              break;
            }
            c++;
          }
          break;
        case 'summarydet': this.setDetail('sum'); break;
        case 'failed': this.opts.failed = 'failed'; break;
        case 'success': this.opts.failed = 'success'; break;
        case 'add': this.opts.confAct = 'add'; break;
        case 'del': this.opts.confAct = 'del'; break;
        case 'debug': break;
        case 'inlogs': this.opts.forceLogs = true; break;
        case 'noconfig': this.opts.noConfig = true; break;
        case 'version':
          this.out.printf(`${AUREPORT_VERSION}\n`);
          throw new ExitSignal(0);
        case 'help':
          this.usage();
          throw new ExitSignal(0);
        case 'eoe':
          if (optarg === null) {
            this.out.eprintf(`Argument is required for ${vars[c]}\n`);
            retval = -1;
            break;
          }
          if (/^\d/.test(optarg)) {
            this.opts.eoeTimeout = parseInt(optarg, 10);
            if (this.opts.eoeTimeout === 0) {
              this.out.eprintf(`Illegal value for End of Event Timeout, was ${optarg}\n`);
              retval = -1;
            }
            c++;
          } else {
            this.out.eprintf(`End of Event Timeout must be a numeric value, was ${optarg}\n`);
            retval = -1;
          }
          break;
        default:
          this.out.eprintf(`${vars[c]} is an unsupported option\n`);
          retval = -1;
          break;
      }
      c++;
    }
    if (retval >= 0) {
      if (this.opts.reportType === 'unset') {
        if (this.setReport('summary')) retval = -1;
        else {
          this.setDetail('sum');
          f.eventFilename = DUMMY; f.eventHostname = DUMMY; f.eventTerminal = DUMMY; f.eventExe = DUMMY;
          f.eventComm = DUMMY; f.eventKey = DUMMY; f.eventLoginuid = 1; f.eventTauid = DUMMY;
        }
      }
    } else this.usage();
    return retval;
  }

  private tmUid(uid: number): string {
    const signed = toInt32(uid);
    if (!this.opts.interpret) return String(signed);
    if (uid === UID_UNSET) return 'unset';
    const name = this.host.userName(uid);
    return name ?? `unknown(${signed})`;
  }

  private syscallName(e: AuditEvent): string {
    if (!this.opts.interpret) return String(e.s.syscall);
    const table = machineTable(e.s.arch);
    if (!table) return '?';
    const sys = table[e.s.syscall];
    if (sys === undefined) return String(e.s.syscall);
    return sys;
  }

  private successName(s: number): string {
    return s === S_FAILED ? 'no' : s === S_SUCCESS ? 'yes' : 'unset';
  }

  private typeName(type: number): string {
    return messageTypeToName(type) ?? '(null)';
  }

  private safe(text: string | null, ret = false): void {
    this.out.printf(safePrintString(text, ret, this.opts.escape));
  }

  private classifySuccess(e: AuditEvent): boolean {
    if (this.opts.failed === 'failed') return e.s.success === S_FAILED;
    if (this.opts.failed === 'success') return e.s.success === S_SUCCESS;
    return true;
  }

  private classifyConf(e: AuditEvent): boolean {
    const type = e.head!.type;
    const act = this.opts.confAct;
    switch (type) {
      case AUDIT.CONFIG_CHANGE: return !this.opts.noConfig;
      case AUDIT.ADD_USER: case AUDIT.ADD_GROUP: case AUDIT.MAC_CIPSOV4_ADD: case AUDIT.MAC_MAP_ADD:
      case AUDIT.MAC_IPSEC_ADDSA: case AUDIT.MAC_IPSEC_ADDSPD: case AUDIT.MAC_UNLBL_STCADD:
        return act !== 'del';
      case AUDIT.DEL_USER: case AUDIT.DEL_GROUP: case AUDIT.MAC_CIPSOV4_DEL: case AUDIT.MAC_MAP_DEL:
      case AUDIT.MAC_IPSEC_DELSA: case AUDIT.MAC_IPSEC_DELSPD: case AUDIT.MAC_UNLBL_STCDEL:
        return act !== 'add';
      default: return true;
    }
  }

  private scan(e: AuditEvent): boolean {
    const rc = extractSearchItems(e, { flags: this.opts.flags, userName: (uid) => this.host.userName(uid) });
    if (rc !== 0) return false;
    if (this.opts.nodes) {
      if (e.e.node === null) return false;
      if (!this.opts.nodes.includes(e.e.node)) return false;
    }
    return this.classifySuccess(e) && this.classifyConf(e);
  }

  private loginAcctName(e: AuditEvent): string | null {
    if (e.s.loginuid === 0xfffffffe && e.s.acct) return e.s.acct;
    return this.tmUid(e.s.loginuid);
  }

  private perEventSummary(e: AuditEvent): boolean {
    const { sd } = this;
    const type = this.opts.reportType;
    const has = (t: number): boolean => e.hasType(t);
    const range = (lo: number, hi: number): boolean => e.hasTypeRange(lo, hi);
    switch (type) {
      case 'summary': this.doSummaryTotal(e); return true;
      case 'avc':
        if (has(AUDIT.AVC) || has(AUDIT.USER_AVC)) {
          for (const an of e.s.avc ?? []) if (an.avcResult !== AVC_UNSET) sd.avcObjs.addIfUnique(an.tcontext);
        }
        break;
      case 'mac':
        if (range(AUDIT.MAC_POLICY_LOAD, AUDIT.MAC_MAP_DEL) || range(R.AUDIT_FIRST_USER_LSPP_MSG, R.AUDIT_LAST_USER_LSPP_MSG)) {
          sd.macList.addIfUnique(e.head!.type);
        }
        break;
      case 'integ':
        if (range(R.AUDIT_INTEGRITY_FIRST_MSG, R.AUDIT_INTEGRITY_LAST_MSG)) sd.integList.addIfUnique(e.head!.type);
        break;
      case 'virt':
        if (range(R.AUDIT_FIRST_VIRT_MSG, R.AUDIT_LAST_VIRT_MSG)) sd.virtList.addIfUnique(e.head!.type);
        break;
      case 'config':
        if (this.isConfigEvent(e)) sd.pids.addIfUnique(e.head!.type);
        break;
      case 'auth':
        if (has(AUDIT.USER_AUTH)) {
          sd.users.addIfUnique(this.loginAcctName(e));
        } else if (has(AUDIT.USER_MGMT) && e.s.success === S_FAILED) {
          sd.users.addIfUnique(this.loginAcctName(e));
        }
        break;
      case 'login':
        if (has(AUDIT.USER_LOGIN)) {
          if (toInt32(e.s.loginuid) < 0 && e.s.acct) sd.users.addIfUnique(e.s.acct);
          else sd.users.addIfUnique(this.tmUid(e.s.loginuid));
        }
        break;
      case 'acct_mod':
        if (this.isAcctMod(e)) sd.pids.addIfUnique(e.head!.type);
        break;
      case 'event':
        if (e.head!.type !== -1) sd.pids.addIfUnique(e.head!.type);
        break;
      case 'file':
        for (const sn of e.s.filename?.nodes ?? []) if (sn.str !== null) sd.files.addIfUnique(sn.str);
        break;
      case 'host':
        if (e.s.hostname) sd.hosts.addIfUnique(e.s.hostname);
        break;
      case 'pid':
        if (e.s.pid !== -1) sd.pids.addIfUnique(e.s.pid);
        break;
      case 'syscall':
        if (e.s.syscall > 0) sd.sysList.addIfUnique(this.syscallName(e));
        break;
      case 'term':
        if (e.s.terminal) sd.terms.addIfUnique(e.s.terminal);
        break;
      case 'user':
        if (e.s.loginuid !== LOGINUID_UNSET) sd.users.addIfUnique(this.tmUid(e.s.loginuid));
        break;
      case 'exe':
        if (e.s.exe) sd.exes.addIfUnique(e.s.exe);
        break;
      case 'comm':
        if (e.s.comm) sd.comms.addIfUnique(e.s.comm);
        break;
      case 'anomaly':
        if (range(R.AUDIT_FIRST_ANOM_MSG, R.AUDIT_LAST_ANOM_MSG)
          || range(R.AUDIT_FIRST_KERN_ANOM_MSG, R.AUDIT_LAST_KERN_ANOM_MSG) || has(AUDIT.SECCOMP)) {
          sd.anomList.addIfUnique(e.head!.type);
        }
        break;
      case 'response':
        if (range(R.AUDIT_FIRST_ANOM_RESP, R.AUDIT_LAST_ANOM_RESP)) sd.respList.addIfUnique(e.head!.type);
        break;
      case 'crypto':
        if (range(R.AUDIT_FIRST_KERN_CRYPTO_MSG, R.AUDIT_LAST_KERN_CRYPTO_MSG) || range(R.AUDIT_FIRST_CRYPTO_MSG, R.AUDIT_LAST_CRYPTO_MSG)) {
          sd.cryptoList.addIfUnique(e.head!.type);
        }
        break;
      case 'key':
        for (const sn of e.s.key?.nodes ?? []) if (sn.str !== null && sn.str !== '(null)') sd.keys.addIfUnique(sn.str);
        break;
      case 'tty':
        this.unimplemented();
        break;
      default:
        break;
    }
    return false;
  }

  private isConfigEvent(e: AuditEvent): boolean {
    return e.hasType(AUDIT.CONFIG_CHANGE) || e.hasType(AUDIT.DAEMON_CONFIG) || e.hasType(AUDIT.USYS_CONFIG)
      || e.hasType(AUDIT.NETFILTER_CFG) || e.hasType(AUDIT.FEATURE_CHANGE) || e.hasType(AUDIT.USER_MAC_CONFIG_CHANGE)
      || e.hasTypeRange(AUDIT.MAC_POLICY_LOAD, AUDIT.MAC_UNLBL_STCDEL);
  }

  private isAcctMod(e: AuditEvent): boolean {
    return e.hasType(AUDIT.USER_CHAUTHTOK) || e.hasTypeRange(AUDIT.ADD_USER, AUDIT.DEL_GROUP) || e.hasType(AUDIT.USER_MGMT)
      || e.hasType(AUDIT.GRP_MGMT) || e.hasTypeRange(AUDIT.ROLE_ASSIGN, AUDIT.ROLE_REMOVE);
  }

  private perEventDetailed(e: AuditEvent): boolean {
    const type = this.opts.reportType;
    const has = (t: number): boolean => e.hasType(t);
    const range = (lo: number, hi: number): boolean => e.hasTypeRange(lo, hi);
    switch (type) {
      case 'avc':
        if (has(AUDIT.AVC) || has(AUDIT.USER_AVC)) { this.printPerEventItem(e); return true; }
        break;
      case 'mac':
        if (range(AUDIT.MAC_POLICY_LOAD, AUDIT.MAC_UNLBL_STCDEL) || range(R.AUDIT_FIRST_USER_LSPP_MSG, R.AUDIT_LAST_USER_LSPP_MSG)) {
          this.printPerEventItem(e);
          return true;
        }
        break;
      case 'integ':
        if (range(R.AUDIT_INTEGRITY_FIRST_MSG, R.AUDIT_INTEGRITY_LAST_MSG)) { this.printPerEventItem(e); return true; }
        break;
      case 'virt':
        if (range(R.AUDIT_FIRST_VIRT_MSG, R.AUDIT_LAST_VIRT_MSG)) { this.printPerEventItem(e); return true; }
        break;
      case 'config':
        if (this.isConfigEvent(e)) { this.printPerEventItem(e); return true; }
        break;
      case 'auth':
        if (has(AUDIT.USER_AUTH)) { this.printPerEventItem(e); return true; }
        if (has(AUDIT.USER_MGMT) && e.s.success === S_FAILED) { this.printPerEventItem(e); return true; }
        break;
      case 'login':
        if (has(AUDIT.USER_LOGIN)) { this.printPerEventItem(e); return true; }
        break;
      case 'acct_mod':
        if (this.isAcctMod(e)) { this.printPerEventItem(e); return true; }
        break;
      case 'event':
        this.printPerEventItem(e);
        return true;
      case 'file':
        if (e.s.filename) { this.printPerEventItem(e); return true; }
        break;
      case 'host':
        if (e.s.hostname) { this.printPerEventItem(e); return true; }
        break;
      case 'pid':
        if (e.s.pid >= 0) { this.printPerEventItem(e); return true; }
        break;
      case 'syscall':
        if (e.s.syscall) { this.printPerEventItem(e); return true; }
        break;
      case 'term':
        if (e.s.terminal) { this.printPerEventItem(e); return true; }
        break;
      case 'user':
        if (e.s.uid !== UID_UNSET) { this.printPerEventItem(e); return true; }
        break;
      case 'exe':
        if (e.s.exe) { this.printPerEventItem(e); return true; }
        break;
      case 'comm':
        if (e.s.comm) { this.printPerEventItem(e); return true; }
        break;
      case 'anomaly':
        if (range(R.AUDIT_FIRST_ANOM_MSG, R.AUDIT_LAST_ANOM_MSG)
          || range(R.AUDIT_FIRST_KERN_ANOM_MSG, R.AUDIT_LAST_KERN_ANOM_MSG) || has(AUDIT.SECCOMP)) {
          this.printPerEventItem(e);
          return true;
        }
        break;
      case 'response':
        if (range(R.AUDIT_FIRST_ANOM_RESP, R.AUDIT_LAST_ANOM_RESP)) { this.printPerEventItem(e); return true; }
        break;
      case 'crypto':
        if (range(R.AUDIT_FIRST_KERN_CRYPTO_MSG, R.AUDIT_LAST_KERN_CRYPTO_MSG) || range(R.AUDIT_FIRST_CRYPTO_MSG, R.AUDIT_LAST_CRYPTO_MSG)) {
          this.printPerEventItem(e);
          return true;
        }
        break;
      case 'key':
        if (e.s.key && e.s.key.nodes[0] && e.s.key.nodes[0].str !== '(null)') { this.printPerEventItem(e); return true; }
        break;
      case 'tty':
        if (e.head!.type === AUDIT.TTY || e.head!.type === AUDIT.USER_TTY) { this.printPerEventItem(e); return true; }
        break;
      default:
        break;
    }
    return false;
  }

  private doSummaryTotal(e: AuditEvent): void {
    const { sd } = this;
    const has = (t: number): boolean => e.hasType(t);
    const range = (lo: number, hi: number): boolean => e.hasTypeRange(lo, hi);
    sd.events++;
    if (has(AUDIT.CONFIG_CHANGE)) sd.changes++;
    if (has(AUDIT.DAEMON_CONFIG)) sd.changes++;
    if (has(AUDIT.USYS_CONFIG)) sd.changes++;
    if (has(AUDIT.NETFILTER_CFG)) sd.changes++;
    if (has(AUDIT.FEATURE_CHANGE)) sd.changes++;
    if (has(AUDIT.USER_MAC_CONFIG_CHANGE)) sd.changes++;
    if (range(AUDIT.MAC_POLICY_LOAD, AUDIT.MAC_UNLBL_STCDEL)) sd.changes++;
    if (has(AUDIT.USER_CHAUTHTOK)) sd.acctChanges++;
    if (range(AUDIT.ADD_USER, AUDIT.DEL_GROUP)) sd.acctChanges++;
    if (has(AUDIT.USER_MGMT)) sd.acctChanges++;
    if (has(AUDIT.GRP_MGMT)) sd.acctChanges++;
    if (range(AUDIT.ROLE_ASSIGN, AUDIT.ROLE_REMOVE)) sd.acctChanges++;
    if (range(R.AUDIT_FIRST_KERN_CRYPTO_MSG, R.AUDIT_LAST_KERN_CRYPTO_MSG)) sd.crypto++;
    if (range(R.AUDIT_FIRST_CRYPTO_MSG, R.AUDIT_LAST_CRYPTO_MSG)) sd.crypto++;
    if (has(AUDIT.USER_LOGIN)) {
      if (e.s.success === S_SUCCESS) sd.goodLogins++;
      else if (e.s.success === S_FAILED) sd.badLogins++;
    }
    if (has(AUDIT.USER_AUTH)) {
      if (e.s.success === S_SUCCESS) sd.goodAuth++;
      else if (e.s.success === S_FAILED) sd.badAuth++;
    } else if (has(AUDIT.USER_MGMT)) {
      if (e.s.success === S_FAILED) sd.badAuth++;
    } else if (has(AUDIT.GRP_AUTH)) {
      if (e.s.success === S_SUCCESS) sd.goodAuth++;
      else if (e.s.success === S_FAILED) sd.badAuth++;
    }
    if (e.s.loginuid !== LOGINUID_UNSET) sd.users.addIfUnique(String(toInt32(e.s.loginuid)));
    if (e.s.terminal) sd.terms.addIfUnique(e.s.terminal);
    if (e.s.hostname) sd.hosts.addIfUnique(e.s.hostname);
    if (e.s.exe) sd.exes.addIfUnique(e.s.exe);
    if (e.s.comm) sd.comms.addIfUnique(e.s.comm);
    for (const sn of e.s.filename?.nodes ?? []) if (sn.str !== null) sd.files.addIfUnique(sn.str);
    if (has(AUDIT.AVC) || has(AUDIT.USER_AVC)) sd.avcs++;
    if (range(AUDIT.MAC_POLICY_LOAD, AUDIT.MAC_UNLBL_STCDEL)) sd.mac++;
    if (range(R.AUDIT_FIRST_USER_LSPP_MSG, R.AUDIT_LAST_USER_LSPP_MSG)) sd.mac++;
    if (range(R.AUDIT_FIRST_VIRT_MSG, R.AUDIT_LAST_VIRT_MSG)) sd.virt++;
    if (range(R.AUDIT_INTEGRITY_FIRST_MSG, R.AUDIT_INTEGRITY_LAST_MSG)) sd.integ++;
    if (e.s.success === S_FAILED && e.s.syscall > 0) sd.failedSyscalls++;
    if (e.s.pid !== -1) sd.pids.addIfUnique(e.s.pid);
    if (range(R.AUDIT_FIRST_ANOM_MSG, R.AUDIT_LAST_ANOM_MSG)) sd.anomalies++;
    if (range(R.AUDIT_FIRST_KERN_ANOM_MSG, R.AUDIT_LAST_KERN_ANOM_MSG)) sd.anomalies++;
    if (range(R.AUDIT_FIRST_ANOM_RESP, R.AUDIT_LAST_ANOM_RESP)) sd.responses++;
    for (const sn of e.s.key?.nodes ?? []) if (sn.str !== null && sn.str !== '(null)') sd.keys.addIfUnique(sn.str);
  }

  private perEventProcessing(e: AuditEvent): boolean {
    if (this.opts.detail === 'sum') return this.perEventSummary(e);
    if (this.opts.detail === 'detailed') return this.perEventDetailed(e);
    return false;
  }

  private printTitle(): void {
    this.lineItem = 0;
    this.out.printf('\n');
    if (this.opts.detail === 'sum') this.printTitleSummary();
    else if (this.opts.detail === 'detailed') this.printTitleDetailed();
  }

  private printTitleSummary(): void {
    const o = this.out;
    if (this.opts.failed === 'failed') o.printf('Failed ');
    if (this.opts.failed === 'success') o.printf('Success ');
    const block = (title: string, rule: string, header?: string): void => {
      o.printf(`${title}\n${rule}\n`);
      if (header) o.printf(`${header}\n${rule}\n`);
    };
    switch (this.opts.reportType) {
      case 'summary': block('Summary Report', '======================'); break;
      case 'avc': block('Avc Object Summary Report', '=================================', 'total  obj'); break;
      case 'mac': block('MAC Summary Report', '==================', 'total  type'); break;
      case 'integ': block('Integrity Summary Report', '========================', 'total  type'); break;
      case 'virt': block('Virtualization Summary Report', '=============================', 'total  type'); break;
      case 'config': block('Config Change Summary Report', '============================', 'total  type'); break;
      case 'auth': block('Authentication Summary Report', '=============================', 'total  acct'); break;
      case 'login': block('Login Summary Report', '============================', 'total  auid'); break;
      case 'acct_mod': block('Acct Modification Summary Report', '================================', 'total  type'); break;
      case 'time': this.unimplemented(); break;
      case 'event': block('Event Summary Report', '======================', 'total  type'); break;
      case 'file': block('File Summary Report', '===========================', 'total  file'); break;
      case 'host': block('Host Summary Report', '===========================', 'total  host'); break;
      case 'pid': block('Pid Summary Report', '==========================', 'total  pid'); break;
      case 'syscall': block('Syscall Summary Report', '==========================', 'total  syscall'); break;
      case 'term': block('Terminal Summary Report', '===============================', 'total  terminal'); break;
      case 'user': block('User Summary Report', '===========================', 'total  auid'); break;
      case 'exe': block('Executable Summary Report', '=================================', 'total  file'); break;
      case 'comm': block('Command Summary Report', '=================================', 'total  command'); break;
      case 'anomaly': block('Anomaly Summary Report', '======================', 'total  type'); break;
      case 'response': block('Anomaly Response Summary Report', '===============================', 'total  type'); break;
      case 'crypto': block('Crypto Summary Report', '=====================', 'total  type'); break;
      case 'key': block('Key Summary Report', '===========================', 'total  key'); break;
      case 'tty': this.unimplemented(); break;
      default: break;
    }
  }

  private printTitleDetailed(): void {
    const o = this.out;
    const table = (title: string, rule: string, header: string, ruleBottom = rule): void => {
      o.printf(`${title}\n${rule}\n${header}\n${ruleBottom}\n`);
    };
    switch (this.opts.reportType) {
      case 'avc': table('AVC Report', '===============================================================', '# date time comm subj syscall class permission obj result event'); break;
      case 'config': table('Config Change Report', '===================================', '# date time type auid success event'); break;
      case 'auth': table('Authentication Report', '============================================', '# date time acct host term exe success event'); break;
      case 'login': table('Login Report', '============================================', '# date time auid host term exe success event'); break;
      case 'acct_mod': table('Account Modifications Report', '=================================================', '# date time auid addr term exe acct success event'); break;
      case 'time': o.printf('Log Time Range Report\n=====================\n'); break;
      case 'event': table('Event Report', '===================================', '# date time event type auid success'); break;
      case 'file': table('File Report', '===============================================', '# date time file syscall success exe auid event'); break;
      case 'host': table('Host Report', '===================================', '# date time host syscall auid event'); break;
      case 'pid': table('Process ID Report', '======================================', '# date time pid exe syscall auid event'); break;
      case 'syscall': table('Syscall Report', '=======================================', '# date time syscall pid comm auid event'); break;
      case 'term': table('Terminal Report', '====================================', '# date time term host exe auid event'); break;
      case 'user': table('User ID Report', '====================================', '# date time auid term host exe event'); break;
      case 'exe': table('Executable Report', '====================================', '# date time exe term host auid event'); break;
      case 'comm': table('Command Report', '====================================', '# date time comm term host auid event', '====================================='); break;
      case 'anomaly': table('Anomaly Report', '=========================================', '# date time type exe term host auid event'); break;
      case 'response': table('Response to Anomaly Report', '==============================', '# date time type success event'); break;
      case 'mac': table('MAC Report', '===================================', '# date time auid type success event'); break;
      case 'integ': table('Integrity Report', '==============================', '# date time type success event'); break;
      case 'virt': table('Virtualization Report', '==============================', '# date time type success event'); break;
      case 'crypto': table('Crypto Report', '===================================', '# date time auid type success event'); break;
      case 'key': table('Key Report', '===============================================', '# date time key success exe auid event'); break;
      case 'tty': table('TTY Report', '===============================================', '# date time event auid term sess comm data'); break;
      default: break;
    }
  }

  private printPerEventItem(e: AuditEvent): void {
    const o = this.out;
    const date = formatDateTime(this.host, e.e.sec);
    const type = this.opts.reportType;
    if (type !== 'avc') {
      this.lineItem++;
      o.printf(`${this.lineItem}. ${date} `);
    }
    const uid = (u: number): string => this.tmUid(u);
    const sysName = (): string => this.syscallName(e);
    const serial = e.e.serial;
    const s = e.s;
    switch (type) {
      case 'avc': {
        const nodes = s.avc ?? [];
        let index = nodes.findIndex((n) => n.avcResult !== AVC_UNSET);
        if (index < 0) index = nodes.length - 1;
        while (index >= 0 && index < nodes.length) {
          const an = nodes[index];
          this.lineItem++;
          o.printf(`${this.lineItem}. ${date} `);
          this.safe(s.comm ?? '?', false);
          o.printf(` ${cs(an.scontext)} ${sysName()} ${cs(an.avcClass)} ${cs(an.avcPerm)} ${cs(an.tcontext)} ${['unset', 'denied', 'granted'][an.avcResult]} ${serial}\n`);
          let next = index + 1;
          while (next < nodes.length && nodes[next].avcResult === AVC_UNSET) next++;
          index = next < nodes.length ? next : -1;
        }
        break;
      }
      case 'config':
        o.printf(`${this.typeName(e.head!.type)} ${uid(s.loginuid)} ${this.successName(s.success)} ${serial}\n`);
        break;
      case 'auth':
        this.safe(s.acct ?? uid(s.uid), false);
        o.printf(` ${cs(s.hostname)} ${cs(s.terminal)} ${cs(s.exe)} ${this.successName(s.success)} ${serial}\n`);
        break;
      case 'login':
        this.safe(s.success === S_FAILED && s.acct ? s.acct : uid(s.loginuid), false);
        o.printf(` ${cs(s.hostname)} ${cs(s.terminal)} ${cs(s.exe)} ${this.successName(s.success)} ${serial}\n`);
        break;
      case 'acct_mod':
        this.safe(uid(s.loginuid), false);
        o.printf(` ${s.hostname ?? '?'} ${s.terminal ?? '?'} ${s.exe ?? '?'} ${s.acct ?? '?'} ${this.successName(s.success)} ${serial}\n`);
        break;
      case 'event':
        o.printf(`${serial} ${this.typeName(e.head!.type)} `);
        this.safe(uid(s.loginuid), false);
        o.printf(` ${this.successName(s.success)}\n`);
        break;
      case 'file': {
        const nodes = s.filename!.nodes;
        let idx = 0;
        if (nodes.length > 1) {
          while (idx < nodes.length && nodes[idx].key !== null && nodes[idx].key === 'PARENT') idx++;
        }
        this.safe(nodes[idx] ? nodes[idx].str : '', false);
        o.printf(` ${sysName()} ${this.successName(s.success)} `);
        this.safe(s.exe ?? '?', false);
        o.printf(' ');
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      }
      case 'host':
        o.printf(`${cs(s.hostname)} ${sysName()} `);
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      case 'pid':
        o.printf(`${s.pid >>> 0} `);
        this.safe(s.exe ?? '?', false);
        o.printf(` ${sysName()} `);
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      case 'syscall':
        o.printf(`${sysName()} ${s.pid >>> 0} `);
        this.safe(s.comm ?? '?', false);
        o.printf(' ');
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      case 'term':
        o.printf(`${cs(s.terminal)} ${cs(s.hostname)} `);
        this.safe(s.exe, false);
        o.printf(' ');
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      case 'user':
        this.safe(uid(s.loginuid), false);
        o.printf(` ${s.terminal ?? '?'} ${s.hostname ?? '?'} `);
        this.safe(s.exe ?? '?', false);
        o.printf(` ${serial}\n`);
        break;
      case 'exe':
        this.safe(s.exe ?? '?', false);
        o.printf(` ${s.terminal ?? '?'} ${s.hostname ?? '?'} `);
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      case 'comm':
        this.safe(s.comm ?? '?', false);
        o.printf(` ${s.terminal ?? '?'} ${s.hostname ?? '?'} `);
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      case 'anomaly':
        o.printf(`${this.typeName(e.head!.type)} `);
        this.safe(s.exe ?? s.comm ?? '?', false);
        o.printf(` ${s.terminal ?? '?'} ${s.hostname ?? '?'} `);
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      case 'response':
        o.printf(`${this.typeName(e.head!.type)} ${this.successName(s.success)} ${serial}\n`);
        break;
      case 'mac':
        o.printf(`${uid(s.loginuid)} ${this.typeName(e.head!.type)} ${this.successName(s.success)} ${serial}\n`);
        break;
      case 'integ':
      case 'virt':
        o.printf(`${this.typeName(e.head!.type)} ${this.successName(s.success)} ${serial}\n`);
        break;
      case 'crypto':
        this.safe(uid(s.loginuid), false);
        o.printf(` ${this.typeName(e.head!.type)} ${this.successName(s.success)} ${serial}\n`);
        break;
      case 'key':
        o.printf(`${cs(s.key!.nodes[0].str)} ${this.successName(s.success)} `);
        this.safe(s.exe ?? '?', false);
        o.printf(' ');
        this.safe(uid(s.loginuid), false);
        o.printf(` ${serial}\n`);
        break;
      case 'tty': {
        const msg = e.head!.message;
        const at = msg.indexOf('data=');
        if (at < 0) break;
        let data = msg.slice(at + 5);
        const lastSpace = data.lastIndexOf(' ');
        if (lastSpace >= 0) data = data.slice(0, lastSpace);
        o.printf(`${serial} `);
        this.safe(uid(s.loginuid), false);
        o.printf(` ${s.terminal ?? '?'} ${s.sessionId >>> 0} `);
        this.safe(s.comm ?? '?', false);
        o.printf(' ');
        o.printf(ttyDataText(data));
        o.printf('\n');
        break;
      }
      default:
        break;
    }
  }

  private printWrapUp(): void {
    if (this.opts.detail !== 'sum') return;
    const { sd } = this;
    switch (this.opts.reportType) {
      case 'summary': this.doSummaryOutput(); break;
      case 'avc': sd.avcObjs.sortByHits(); this.doStringSummary(sd.avcObjs); break;
      case 'config': sd.pids.sortByHits(); this.doTypeSummary(sd.pids); break;
      case 'auth': case 'login': case 'user': sd.users.sortByHits(); this.doUserSummary(sd.users); break;
      case 'acct_mod': case 'event': sd.pids.sortByHits(); this.doTypeSummary(sd.pids); break;
      case 'file': sd.files.sortByHits(); this.doFileSummary(sd.files); break;
      case 'host': sd.hosts.sortByHits(); this.doStringSummary(sd.hosts); break;
      case 'pid': sd.pids.sortByHits(); this.doIntSummary(sd.pids); break;
      case 'syscall': sd.sysList.sortByHits(); this.doFileSummary(sd.sysList); break;
      case 'term': sd.terms.sortByHits(); this.doStringSummary(sd.terms); break;
      case 'exe': sd.exes.sortByHits(); this.doFileSummary(sd.exes); break;
      case 'comm': sd.comms.sortByHits(); this.doFileSummary(sd.comms); break;
      case 'anomaly': sd.anomList.sortByHits(); this.doTypeSummary(sd.anomList); break;
      case 'response': sd.respList.sortByHits(); this.doTypeSummary(sd.respList); break;
      case 'mac': sd.macList.sortByHits(); this.doTypeSummary(sd.macList); break;
      case 'integ': sd.integList.sortByHits(); this.doTypeSummary(sd.integList); break;
      case 'virt': sd.virtList.sortByHits(); this.doTypeSummary(sd.virtList); break;
      case 'crypto': sd.cryptoList.sortByHits(); this.doTypeSummary(sd.cryptoList); break;
      case 'key': sd.keys.sortByHits(); this.doFileSummary(sd.keys); break;
      default: break;
    }
  }

  private doSummaryOutput(): void {
    const o = this.out;
    const { sd } = this;
    const first = this.assembler.veryFirstSec;
    o.printf('Range of time in logs: ');
    o.printf(`${formatDateTime(this.host, first)}.${String(this.assembler.veryFirstMilli).padStart(3, '0')} - `);
    o.printf(`${formatDateTime(this.host, this.veryLastSec)}.${String(this.veryLastMilli).padStart(3, '0')}\n`);
    o.printf('Selected time for report: ');
    const startTime = this.time.startTime;
    const endTime = this.time.endTime;
    o.printf(`${formatDateTime(this.host, startTime || first)} - `);
    if (endTime) o.printf(`${formatDateTime(this.host, endTime)}\n`);
    else o.printf(`${formatDateTime(this.host, this.veryLastSec)}.${String(this.veryLastMilli).padStart(3, '0')}\n`);
    o.printf(`Number of changes in configuration: ${sd.changes}\n`);
    o.printf(`Number of changes to accounts, groups, or roles: ${sd.acctChanges}\n`);
    o.printf(`Number of logins: ${sd.goodLogins}\n`);
    o.printf(`Number of failed logins: ${sd.badLogins}\n`);
    o.printf(`Number of authentications: ${sd.goodAuth}\n`);
    o.printf(`Number of failed authentications: ${sd.badAuth}\n`);
    o.printf(`Number of users: ${sd.users.count}\n`);
    o.printf(`Number of terminals: ${sd.terms.count}\n`);
    o.printf(`Number of host names: ${sd.hosts.count}\n`);
    o.printf(`Number of executables: ${sd.exes.count}\n`);
    o.printf(`Number of commands: ${sd.comms.count}\n`);
    o.printf(`Number of files: ${sd.files.count}\n`);
    o.printf(`Number of AVC's: ${sd.avcs}\n`);
    o.printf(`Number of MAC events: ${sd.mac}\n`);
    o.printf(`Number of failed syscalls: ${sd.failedSyscalls}\n`);
    o.printf(`Number of anomaly events: ${sd.anomalies}\n`);
    o.printf(`Number of responses to anomaly events: ${sd.responses}\n`);
    o.printf(`Number of crypto events: ${sd.crypto}\n`);
    o.printf(`Number of integrity events: ${sd.integ}\n`);
    o.printf(`Number of virt events: ${sd.virt}\n`);
    o.printf(`Number of keys: ${sd.keys.count}\n`);
    o.printf(`Number of process IDs: ${sd.pids.count}\n`);
    o.printf(`Number of events: ${sd.events}\n`);
    o.printf('\n');
  }

  private doFileSummary(list: StringList): void {
    if (list.count === 0) { this.out.printf('<no events of interest were found>\n\n'); return; }
    for (const sn of list.nodes) {
      this.out.printf(`${sn.hits}  `);
      this.safe(sn.str, true);
    }
  }

  private doStringSummary(list: StringList): void {
    if (list.count === 0) { this.out.printf('<no events of interest were found>\n\n'); return; }
    for (const sn of list.nodes) this.out.printf(`${sn.hits}  ${sn.str}\n`);
  }

  private doUserSummary(list: StringList): void {
    if (list.count === 0) { this.out.printf('<no events of interest were found>\n\n'); return; }
    for (const sn of list.nodes) {
      this.out.printf(`${sn.hits}  `);
      if (sn.str[0] === '-' || /\d/.test(sn.str[0])) {
        const uid = parseInt(sn.str, 10);
        this.safe(this.tmUid(uid >>> 0), true);
      } else this.safe(sn.str, true);
    }
  }

  private doIntSummary(list: IntList): void {
    if (list.count === 0) { this.out.printf('<no events of interest were found>\n\n'); return; }
    for (const n of list.nodes) this.out.printf(`${n.hits}  ${n.num}\n`);
  }

  private doTypeSummary(list: IntList): void {
    if (list.count === 0) { this.out.printf('<no events of interest were found>\n\n'); return; }
    for (const n of list.nodes) {
      if (!this.opts.interpret) this.out.printf(`${n.hits}  ${n.num}\n`);
      else this.out.printf(`${n.hits}  ${this.typeName(n.num)}\n`);
    }
  }

  private processEvent(e: AuditEvent): void {
    if (this.scan(e)) {
      if (this.perEventProcessing(e)) this.found = true;
    }
  }

  private processText(text: string, filename: string, lastFile: boolean): void {
    let first: AuditEvent['e'] | null = null;
    let last: AuditEvent['e'] | null = null;
    const type = this.opts.reportType;
    const summaryish = type === 'unset' || type === 'time' || type === 'summary';
    for (const e of readEvents(this.assembler, text, lastFile)) {
      if (summaryish) {
        first ??= { ...e.e };
        last = { ...e.e };
      }
      const { startTime, endTime } = this.time;
      if (startTime === 0 || e.e.sec >= startTime) {
        if (endTime === 0 || e.e.sec <= endTime) this.processEvent(e);
      }
    }
    if (last) { this.veryLastSec = last.sec; this.veryLastMilli = last.milli; }
    if (type === 'time') {
      if (first === null || last === null) this.out.printf(`${filename}: no records\n`);
      else {
        this.out.printf(`${filename}: ${formatDateTime(this.host, first.sec)}.${String(first.milli).padStart(3, '0')} - `);
        this.out.printf(`${formatDateTime(this.host, last.sec)}.${String(last.milli).padStart(3, '0')}\n`);
      }
    }
  }

  run(args: string[], stdin: string | null): number {
    const rc0 = this.checkParams(args);
    if (rc0) return 1;
    const config = this.host.auditConfig();
    if (!config) this.out.eprintf("Config file /etc/audit/auditd.conf doesn't exist, skipping\n");
    const logFile = config?.logFile ?? '/var/log/audit/audit.log';
    const eoe = this.opts.eoeTimeout || config?.eoeTimeout || 2;
    this.assembler = new AuditEventAssembler(this.time, eoe);
    this.printTitle();

    const { userFile } = this.opts;
    let rc = 0;
    if (userFile !== null) {
      if (this.host.isDirectory(userFile)) {
        let dir = userFile;
        if (!dir.endsWith('/')) dir += '/';
        this.out.eprintf(`NOTE - using logs in ${dir}audit.log\n`);
        rc = this.processLogs(`${dir}audit.log`);
      } else {
        const text = this.host.readFile(userFile);
        if (text === null) {
          this.out.eprintf('stat: No such file or directory\n');
          return 1;
        }
        this.processText(text, userFile, true);
      }
    } else if (!this.opts.forceLogs && stdin !== null) {
      this.processText(stdin, 'stdin', true);
    } else {
      rc = this.processLogs(logFile);
    }
    if (rc) return rc;
    if (!this.found && this.opts.detail === 'detailed' && this.opts.reportType !== 'time') {
      this.out.printf('<no events of interest were found>\n\n');
      return 1;
    }
    this.printWrapUp();
    return 0;
  }

  private processLogs(base: string): number {
    let num = 0;
    let name = base;
    for (;;) {
      if (this.host.readFile(name) === null) break;
      num++;
      name = `${base}.${num}`;
    }
    num--;
    let remaining = num;
    let current = num > 0 ? `${base}.${num}` : base;
    for (;;) {
      const text = this.host.readFile(current);
      if (text === null) {
        this.out.eprintf(`Error opening ${current} (No such file or directory)\n`);
        return 1;
      }
      this.processText(text, current, remaining === 0);
      remaining--;
      num--;
      if (num > 0) current = `${base}.${num}`;
      else if (num === 0) current = base;
      else break;
    }
    return 0;
  }
}

function machineTable(arch: number): Readonly<Record<number, string>> | null {
  switch (arch >>> 0) {
    case 0xc000003e: return SYSCALL_TABLES.x86_64;
    case 0xc00000b7: return SYSCALL_TABLES.aarch64;
    case 0x40000003: return SYSCALL_TABLES.i386;
    default: return null;
  }
}

export function runAureport(host: AuditToolHost, args: string[], stdin: string | null = null): ToolResult {
  const out = new ToolOutput();
  const tool = new Aureport(host, out);
  let exitCode: number;
  try {
    exitCode = tool.run(args, stdin);
  } catch (error) {
    if (error instanceof ExitSignal) exitCode = error.code;
    else throw error;
  }
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}
