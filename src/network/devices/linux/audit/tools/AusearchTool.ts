import { AUDIT_RANGES } from './AuditMessageTypes';
import { AUDIT } from './AuditConstants';
import { AuditEventAssembler, messageTypeToName, nameToMessageType, readEvents } from './AuditEventAssembler';
import {
  S_FAILED, S_SUCCESS, S_UNSET, defaultSearchFlags, extractSearchItems,
  type AuditEvent, type SearchFlags,
} from './AuditSearchParser';
import { AuditTimeArgs, lookupTime } from './AuditTimeArgs';
import { ExitSignal, ToolOutput, type AuditSearchHost, type ToolResult } from './AuditToolHost';
import { SYSCALL_TABLES } from './AuditSyscallTables';
import { auditNameToErrno } from './AuditErrnoTable';
import { isDigit, strtoul, strtollNumber, strtoulUint32, toUint32 } from './AuditCString';
import { safePrintString, type EscapeMode } from './AuditPrint';
import { formatCtime } from './AuditCtime';
import { adjustType, Interpreter, MACH, elfToMachine } from './AuditInterpret';
import { formatDateTime } from './AuditToolHost';

export const AUSEARCH_VERSION = 'ausearch version 3.1.2';

type ReportFormat = 'raw' | 'default' | 'interpret' | 'csv' | 'text';
type Machine = 'x86' | 'x86_64' | 'aarch64';

const MACHINE_BY_NAME: Readonly<Record<string, Machine>> = {
  i386: 'x86', i486: 'x86', i586: 'x86', i686: 'x86', x86_64: 'x86_64', aarch64: 'aarch64', armv8l: 'aarch64',
};
const MACHINE_ELF: Readonly<Record<Machine, number>> = { x86: 0x40000003, x86_64: 0xc000003e, aarch64: 0xc00000b7 };
const MACHINE_TABLE: Readonly<Record<Machine, Readonly<Record<number, string>>>> = {
  x86: SYSCALL_TABLES.i386, x86_64: SYSCALL_TABLES.x86_64, aarch64: SYSCALL_TABLES.aarch64,
};
const MACHINE_ID: Readonly<Record<Machine, number>> = { x86: 0, x86_64: 1, aarch64: 2 };
const DETECTED_MACHINE: Machine = 'x86_64';
const MAX_EVENT_DELTA_SECS = 2;
const UINT_MAX = 0xffffffff;

const OPTION_TABLE: Readonly<Record<string, string>> = {
  '-a': 'event', '--arch': 'arch', '--event': 'event', '-c': 'comm', '--comm': 'comm', '--checkpoint': 'checkpoint',
  '--debug': 'debug', '-e': 'exit', '--eoe-timeout': 'eoe', '--escape': 'escape', '--exit': 'exit',
  '--extra-keys': 'extrakeys', '--extra-labels': 'extralabels', '--extra-obj2': 'extraobj2', '--extra-time': 'extratime',
  '-f': 'filename', '--file': 'filename', '--format': 'format', '-ga': 'allgid', '--gid-all': 'allgid',
  '-ge': 'effgid', '--gid-effective': 'effgid', '-gi': 'gid', '--gid': 'gid', '-h': 'help', '--help': 'help',
  '-hn': 'host', '--host': 'host', '-i': 'interp', '--interpret': 'interp', '-if': 'infile', '--input': 'infile',
  '--input-logs': 'inlogs', '--just-one': 'justone', '-k': 'key', '--key': 'key', '-l': 'linebuffered',
  '--line-buffered': 'linebuffered', '-m': 'message', '--message': 'message', '-n': 'node', '--node': 'node',
  '-o': 'object', '--object': 'object', '-p': 'pid', '--pid': 'pid', '-pp': 'ppid', '--ppid': 'ppid', '-r': 'raw',
  '--raw': 'raw', '-sc': 'syscall', '--syscall': 'syscall', '-se': 'context', '--context': 'context',
  '--session': 'session', '-su': 'subject', '--subject': 'subject', '-sv': 'success', '--success': 'success',
  '-te': 'timeend', '--end': 'timeend', '-ts': 'timestart', '--start': 'timestart', '-tm': 'terminal',
  '--terminal': 'terminal', '-ua': 'alluid', '--uid-all': 'alluid', '-ue': 'effuid', '--uid-effective': 'effuid',
  '-ui': 'uid', '--uid': 'uid', '-uu': 'uuid', '--uuid': 'uuid', '-ul': 'loginuid', '--loginuid': 'loginuid',
  '-v': 'version', '--version': 'version', '-vm': 'vmname', '--vm-name': 'vmname', '-w': 'word', '--word': 'word',
  '-x': 'executable', '--executable': 'executable',
};

const USAGE = [
  'usage: ausearch [options]',
  '\t-a,--event <Audit event id>\tsearch based on audit event id',
  '\t--arch <CPU>\t\t\tsearch based on the CPU architecture',
  '\t-c,--comm  <Comm name>\t\tsearch based on command line name',
  '\t--checkpoint <checkpoint file>\tsearch from last complete event',
  '\t--debug\t\t\tWrite malformed events that are skipped to stderr',
  '\t-e,--exit  <Exit code or errno>\tsearch based on syscall exit code',
  '\t-escape <option>\t\tescape output',
  '\t--eoe-timeout secs\t\tEnd of Event timeout',
  '\t--extra-keys\t\t\tadd a final column with key information',
  '\t--extra-labels\t\t\tadd columns of information about subject and object labels',
  '\t--extra-obj2\t\t\tadd columns of information about a second object',
  '\t--extra-time\t\t\tadd columns of information about broken down time',
  '\t-f,--file  <File name>\t\tsearch based on file name',
  '\t--format [raw|default|interpret|csv|text] results format options',
  '\t-ga,--gid-all <all Group id>\tsearch based on All group ids',
  '\t-ge,--gid-effective <effective Group id>  search based on Effective\n\t\t\t\t\tgroup id',
  '\t-gi,--gid <Group Id>\t\tsearch based on group id',
  '\t-h,--help\t\t\thelp',
  '\t-hn,--host <Host Name>\t\tsearch based on remote host name',
  '\t-i,--interpret\t\t\tInterpret results to be human readable',
  '\t-if,--input <Input File name>\tuse this file instead of current logs',
  '\t--input-logs\t\t\tUse the logs even if stdin is a pipe',
  '\t--just-one\t\t\tEmit just one event',
  '\t-k,--key  <key string>\t\tsearch based on key field',
  '\t-l, --line-buffered\t\tFlush output on every line',
  '\t-m,--message  <Message type>\tsearch based on message type',
  "\t-n,--node  <Node name>\t\tsearch based on machine's name",
  '\t-o,--object  <SE Linux Object context> search based on context of object',
  '\t-p,--pid  <Process id>\t\tsearch based on process id',
  '\t-pp,--ppid <Parent Process id>\tsearch based on parent process id',
  '\t-r,--raw\t\t\toutput is completely unformatted',
  '\t-sc,--syscall <SysCall name>\tsearch based on syscall name or number',
  '\t-se,--context <SE Linux context> search based on either subject or\n\t\t\t\t\t object',
  '\t--session <login session id>\tsearch based on login session id',
  '\t-su,--subject <SE Linux context> search based on context of the Subject',
  '\t-sv,--success <Success Value>\tsearch based on syscall or event\n\t\t\t\t\tsuccess value',
  '\t-te,--end [end date] [end time]\tending date & time for search',
  '\t-ts,--start [start date] [start time]\tstarting date & time for search',
  '\t-tm,--terminal <TerMinal>\tsearch based on terminal',
  '\t-ua,--uid-all <all User id>\tsearch based on All user id\'s',
  '\t-ue,--uid-effective <effective User id>  search based on Effective\n\t\t\t\t\tuser id',
  '\t-ui,--uid <User Id>\t\tsearch based on user id',
  "\t-ul,--loginuid <login id>\tsearch based on the User's Login id",
  '\t-uu,--uuid <guest UUID>\t\tsearch for events related to the virtual\n\t\t\t\t\tmachine with the given UUID.',
  '\t-v,--version\t\t\tversion',
  '\t-vm,--vm-name <guest name>\tsearch for events related to the virtual\n\t\t\t\t\tmachine with the name.',
  '\t-w,--word\t\t\tstring matches are whole word',
  '\t-x,--executable <executable name>  search based on executable name',
  '',
].join('\n');

interface Checkpoint {
  dev: number;
  inode: number;
  event: { sec: number; milli: number; serial: number; node: string | null; type: number };
}

class Ausearch {
  private readonly time: AuditTimeArgs;
  private format: ReportFormat = 'default';
  private userFile: string | null = null;
  private forceLogs = false;
  private checkpointFile: string | null = null;
  private checkpointTimeOnly = 0;
  private eventId = UINT_MAX;
  private eventGid = UINT_MAX;
  private eventEgid = UINT_MAX;
  private eventTypes: number[] | null = null;
  private eventPid = -1;
  private eventPpid = -1;
  private eventSuccess = S_UNSET;
  private escapeMode: EscapeMode = 'tty';
  private exactMatch = false;
  private eventUid = UINT_MAX;
  private eventEuid = UINT_MAX;
  private eventLoginuid = UINT_MAX - 1;
  private eventTuid: string | null = null;
  private eventTeuid: string | null = null;
  private eventTauid: string | null = null;
  private eventSyscall = -1;
  private eventMachine: Machine | null = null;
  private eventUa = false;
  private eventGa = false;
  private eventSe = false;
  private justOne = false;
  private eventSessionId = UINT_MAX - 1;
  private eventExit = 0;
  private eventExitIsSet = false;
  private lineBuffered = false;
  private eventDebug = false;
  private eventKey: string | null = null;
  private eventFilename: string | null = null;
  private eventExe: string | null = null;
  private eventComm: string | null = null;
  private eventHostname: string | null = null;
  private eventTerminal: string | null = null;
  private eventSubject: string | null = null;
  private eventObject: string | null = null;
  private eventUuid: string | null = null;
  private eventVmname: string | null = null;
  private argEoeTimeout = 0;
  private eventNodes: string[] | null = null;
  private extraKeys = false;
  private extraLabels = false;
  private extraObj2 = false;
  private extraTime = false;

  private found = false;
  private filesToProcess = 0;
  private checkpointFailure = 0;
  private haveCheckpointData = false;
  private checkpointInput: Checkpoint = { dev: 0, inode: 0, event: { sec: 0, milli: 0, serial: 0, node: null, type: 0 } };
  private lastEvent = { sec: 0, milli: 0, serial: 0, node: null as string | null, type: 0 };
  private checkpointDevInode = { dev: 0, ino: 0 };
  private canOutput = false;
  private assembler!: AuditEventAssembler;
  private flags: SearchFlags = defaultSearchFlags();

  constructor(private readonly host: AuditSearchHost, private readonly out: ToolOutput) {
    this.time = new AuditTimeArgs(host, out);
  }

  private fail(message: string): number {
    this.out.eprintf(message);
    return -1;
  }

  private convertStrToMsg(arg: string): number {
    let tmp: number;
    if (isDigit(arg[0])) tmp = strtoul(arg);
    else {
      tmp = nameToMessageType(arg);
      if (tmp < 0) return -1;
    }
    (this.eventTypes ??= []).push(tmp);
    return 0;
  }

  private parseMsg(arg: string): number {
    if (arg.includes(',')) {
      for (const piece of arg.split(',').filter((p) => p !== '')) {
        const rc = this.convertStrToMsg(piece);
        if (rc !== 0) return rc;
      }
      return 0;
    }
    return this.convertStrToMsg(arg);
  }

  private resolveId(arg: string, lookup: (name: string) => number | null, label: string, apply: (id: number, byName: boolean) => void): number {
    if (isDigit(arg[0])) {
      apply(toUint32(strtoul(arg)), false);
      return 0;
    }
    const id = lookup(arg);
    if (id === null) return this.fail(`${label} is non-numeric and unknown (${arg})\n`);
    apply(id, true);
    return 0;
  }

  checkParams(args: string[]): number {
    const vars = ['ausearch', ...args];
    const count = vars.length;
    let c = 1;
    let retval = 0;
    if (count < 2) {
      this.out.printf(USAGE);
      return -1;
    }
    while (c < count && retval === 0) {
      let optarg: string | null = null;
      if (c + 1 < count) optarg = vars[c + 1][0] !== '-' ? vars[c + 1] : null;
      const need = (): boolean => {
        if (optarg !== null) return true;
        this.out.eprintf(`Argument is required for ${vars[c]}\n`);
        retval = -1;
        return false;
      };
      const noArg = (): void => {
        if (optarg !== null) {
          this.out.eprintf(`Argument is NOT required for ${vars[c]}\n`);
          retval = -1;
        }
      };
      switch (OPTION_TABLE[vars[c]] ?? '') {
        case 'event':
          if (!need()) break;
          if (isDigit(optarg![0])) {
            this.eventId = toUint32(strtoul(optarg!));
            c++;
          } else {
            this.out.eprintf(`Audit event id must be a numeric value, was ${optarg}\n`);
            retval = -1;
          }
          break;
        case 'eoe':
          if (!need()) break;
          if (isDigit(optarg![0])) {
            this.argEoeTimeout = strtoul(optarg!);
            if (this.argEoeTimeout === 0) {
              this.out.eprintf(`Illegal value for End of Event Timeout, was ${optarg}\n`);
              retval = -1;
            }
            c++;
          } else {
            this.out.eprintf(`End of Event Timeout must be a numeric value, was ${optarg}\n`);
            retval = -1;
          }
          break;
        case 'extrakeys': this.extraKeys = true; noArg(); break;
        case 'extralabels': this.extraLabels = true; noArg(); break;
        case 'extraobj2': this.extraObj2 = true; noArg(); break;
        case 'extratime': this.extraTime = true; noArg(); break;
        case 'comm': if (need()) { this.eventComm = optarg; c++; } break;
        case 'filename':
          if (!need()) break;
          if (optarg!.length >= 4096) {
            this.out.eprintf(`File name is too long ${optarg}\n`);
            retval = -1;
            break;
          }
          this.eventFilename = optarg;
          c++;
          break;
        case 'key': if (need()) { this.eventKey = optarg; c++; } break;
        case 'allgid':
          if (!need()) break;
          retval = this.resolveId(optarg!, (n) => this.host.groupGid(n), 'Group ID', (id) => { this.eventGid = id; });
          if (retval !== 0) break;
          this.eventEgid = this.eventGid;
          this.eventGa = true;
          c++;
          break;
        case 'effgid':
          if (!need()) break;
          retval = this.resolveId(optarg!, (n) => this.host.groupGid(n), 'Effective group ID', (id) => { this.eventEgid = id; });
          if (retval === 0) c++;
          break;
        case 'gid':
          if (!need()) break;
          retval = this.resolveId(optarg!, (n) => this.host.groupGid(n), 'Group ID', (id) => { this.eventGid = id; });
          if (retval === 0) c++;
          break;
        case 'help':
          this.out.printf(USAGE);
          throw new ExitSignal(0);
        case 'host': if (need()) { this.eventHostname = optarg; c++; } break;
        case 'interp':
          if (this.format === 'default') this.format = 'interpret';
          else {
            this.out.eprintf(`Conflicting output format ${vars[c]}\n`);
            retval = -1;
          }
          noArg();
          break;
        case 'infile':
          if (!need()) break;
          if (optarg!.length >= 4096 - 32) {
            this.out.eprintf(`File name is too longs ${optarg}\n`);
            retval = -1;
            break;
          }
          this.userFile = optarg;
          c++;
          break;
        case 'message':
          if (optarg === null) {
            this.out.eprintf(`Argument is required for ${vars[c]}\n`);
            retval = -1;
          } else {
            if (optarg.toUpperCase() !== 'ALL') retval = this.parseMsg(optarg);
            c++;
          }
          if (retval < 0) {
            const names: string[] = [];
            for (let i: number = AUDIT.USER; i <= AUDIT_RANGES.AUDIT_LAST_VIRT_MSG; i++) {
              if (i === 1007) i = AUDIT_RANGES.AUDIT_FIRST_USER_MSG;
              const name = messageTypeToName(i);
              if (name) names.push(name);
            }
            this.out.eprintf(`Valid message types are: ALL ${names.map((n) => `${n} `).join('')}\n`);
          }
          break;
        case 'object': if (need()) { this.eventObject = optarg; c++; } break;
        case 'ppid':
          if (!need()) break;
          if (isDigit(optarg![0])) {
            this.eventPpid = strtoul(optarg!) | 0;
            c++;
          } else {
            this.out.eprintf(`Parent process id must be a numeric value, was ${optarg}\n`);
            retval = -1;
          }
          break;
        case 'pid':
          if (!need()) break;
          if (isDigit(optarg![0])) {
            this.eventPid = strtoul(optarg!) | 0;
            c++;
          } else {
            this.out.eprintf(`Process id must be a numeric value, was ${optarg}\n`);
            retval = -1;
          }
          break;
        case 'raw':
          if (this.format === 'default') this.format = 'raw';
          else {
            this.out.eprintf('Conflicting output format --raw\n');
            retval = -1;
          }
          if (optarg !== null) {
            this.out.eprintf('Argument is NOT required for --raw\n');
            retval = -1;
          }
          break;
        case 'escape':
          if (!need()) break;
          if (optarg === 'raw') this.escapeMode = 'raw';
          else if (optarg === 'tty') this.escapeMode = 'tty';
          else if (optarg === 'shell') this.escapeMode = 'shell';
          else if (optarg === 'shell_quote') this.escapeMode = 'shell_quote';
          else {
            this.out.eprintf(`Unknown option (${optarg})\n`);
            retval = -1;
            break;
          }
          c++;
          break;
        case 'format':
          if (this.format !== 'default') {
            this.out.eprintf('Multiple output formats, use only 1\n');
            retval = -1;
            break;
          }
          if (!need()) break;
          if (optarg === 'raw') this.format = 'raw';
          else if (optarg === 'default') this.format = 'default';
          else if (optarg!.startsWith('interp')) this.format = 'interpret';
          else if (optarg === 'csv' || optarg === 'text') {
            this.out.eprintf(`The ${optarg} format needs the auparse event normalizer, which is not built yet\n`);
            retval = -1;
            break;
          }
          else {
            this.out.eprintf(`Unknown option (${optarg})\n`);
            retval = -1;
            break;
          }
          c++;
          break;
        case 'node':
          if (!need()) break;
          c++;
          (this.eventNodes ??= []).push(optarg!);
          break;
        case 'syscall':
          if (!need()) break;
          if (isDigit(optarg![0])) this.eventSyscall = strtoul(optarg!) | 0;
          else {
            this.eventMachine ??= DETECTED_MACHINE;
            this.eventSyscall = this.nameToSyscall(optarg!, this.eventMachine);
            if (this.eventSyscall === -1) {
              this.out.eprintf(`Syscall ${optarg} not found\n`);
              retval = -1;
            }
          }
          c++;
          break;
        case 'context':
          if (!need()) break;
          this.eventSubject = optarg;
          this.eventObject = optarg;
          this.eventSe = true;
          c++;
          break;
        case 'subject': if (need()) { this.eventSubject = optarg; c++; } break;
        case 'success':
          if (!need()) break;
          if (optarg!.includes('yes') || optarg!.includes('no')) this.eventSuccess = optarg === 'yes' ? S_SUCCESS : S_FAILED;
          else {
            this.out.eprintf("Success must be 'yes' or 'no'.\n");
            retval = -1;
          }
          c++;
          break;
        case 'session': {
          if (optarg === null) {
            if (c + 1 < count && vars[c + 1] !== undefined) optarg = vars[c + 1];
            else {
              this.out.eprintf(`Argument is required for ${vars[c]}\n`);
              retval = -1;
              break;
            }
          }
          if (isDigit(optarg[0]) || (optarg.length >= 2 && optarg[0] === '-' && isDigit(optarg[1]))) {
            this.eventSessionId = strtoulUint32(optarg);
            c++;
          } else {
            this.out.eprintf(`Session id must be a numeric value, was ${optarg}\n`);
            retval = -1;
          }
          break;
        }
        case 'exit': {
          if (optarg === null) {
            if (c + 1 < count && vars[c + 1] !== undefined) optarg = vars[c + 1];
            else {
              this.out.eprintf(`Argument is required for ${vars[c]}\n`);
              retval = -1;
              break;
            }
          }
          if (isDigit(optarg[0]) || (optarg.length >= 2 && optarg[0] === '-' && isDigit(optarg[1]))) {
            this.eventExit = strtollNumber(optarg);
          } else {
            this.eventExit = auditNameToErrno(optarg);
            if (this.eventExit === 0) {
              retval = -1;
              this.out.eprintf(`Unknown errno, was ${optarg}\n`);
            }
          }
          c++;
          if (retval !== -1) this.eventExitIsSet = true;
          break;
        }
        case 'timeend':
          retval = this.timeOption(vars, c, optarg, true);
          if (optarg !== null) {
            if (c + 2 < count && vars[c + 2] !== undefined && vars[c + 2][0] !== '-') c++;
            c++;
          }
          break;
        case 'timestart':
          retval = this.timeOption(vars, c, optarg, false);
          if (optarg !== null) {
            if (c + 2 < count && vars[c + 2] !== undefined && vars[c + 2][0] !== '-') c++;
            c++;
          }
          break;
        case 'terminal': if (need()) { this.eventTerminal = optarg; c++; } break;
        case 'uid':
          if (!need()) break;
          retval = this.resolveId(optarg!, (n) => this.host.userUid(n), 'Effective user ID', (id, byName) => {
            this.eventUid = id;
            if (byName) this.eventTuid = optarg;
          });
          if (retval === 0) c++;
          break;
        case 'effuid':
          if (!need()) break;
          retval = this.resolveId(optarg!, (n) => this.host.userUid(n), 'User ID', (id, byName) => {
            this.eventEuid = id;
            if (byName) this.eventTeuid = optarg;
          });
          if (retval === 0) c++;
          break;
        case 'alluid':
          if (!need()) break;
          retval = this.resolveId(optarg!, (n) => this.host.userUid(n), 'User ID', (id, byName) => {
            this.eventUid = id;
            if (byName) {
              this.eventTuid = optarg;
              this.eventTeuid = optarg;
              this.eventTauid = optarg;
            }
          });
          if (retval !== 0) break;
          this.eventUa = true;
          this.eventEuid = this.eventUid;
          this.eventLoginuid = this.eventUid;
          c++;
          break;
        case 'loginuid': {
          if (optarg === null) {
            if (c + 1 < count && vars[c + 1] !== undefined) optarg = vars[c + 1];
            else {
              this.out.eprintf(`Argument is required for ${vars[c]}\n`);
              retval = -1;
              break;
            }
          }
          if (isDigit(optarg[0]) || (optarg.length >= 2 && optarg[0] === '-' && isDigit(optarg[1]))) {
            this.eventLoginuid = strtoulUint32(optarg);
          } else {
            const uid = this.host.userUid(optarg);
            if (uid === null) {
              this.out.eprintf(`Login user ID is non-numeric and unknown (${optarg})\n`);
              retval = -1;
              break;
            }
            this.eventLoginuid = uid;
            this.eventTauid = optarg;
          }
          c++;
          break;
        }
        case 'uuid': if (need()) { this.eventUuid = optarg; c++; } break;
        case 'vmname': if (need()) { this.eventVmname = optarg; c++; } break;
        case 'version':
          this.out.printf(`${AUSEARCH_VERSION}\n`);
          throw new ExitSignal(0);
        case 'word': this.exactMatch = true; break;
        case 'inlogs': this.forceLogs = true; break;
        case 'justone': this.justOne = true; break;
        case 'executable': if (need()) { this.eventExe = optarg; c++; } break;
        case 'linebuffered': this.lineBuffered = true; break;
        case 'debug': this.eventDebug = true; break;
        case 'checkpoint': if (need()) { this.checkpointFile = optarg; c++; } break;
        case 'arch':
          if (!need()) break;
          if (this.eventMachine !== null) {
            this.out.eprintf(this.eventSyscall !== -1 ? 'Arch needs to be defined before the syscall\n' : 'Arch is already defined\n');
            retval = -1;
            break;
          }
          {
            const machine = this.determineMachine(optarg!);
            if (machine === null) {
              this.out.eprintf(`Unknown arch ${optarg}\n`);
              retval = -1;
            } else this.eventMachine = machine;
          }
          c++;
          break;
        default:
          this.out.eprintf(`${vars[c]} is an unsupported option\n`);
          retval = -1;
          break;
      }
      c++;
    }
    if ((this.extraTime || this.extraLabels || this.extraKeys) && this.format !== 'csv') {
      this.out.eprintf('--extra options requires format to be csv\n');
      retval = -1;
    }
    return retval;
  }

  private timeOption(vars: string[], c: number, optarg: string | null, end: boolean): number {
    const count = vars.length;
    if (optarg === null) {
      this.out.eprintf(`${vars[c]} requires either date and/or time\n`);
      return -1;
    }
    const set = (da: string | null, ti: string | null): number => (end ? this.time.end(da, ti) : this.time.start(da, ti)) !== 0 ? -1 : 0;
    if (c + 2 < count && vars[c + 2] !== undefined && vars[c + 2][0] !== '-') {
      if (optarg.includes(':')) return set(vars[c + 2], optarg);
      return set(optarg, vars[c + 2]);
    }
    if (lookupTime(optarg) !== null) return set(optarg, '00:00:00');
    if (!end && optarg === 'checkpoint') {
      this.checkpointTimeOnly++;
      return 0;
    }
    if (!optarg.includes(':')) return set(optarg, end ? null : '00:00:00');
    return set(null, optarg);
  }

  private nameToSyscall(name: string, machine: Machine): number {
    const table = MACHINE_TABLE[machine];
    for (const [num, n] of Object.entries(table)) if (n === name) return Number(num);
    return -1;
  }

  private determineMachine(arch: string): Machine | null {
    const lower = arch.toLowerCase();
    if (lower === 'b64') return DETECTED_MACHINE;
    if (lower === 'b32') return 'x86';
    const named = MACHINE_BY_NAME[arch];
    if (named) return named;
    const elf = strtoul(arch, 16);
    for (const machine of Object.keys(MACHINE_ELF) as Machine[]) if (MACHINE_ELF[machine] === elf) return machine;
    return null;
  }

  private machineOfElf(arch: number): Machine | null {
    for (const machine of Object.keys(MACHINE_ELF) as Machine[]) if (MACHINE_ELF[machine] === arch >>> 0) return machine;
    return null;
  }

  private strmatch(needle: string, haystack: string): boolean {
    return this.exactMatch ? haystack === needle : haystack.includes(needle);
  }

  private userMatch(e: AuditEvent): boolean {
    const s = e.s;
    if (this.eventUa && this.eventTuid) {
      if (s.tuid && this.eventTuid === s.tuid) return true;
      if (s.teuid && this.eventTeuid === s.teuid) return true;
      if (s.tauid && this.eventTauid === s.tauid) return true;
      return false;
    }
    if (this.eventUa) {
      return this.eventUid === s.uid || this.eventEuid === s.euid || this.eventLoginuid === s.loginuid;
    }
    if (this.eventTuid || this.eventTeuid || this.eventTauid) {
      if (this.eventTuid && (s.tuid === null || this.eventTuid !== s.tuid)) return false;
      if (this.eventTeuid && (s.teuid === null || this.eventTeuid !== s.teuid)) return false;
      if (this.eventTauid && (s.tauid === null || this.eventTauid !== s.tauid)) return false;
      return true;
    }
    if (this.eventUid !== UINT_MAX && this.eventUid !== s.uid) return false;
    if (this.eventEuid !== UINT_MAX && this.eventEuid !== s.euid) return false;
    if (this.eventLoginuid !== UINT_MAX - 1 && this.eventLoginuid !== s.loginuid) return false;
    return true;
  }

  private groupMatch(e: AuditEvent): boolean {
    const s = e.s;
    if (this.eventGa) return this.eventGid === s.gid || this.eventEgid === s.egid;
    if (this.eventGid !== UINT_MAX && this.eventGid !== s.gid) return false;
    if (this.eventEgid !== UINT_MAX && this.eventEgid !== s.egid) return false;
    return true;
  }

  private contextMatch(e: AuditEvent): boolean {
    const avc = e.s.avc ?? [];
    const subjects = avc.filter((n) => n.scontext !== null);
    const objects = avc.filter((n) => n.tcontext !== null);
    if (this.eventSe) {
      if (this.eventSubject && subjects.some((n) => this.strmatch(this.eventSubject!, n.scontext!))) return true;
      if (this.eventObject && objects.some((n) => this.strmatch(this.eventObject!, n.tcontext!))) return true;
      return false;
    }
    if (this.eventSubject) {
      if (e.s.avc === null) return false;
      if (!subjects.some((n) => this.strmatch(this.eventSubject!, n.scontext!))) return false;
    }
    if (this.eventObject) {
      if (e.s.avc === null) return false;
      if (!objects.some((n) => this.strmatch(this.eventObject!, n.tcontext!))) return false;
    }
    return true;
  }

  private match(e: AuditEvent): boolean {
    const { startTime, endTime } = this.time;
    if (!(startTime === 0 || e.e.sec >= startTime)) return false;
    if (!(endTime === 0 || e.e.sec <= endTime)) return false;
    if (!(this.eventId === UINT_MAX || this.eventId === e.e.serial)) return false;
    if (extractSearchItems(e, { flags: this.flags, userName: (uid) => this.host.userName(uid), debug: this.eventDebug ? (m) => this.out.eprintf(m) : undefined }) !== 0) return false;
    const s = e.s;
    if (this.eventNodes) {
      if (e.e.node === null) return false;
      if (!this.eventNodes.includes(e.e.node)) return false;
    }
    if (!this.userMatch(e)) return false;
    if (!this.groupMatch(e)) return false;
    if (this.eventPpid !== -1 && this.eventPpid !== s.ppid) return false;
    if (this.eventPid !== -1 && this.eventPid !== s.pid) return false;
    if (this.eventMachine !== null && this.eventMachine !== this.machineOfElf(s.arch)) return false;
    if (this.eventSyscall !== -1 && this.eventSyscall !== s.syscall) return false;
    if (this.eventSessionId !== UINT_MAX - 1 && this.eventSessionId !== s.sessionId) return false;
    if (this.eventExitIsSet) {
      if (!s.exitIsSet) return false;
      if (this.eventExit !== s.exit) return false;
    }
    if (this.eventSuccess !== S_UNSET && this.eventSuccess !== s.success) return false;
    if (this.eventTypes !== null) {
      const types = this.eventTypes;
      if (!e.records.some((n) => types.includes(n.type))) return false;
    }
    if (this.eventFilename) {
      if (s.filename === null && s.cwd === null) return false;
      let found = false;
      if (s.filename) {
        for (const sn of s.filename.nodes) {
          if (this.strmatch(this.eventFilename, sn.str)) { found = true; break; }
        }
        if (!found && s.cwd === null) return false;
      }
      if (s.cwd && !found && !this.strmatch(this.eventFilename, s.cwd)) return false;
    }
    if (this.eventHostname) {
      if (s.hostname === null || !this.strmatch(this.eventHostname, s.hostname)) return false;
    }
    if (this.eventTerminal) {
      if (s.terminal === null || !this.strmatch(this.eventTerminal, s.terminal)) return false;
    }
    if (this.eventExe) {
      if (s.exe === null || !this.strmatch(this.eventExe, s.exe)) return false;
    }
    if (this.eventComm) {
      if (s.comm === null || !this.strmatch(this.eventComm, s.comm)) return false;
    }
    if (this.eventKey) {
      if (s.key === null) return false;
      if (!s.key.nodes.some((sn) => this.strmatch(this.eventKey!, sn.str))) return false;
    }
    if (this.eventVmname) {
      if (s.vmname === null || !this.strmatch(this.eventVmname, s.vmname)) return false;
    }
    if (this.eventUuid) {
      if (s.uuid === null || !this.strmatch(this.eventUuid, s.uuid)) return false;
    }
    return this.contextMatch(e);
  }

  private outputRaw(e: AuditEvent): void {
    for (const n of e.records) this.out.printf(`${n.message}\n`);
  }

  private outputDefault(e: AuditEvent): void {
    const last = e.records[e.records.length - 1];
    this.out.printf(`----\ntime->${formatCtime(this.host.localTime(e.e.sec))}`);
    if (!last) {
      this.out.eprintf('Error - no elements in record.');
      return;
    }
    if (last.type >= AUDIT.DAEMON_START && last.type < AUDIT.SYSCALL) this.out.printf(`${last.message}\n`);
    else {
      for (let i = e.records.length - 1; i >= 0; i--) this.out.printf(safePrintString(e.records[i].message, true, this.escapeMode));
    }
  }

  private outputEvent(e: AuditEvent): void {
    switch (this.format) {
      case 'raw': this.outputRaw(e); break;
      case 'default': this.outputDefault(e); break;
      case 'interpret': this.outputInterpreted(e); break;
      default: this.outputDefault(e); break;
    }
  }

  private machine = -1;
  private curSyscall = -1;
  private a0 = 0n;
  private a1 = 0n;
  private interpreter!: Interpreter;

  private outputInterpreted(e: AuditEvent): void {
    const last = e.records[e.records.length - 1];
    this.out.printf('----\n');
    if (!last) {
      this.out.eprintf('Error - no elements in record.');
      return;
    }
    if (last.type >= AUDIT.DAEMON_START && last.type < AUDIT.SYSCALL) this.outputInterpretedRecord(last, e.e);
    else for (let i = e.records.length - 1; i >= 0; i--) this.outputInterpretedRecord(e.records[i], e.e);
  }

  private outputInterpretedRecord(n: AuditEvent['records'][number], e: AuditEvent['e']): void {
    this.machine = -1;
    this.curSyscall = -1;
    let line = n.message;
    if (e.node !== null) {
      const space = line.indexOf(' ');
      if (space >= 0) line = line.slice(space + 1);
    }
    const open = line.indexOf('(');
    if (open < 0) {
      this.out.eprintf("can't find time stamp\n");
      return;
    }
    const head = line.slice(0, open);
    const afterOpen = line.slice(open + 1);
    const name = n.type >= 0 ? messageTypeToName(n.type) : null;
    if (e.node !== null) this.out.printf(`node=${e.node} `);
    this.out.printf(name !== null ? `type=${name} msg=audit(` : `${head}(`);
    const close = afterOpen.indexOf(')');
    if (close < 0) return;
    let s: string | null = afterOpen.slice(close + 1);
    this.out.printf(formatDateTime(this.host, e.sec));
    this.out.printf(`.${String(e.milli).padStart(3, '0')}:${e.serial}) `);
    if (n.type === AUDIT.SYSCALL) {
      this.a0 = n.a0;
      this.a1 = n.a1;
    }
    let found = false;
    let comma = false;
    let eq = 0;
    while (s !== null && s.length > 0 && (eq = s.indexOf('=')) >= 0) {
      comma = false;
      found = true;
      let nameAt = eq;
      while (s[nameAt] !== ' ' && nameAt > 0) nameAt--;
      this.out.printf(`${s.slice(0, eq)}=`);
      let fieldName = s.slice(nameAt, eq);
      const rest = s.slice(eq + 1);
      if (fieldName === 'msg') {
        s = rest;
        continue;
      }
      if (fieldName[0] === "'") fieldName = fieldName.slice(1);
      let value: string;
      if (rest[0] === "'" || rest[0] === '"') {
        const end = rest.indexOf(rest[0], 1);
        if (end >= 0) {
          value = rest.slice(0, end + 1);
          s = rest.slice(end + 2);
        } else {
          value = rest;
          s = null;
        }
      } else {
        const commaAt = rest.indexOf(',');
        const spaceAt = rest.indexOf(' ');
        if (commaAt >= 0 && spaceAt >= 0 && commaAt < spaceAt) {
          if (adjustType(n.type, fieldName, rest.slice(spaceAt)) === 'MAC_LABEL') {
            value = rest.slice(0, spaceAt);
            s = rest.slice(spaceAt + 1);
          } else {
            value = rest.slice(0, commaAt);
            s = rest.slice(commaAt + 1);
            comma = true;
          }
        } else if (commaAt >= 0 && spaceAt < 0) {
          if (adjustType(n.type, fieldName, rest) === 'MAC_LABEL') {
            value = rest;
            s = null;
          } else {
            value = rest.slice(0, commaAt);
            s = rest.slice(commaAt + 1);
            comma = true;
          }
        } else if (spaceAt >= 0) {
          value = rest.slice(0, spaceAt);
          s = rest.slice(spaceAt + 1);
        } else {
          value = rest;
          s = null;
        }
      }
      this.reportInterpret(fieldName, value, comma, n.type);
    }
    if (!found && s !== null && eq < 0) this.out.printf(safePrintString(s, true, this.escapeMode));
    else if (comma && s !== null) this.out.printf(safePrintString(s, true, this.escapeMode));
    this.out.printf('\n');
  }

  private reportInterpret(nameIn: string, valIn: string, comma: boolean, rtype: number): void {
    let name = nameIn;
    let val = valIn;
    while (name[0] === ' ' || name[0] === '(') name = name.slice(1);
    if (name === 'acct' && val.endsWith(':')) val = val.slice(0, -1);
    const type = adjustType(rtype, name, val);
    if (rtype === AUDIT.SYSCALL || rtype === 1326 || rtype === AUDIT.URINGOP) {
      if (rtype === AUDIT.URINGOP) this.machine = MACH.IO_URING;
      else if (this.machine === -1) this.machine = MACH.X86_64;
      if (name === 'arch') this.machine = elfToMachine(strtoul(val, 16));
      if (this.curSyscall < 0 && (name === 'syscall' || name === 'uring_op')) this.curSyscall = strtoul(val, 10) | 0;
    }
    const syscall = rtype === AUDIT.SYSCALL || rtype === 1326 || rtype === AUDIT.URINGOP ? this.curSyscall : 0;
    const out = this.interpreter.doInterpretation(type, { machine: this.machine, syscall, a0: this.a0, a1: this.a1, cwd: null, name, val }, this.escapeMode);
    if (type === 'UNCLASSIFIED') this.out.printf(`${val}${comma ? ',' : ' '}`);
    else if (name === 'key') {
      const text = out ?? '(null)';
      const keys = text.split(String.fromCharCode(1));
      if (keys.length === 1) this.out.printf(`${text} `);
      else this.out.printf(`${keys[0]}${keys.slice(1).map((k) => ` key=${k}`).join('')} `);
    } else if (type === 'TTY_DATA') this.out.printf(out ?? '(null)');
    else this.out.printf(`${out ?? '(null)'} `);
  }

  private checkpointDecision(ev: AuditEvent['e']): number {
    if (this.canOutput) return 1;
    if (!this.haveCheckpointData) {
      this.canOutput = true;
      return 1;
    }
    const input = this.checkpointInput.event;
    if (input.sec === 0) {
      this.canOutput = true;
      return 1;
    }
    if (this.checkpointTimeOnly) {
      if (input.sec < ev.sec || (input.sec === ev.sec && input.milli <= ev.milli)) {
        this.canOutput = true;
        return 1;
      }
    }
    if (input.sec === ev.sec && input.milli === ev.milli && input.serial === ev.serial && input.type === ev.type) {
      if (input.node === null && ev.node === null) {
        this.canOutput = true;
        return 2;
      }
      if (input.node !== null && ev.node !== null && input.node === ev.node) {
        this.canOutput = true;
        return 2;
      }
    }
    if (input.sec < ev.sec && ev.sec - input.sec > MAX_EVENT_DELTA_SECS) return 3;
    return 0;
  }

  private processText(text: string, lastFile: boolean): number {
    for (const event of readEvents(this.assembler, text, lastFile && !this.checkpointFile)) {
      if (this.match(event)) {
        let doOutput = 1;
        if (this.checkpointFile) doOutput = this.checkpointDecision(event.e);
        if (doOutput === 1) {
          this.found = true;
          this.outputEvent(event);
        } else if (doOutput === 3) {
          this.out.eprintf(
            `Corrupted checkpoint file. Inode match, but newer complete event (${event.e.sec}.${String(event.e.milli).padStart(3, '0')}:${event.e.serial}) found before loaded checkpoint ${this.checkpointInput.event.sec}.${String(this.checkpointInput.event.milli).padStart(3, '0')}:${this.checkpointInput.event.serial}\n`,
          );
          this.checkpointFailure |= 2;
          return 10;
        }
        if (this.justOne) return 0;
      }
      if (this.checkpointFile) {
        this.lastEvent = { sec: event.e.sec, milli: event.e.milli, serial: event.e.serial, node: event.e.node, type: event.e.type };
      }
    }
    return 0;
  }

  private processFile(filename: string, lastFile: boolean): number {
    const text = this.host.readFile(filename);
    if (text === null) {
      this.out.eprintf(`Error opening ${filename} (No such file or directory)\n`);
      return 1;
    }
    return this.processText(text, lastFile);
  }

  private loadCheckpoint(path: string): number {
    const text = this.host.readFile(path);
    if (text === null) return -1;
    let failed = false;
    const input = this.checkpointInput;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      if (line.startsWith('dev=')) input.dev = strtoul(line.slice(4), 16);
      else if (line.startsWith('inode=')) input.inode = strtoul(line.slice(6));
      else if (line.startsWith('output=')) {
        const rest = line.slice(7);
        const space = rest.indexOf(' ');
        if (space < 0) {
          this.out.eprintf(`Malformed output/event checkpoint line near node - [${line}]\n`);
          failed = true;
          break;
        }
        const node = rest.slice(0, space);
        const match = /^(\d+)\.(\d+):(\d+) 0x([0-9a-fA-F]+)/.exec(rest.slice(space + 1));
        if (!match) {
          this.out.eprintf(`Malformed output/event checkpoint line after node - [${line}]\n`);
          failed = true;
          break;
        }
        input.event = {
          node: node[0] === '-' ? null : node, sec: Number(match[1]), milli: Number(match[2]),
          serial: Number(match[3]), type: parseInt(match[4], 16),
        };
      } else {
        this.out.eprintf(`Unknown checkpoint line - [${line}]\n`);
        failed = true;
        break;
      }
    }
    if (!failed && (input.inode === 0 || input.dev === 0)) {
      this.out.eprintf(`Missing dev/inode lines from checkpoint file ${path}\n`);
      failed = true;
    }
    if (failed) {
      this.checkpointFailure |= 1;
      return -3;
    }
    return 0;
  }

  private saveCheckpoint(path: string): void {
    const e = this.lastEvent;
    const body = `dev=0x${this.checkpointDevInode.dev.toString(16).toUpperCase()}\ninode=${this.checkpointDevInode.ino}\n`
      + `output=${e.node ?? '-'} ${e.sec}.${String(e.milli).padStart(3, '0')}:${e.serial} 0x${e.type.toString(16).toUpperCase()}\n`;
    if (!this.host.writeFile(path, body)) {
      this.out.eprintf(`Cannot open checkpoint file - ${path}: Permission denied\n`);
      this.checkpointFailure |= 4;
    }
  }

  private setCheckpointFileDetails(path: string): number {
    const stat = this.host.deviceAndInode(path);
    if (stat === null) {
      this.out.eprintf(`Cannot stat audit file for checkpoint details - ${path}: No such file or directory\n`);
      this.checkpointFailure |= 8;
      return 1;
    }
    this.checkpointDevInode = stat;
    return 0;
  }

  private processLogs(logBase: string): number {
    let filename = logBase;
    let num = 0;
    let foundCheckpointFile = -1;
    for (;;) {
      if (this.host.readFile(filename) === null) break;
      if (this.checkpointFile && this.haveCheckpointData) {
        const stat = this.host.deviceAndInode(filename);
        if (stat === null) {
          this.out.eprintf(`Error stat'ing ${filename} (No such file or directory)\n`);
          return 1;
        }
        if (stat.dev === this.checkpointInput.dev && stat.ino === this.checkpointInput.inode && !this.checkpointTimeOnly) {
          foundCheckpointFile = num++;
          break;
        }
      }
      num++;
      filename = `${logBase}.${num}`;
    }
    if (this.checkpointFile && this.haveCheckpointData && foundCheckpointFile === -1 && !this.checkpointTimeOnly) return 10;
    num--;
    this.filesToProcess = num;
    filename = num > 0 ? `${logBase}.${num}` : logBase;
    for (;;) {
      const ret = this.processFile(filename, this.filesToProcess === 0);
      if (ret) return ret;
      if (this.justOne && this.found) break;
      this.filesToProcess--;
      num--;
      if (num > 0) filename = `${logBase}.${num}`;
      else if (num === 0) filename = logBase;
      else break;
    }
    let ret = 0;
    if (this.checkpointFile) ret = this.setCheckpointFileDetails(filename);
    return ret;
  }

  private buildFlags(): void {
    const f = defaultSearchFlags();
    f.eventPid = this.eventPid;
    f.eventPpid = this.eventPpid;
    f.eventUid = this.eventUid === UINT_MAX ? -1 : this.eventUid;
    f.eventEuid = this.eventEuid === UINT_MAX ? -1 : this.eventEuid;
    f.eventLoginuid = this.eventLoginuid === UINT_MAX - 1 ? -2 : this.eventLoginuid;
    f.eventGid = this.eventGid === UINT_MAX ? -1 : this.eventGid;
    f.eventEgid = this.eventEgid === UINT_MAX ? -1 : this.eventEgid;
    f.eventTuid = this.eventTuid;
    f.eventTeuid = this.eventTeuid;
    f.eventTauid = this.eventTauid;
    f.eventKey = this.eventKey;
    f.eventFilename = this.eventFilename;
    f.eventExe = this.eventExe;
    f.eventComm = this.eventComm;
    f.eventHostname = this.eventHostname;
    f.eventTerminal = this.eventTerminal;
    f.eventSubject = this.eventSubject;
    f.eventObject = this.eventObject;
    f.eventUuid = this.eventUuid;
    f.eventVmname = this.eventVmname;
    f.eventSuccess = this.eventSuccess;
    f.eventSessionId = this.eventSessionId === UINT_MAX - 1 ? -2 : this.eventSessionId;
    f.eventExitIsSet = this.eventExitIsSet;
    f.eventMachine = this.eventMachine === null ? -1 : MACHINE_ID[this.eventMachine];
    f.reportDefault = this.format === 'raw' || this.format === 'default';
    this.flags = f;
  }

  run(args: string[], stdin: string | null): number {
    if (this.checkParams(args)) return 1;
    this.buildFlags();
    const config = this.host.auditConfig();
    if (!config) this.out.eprintf("Config file /etc/audit/auditd.conf doesn't exist, skipping\n");
    const logFile = config?.logFile ?? '/var/log/audit/audit.log';
    const eoe = this.argEoeTimeout || config?.eoeTimeout || 2;
    this.assembler = new AuditEventAssembler(this.time, eoe);
    this.interpreter = new Interpreter(this.host);

    if (this.checkpointFile) {
      const rc = this.loadCheckpoint(this.checkpointFile);
      if (rc < -1) return 10;
      this.haveCheckpointData = rc === 0;
    }

    let rc: number;
    if (this.userFile !== null) {
      if (this.host.isDirectory(this.userFile)) {
        let dir = this.userFile;
        if (!dir.endsWith('/')) dir += '/';
        this.out.eprintf(`NOTE - using logs in ${dir}audit.log\n`);
        rc = this.processLogs(`${dir}audit.log`);
      } else {
        if (this.host.readFile(this.userFile) === null) {
          this.out.eprintf('stat: No such file or directory\n');
          return 1;
        }
        rc = this.processFile(this.userFile, true);
        if (this.checkpointFile) this.setCheckpointFileDetails(this.userFile);
      }
    } else if (!this.forceLogs && stdin !== null) {
      rc = this.processText(stdin, true);
      if (this.checkpointFile) this.out.eprintf('Warning - checkpointing stdin is not supported');
      return rc || this.finish(rc);
    } else rc = this.processLogs(logFile);

    if (this.checkpointFile) {
      if (!this.checkpointFailure && rc === 0) this.saveCheckpoint(this.checkpointFile);
      if (this.checkpointFailure) rc = (this.checkpointFailure & 2) === 2 ? 12 : 11;
    }
    return this.finish(rc);
  }

  private finish(rc: number): number {
    if (rc) return rc;
    if (!this.found) {
      if (this.format !== 'raw') this.out.eprintf('<no matches>\n');
      return 1;
    }
    return 0;
  }
}

export function runAusearch(host: AuditSearchHost, args: string[], stdin: string | null = null): ToolResult {
  const out = new ToolOutput();
  const tool = new Ausearch(host, out);
  let exitCode: number;
  try {
    exitCode = tool.run(args, stdin);
  } catch (error) {
    if (error instanceof ExitSignal) exitCode = error.code;
    else throw error;
  }
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}
