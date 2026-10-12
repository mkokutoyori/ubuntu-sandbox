import { K } from './AuditKernelConstants';
import {
  CString, EAU, MACH, RuleBuildState, RuleData, actionToName, carriesString, addWatchDir, determineMachine, elfToMachine, errnoToName,
  flagToName, fieldToName, fstypeToName, machineToElf, machineToName, msgTypeToName, nameToFlag, nameToSyscall, numberToErrmsg,
  operatorToSymbol, ruleFieldPair, ruleInterfieldCompare, ruleSyscallByName, ruleUringByName, syscallToName, uringOpToName,
  updateWatchPerms, type LibEnv,
} from './AuditctlLib';
import {
  AuditKernelState, EAGAIN, EBADF, EEXIST, EINVAL, type AuditFeatures, type AuditStatus, type KernelMessage, type KernelRequest,
} from './AuditKernelState';
import { GnuGetopt, END_OF_OPTIONS, type LongOption } from './GnuGetopt';
import { ExitSignal, ToolOutput, type ToolResult } from './AuditToolHost';
import { Interpreter, adjustType, type InterpretHost } from './AuditInterpret';
import { strtolBig, strtoulBig, toU32 } from './AuditCNumbers';
import { isDigit } from './AuditCString';
import { strerror } from './AuditErrnoMessages';

export const AUDITCTL_VERSION = 'auditctl version 3.1.2';

const LOG_ERR = 3;
const LOG_WARNING = 4;
const LOG_INFO = 6;
const LOG_DEBUG = 7;
const ECONNREFUSED = 111;
const LINE_SIZE = 6144;
const NAME_MAX = 255;
const PATH_MAX = 4096;
const FILTER_MASK = K.AUDIT_FILTER_MASK;
const FILTER_UNSET = K.AUDIT_FILTER_UNSET;
const FILTER_PREPEND = K.AUDIT_FILTER_PREPEND;
const KEY_SEP = String.fromCharCode(K.AUDIT_KEY_SEPARATOR);

export interface AuditctlHost extends InterpretHost {
  isRoot(): boolean;
  lookupUser(name: string): number | null;
  lookupGroup(name: string): number | null;
  fileKind(path: string): 'missing' | 'directory' | 'file' | 'other';
  readFile(path: string): string | null;
  kernel(): AuditKernelState;
  detectMachine(): number;
  signalProcess(pid: number, signal: number): number;
  terminal(): string | null;
  syslog(priority: number, text: string): void;
}

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'loginuid-immutable', hasArg: 0, val: 1 },
  { name: 'backlog_wait_time', hasArg: 1, val: 2 },
  { name: 'reset-lost', hasArg: 0, val: 3 },
  { name: 'reset_backlog_wait_time_actual', hasArg: 0, val: 4 },
  { name: 'signal', hasArg: 1, val: 5 },
];

const USAGE = [
  'usage: auditctl [options]',
  '    -a <l,a>                          Append rule to end of <l>ist with <a>ction',
  '    -A <l,a>                          Add rule at beginning of <l>ist with <a>ction',
  '    -b <backlog>                      Set max number of outstanding audit buffers',
  '                                      allowed Default=64',
  '    -c                                Continue through errors in rules',
  '    -C f=f                            Compare collected fields if available:',
  '                                      Field name, operator(=,!=), field name',
  '    -d <l,a>                          Delete rule from <l>ist with <a>ction',
  '                                      l=task,exit,user,exclude,filesystem',
  '                                      a=never,always',
  '    -D                                Delete all rules and watches',
  '    -e [0..2]                         Set enabled flag',
  '    -f [0..2]                         Set failure flag',
  '                                      0=silent 1=printk 2=panic',
  '    -F f=v                            Build rule: field name, operator(=,!=,<,>,<=,',
  '                                      >=,&,&=) value',
  '    -h                                Help',
  '    -i                                Ignore errors when reading rules from file',
  '    -k <key>                          Set filter key on audit rule',
  '    -l                                List rules',
  '    -m text                           Send a user-space message',
  '    -p [r|w|x|a]                      Set permissions filter on watch',
  '                                      r=read, w=write, x=execute, a=attribute',
  "    -q <mount,subtree>                make subtree part of mount point's dir watches",
  '    -r <rate>                         Set limit in messages/sec (0=none)',
  '    -R <file>                         read rules from file',
  '    -s                                Report status',
  '    -S syscall                        Build rule: syscall name or number',
  '    --signal <signal>                 Send the specified signal to the daemon',
  '    -t                                Trim directory watches',
  '    -v                                Version',
  '    -w <path>                         Insert watch at <path>',
  '    -W <path>                         Remove watch at <path>',
  '    --loginuid-immutable              Make loginuids unchangeable once set',
  '    --backlog_wait_time               Set the kernel backlog_wait_time',
  '    --reset-lost                      Reset the lost record counter',
  '    --reset_backlog_wait_time_actual  Reset the actual backlog wait time counter',
  '',
].join('\n');

const cs = (value: string | null): string => (value === null ? '(null)' : value);
const signed = (value: number): number => value | 0;

interface RuleNode {
  rule: RuleData;
}

export class Auditctl {
  private readonly out: ToolOutput;
  private readonly state = new RuleBuildState();
  private readonly lib: LibEnv;
  private mode: 'stderr' | 'syslog' | 'quiet' = 'quiet';
  private fd = -1;
  private socketOpen = false;
  private queue: KernelMessage[] = [];
  private sequence = 0;
  private errno = 0;
  private add = FILTER_UNSET;
  private del = FILTER_UNSET;
  private action = -1;
  private ignore = false;
  private continueError = 0;
  private exclude = false;
  private multiple = 0;
  private ruleNew = new RuleData();
  private listRequested = false;
  private interpret = false;
  private key = '';
  private keylen = K.AUDIT_MAX_KEY_LEN;
  private printed = false;
  private collected: RuleNode[] = [];
  private optind = 0;
  private interpreter: Interpreter;
  private ruleFileMode = false;

  constructor(private readonly host: AuditctlHost, out: ToolOutput) {
    this.out = out;
    this.interpreter = new Interpreter(host);
    this.lib = {
      stderr: (text) => this.out.eprintf(text),
      message: (priority, text) => this.auditMsg(priority, text.endsWith('\n') ? text : text),
      lookupUser: (name) => host.lookupUser(name),
      lookupGroup: (name) => host.lookupGroup(name),
      features: () => this.features(),
      detectMachine: () => host.detectMachine(),
    };
  }

  private auditMsg(priority: number, text: string): void {
    if (this.mode === 'quiet') return;
    if (priority === LOG_DEBUG) return;
    if (this.mode === 'syslog') {
      this.host.syslog(priority, text);
      return;
    }
    this.out.eprintf(`${text}\n`);
  }

  private auditPriority(xerrno: number): number {
    return xerrno === ECONNREFUSED ? LOG_DEBUG : LOG_WARNING;
  }

  private features(): number {
    return this.host.kernel().status.featureBitmap;
  }

  private open(): number {
    this.socketOpen = true;
    this.queue = [];
    this.fd = 3;
    return this.fd;
  }

  private close(fd: number): void {
    if (fd >= 0) {
      this.socketOpen = false;
      this.queue = [];
    }
  }

  private sendRaw(fd: number, type: number, payload: KernelRequest): number {
    if (fd < 0 || !this.socketOpen) {
      this.errno = EBADF;
      return -this.errno;
    }
    this.sequence = this.sequence + 1;
    const seq = this.sequence;
    this.queue.push(...this.host.kernel().request(type, seq, payload));
    const rc = this.checkAck();
    return rc === 0 ? seq : rc;
  }

  private checkAck(): number {
    const first = this.queue[0];
    if (first === undefined) return -EINVAL;
    if (first.payload.kind === 'ack') {
      this.queue.shift();
      const error = first.payload.error;
      if (error) {
        this.errno = -error;
        return error;
      }
    }
    return 0;
  }

  private getReply(): KernelMessage | number {
    const next = this.queue.shift();
    return next === undefined ? -EAGAIN : next;
  }

  private requestStatus(fd: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_GET, { kind: 'none' });
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending status request (${strerror(-rc)})`);
    return rc;
  }

  private statusRequest(mask: number, patch: Partial<AuditStatus>): KernelRequest {
    return {
      kind: 'status',
      status: {
        mask, enabled: 0, failure: 0, pid: 0, rateLimit: 0, backlogLimit: 0, lost: 0, backlog: 0, featureBitmap: 0,
        backlogWaitTime: 0, backlogWaitTimeActual: 0, ...patch,
      },
    };
  }

  private setEnabled(fd: number, enabled: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_SET, this.statusRequest(K.AUDIT_STATUS_ENABLED, { enabled }));
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending enable request (${strerror(-rc)})`);
    return rc;
  }

  private setFailure(fd: number, failure: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_SET, this.statusRequest(K.AUDIT_STATUS_FAILURE, { failure }));
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending failure mode request (${strerror(-rc)})`);
    return rc;
  }

  private setRateLimit(fd: number, limit: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_SET, this.statusRequest(K.AUDIT_STATUS_RATE_LIMIT, { rateLimit: limit }));
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending rate limit request (${strerror(-rc)})`);
    return rc;
  }

  private setBacklogLimit(fd: number, limit: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_SET, this.statusRequest(K.AUDIT_STATUS_BACKLOG_LIMIT, { backlogLimit: limit }));
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending backlog limit request (${strerror(-rc)})`);
    return rc;
  }

  private setBacklogWaitTime(fd: number, bwt: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_SET, this.statusRequest(K.AUDIT_STATUS_BACKLOG_WAIT_TIME, { backlogWaitTime: bwt }));
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending backlog limit request (${strerror(-rc)})`);
    return rc;
  }

  private resetLost(fd: number): number {
    if ((this.features() & K.AUDIT_FEATURE_BITMAP_LOST_RESET) === 0) return -EAU.FIELDNOSUPPORT;
    const rc = this.sendRaw(fd, K.AUDIT_SET, this.statusRequest(K.AUDIT_STATUS_LOST, {}));
    const result = rc > 0 ? 0 : rc;
    if (result < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending lost reset request (${strerror(-result)})`);
    return result;
  }

  private resetBacklogWaitTimeActual(fd: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_SET, this.statusRequest(K.AUDIT_STATUS_BACKLOG_WAIT_TIME_ACTUAL, {}));
    const result = rc > 0 ? 0 : rc;
    if (result < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending backlog wait time actual reset request (${strerror(-result)})`);
    return result;
  }

  private setFeature(fd: number, feature: number, value: number, lock: number): number {
    const mask = 1 << feature;
    const features: AuditFeatures = { vers: 0, mask, features: value ? mask : 0, lock: lock ? mask : 0 };
    const rc = this.sendRaw(fd, K.AUDIT_SET_FEATURE, { kind: 'features', features });
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error setting feature (${strerror(-rc)})`);
    return rc;
  }

  private requestFeatures(fd: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_GET_FEATURE, { kind: 'features', features: { vers: 0, mask: 0, features: 0, lock: 0 } });
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error getting feature (${strerror(-rc)})`);
    return rc;
  }

  private requestRulesList(fd: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_LIST_RULES, { kind: 'none' });
    if (rc < 0 && rc !== -EINVAL) this.auditMsg(this.auditPriority(this.errno), `Error sending rule list data request (${strerror(-rc)})`);
    return rc;
  }

  private requestSignalInfo(fd: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_SIGNAL_INFO, { kind: 'none' });
    if (rc < 0) this.auditMsg(LOG_WARNING, `Error sending signal_info request (${strerror(-rc)})`);
    return rc;
  }

  private addRuleData(fd: number, rule: RuleData, flags: number, action: number): number {
    rule.flags = flags;
    rule.action = action;
    const rc = this.sendRaw(fd, K.AUDIT_ADD_RULE, { kind: 'rule', rule });
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending add rule data request (${this.errno === EEXIST ? 'Rule exists' : strerror(-rc)})`);
    return rc;
  }

  private deleteRuleData(fd: number, rule: RuleData, flags: number, action: number): number {
    rule.flags = flags;
    rule.action = action;
    const rc = this.sendRaw(fd, K.AUDIT_DEL_RULE, { kind: 'rule', rule });
    if (rc < 0) {
      if (rc === -2) this.auditMsg(LOG_WARNING, 'Error sending delete rule request (No rule matches)');
      else this.auditMsg(this.auditPriority(this.errno), `Error sending delete rule data request (${strerror(-rc)})`);
    }
    return rc;
  }

  private trimSubtrees(fd: number): number {
    const rc = this.sendRaw(fd, K.AUDIT_TRIM, { kind: 'none' });
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending trim subtrees command (${strerror(-rc)})`);
    return rc;
  }

  private makeEquivalent(fd: number, mountPoint: string, subtree: string): number {
    const rc = this.sendRaw(fd, K.AUDIT_MAKE_EQUIV, { kind: 'text', text: `${mountPoint}\u0000${subtree}` });
    if (rc < 0) this.auditMsg(this.auditPriority(this.errno), `Error sending make_equivalent command (${strerror(-rc)})`);
    return rc;
  }

  private logUserMessage(fd: number, message: string): number {
    const text = `${message} exe="/usr/sbin/auditctl" hostname=? addr=? terminal=${this.host.terminal() ?? '?'} res=success`;
    return this.sendRaw(fd, K.AUDIT_USER, { kind: 'text', text });
  }

  private isEnabled(fd: number): number {
    let rc: number;
    if (fd < 0) return 0;
    rc = this.requestStatus(fd);
    if (rc > 0) {
      for (let i = 0; i < 40; i++) {
        const reply = this.getReply();
        if (typeof reply === 'number') {
          rc = reply;
          continue;
        }
        rc = 1;
        if (reply.type === K.NLMSG_DONE || reply.type === K.NLMSG_ERROR) break;
        if (reply.type !== K.AUDIT_GET) continue;
        return reply.payload.kind === 'status' ? reply.payload.status.enabled : -1;
      }
    }
    if (rc === -ECONNREFUSED) return 0;
    if (rc === -1 && !this.host.isRoot()) return 0;
    return -1;
  }

  private lookupFilter(str: string): { filter: number; rc: number } {
    const filter = nameToFlag(str);
    if (filter === K.AUDIT_FILTER_EXCLUDE) this.exclude = true;
    return { filter, rc: filter === -1 ? 2 : 0 };
  }

  private lookupAction(str: string): { action: number; rc: number } {
    if (str === 'always') return { action: K.AUDIT_ALWAYS, rc: 0 };
    if (str === 'never') return { action: K.AUDIT_NEVER, rc: 0 };
    if (str === 'possible') return { action: -1, rc: 1 };
    return { action: -1, rc: 2 };
  }

  private ruleSetup(opt: string, current: { filter: number; action: number }): number {
    if (++this.multiple !== 1) return 3;
    const comma = opt.indexOf(',');
    if (comma < 0 || opt.indexOf(',', comma + 1) >= 0) return 2;
    const first = opt.slice(0, comma);
    const second = opt.slice(comma + 1);
    let act = this.lookupAction(first);
    if (act.rc === 2) {
      const filter = this.lookupFilter(first);
      current.filter = filter.filter;
      if (filter.rc !== 0) return filter.rc;
    } else if (act.rc === 0) current.action = act.action;
    if (current.filter === FILTER_UNSET) {
      const filter = this.lookupFilter(second);
      current.filter = filter.filter;
    } else {
      act = this.lookupAction(second);
      if (act.rc !== 0) return act.rc;
      current.action = act.action;
    }
    if (current.filter === FILTER_UNSET || current.action === -1) return 2;
    return 0;
  }

  private checkPath(path: string): number {
    if (path.length >= PATH_MAX) {
      this.auditMsg(LOG_ERR, 'The path passed for the watch is too big');
      return 1;
    }
    if (path[0] !== '/') {
      this.auditMsg(LOG_ERR, "The path must start with '/'");
      return 1;
    }
    const trimmed = path.replace(/\/+$/, '') || '/';
    const base = trimmed === '/' ? '/' : trimmed.slice(trimmed.lastIndexOf('/') + 1);
    if (new TextEncoder().encode(base).length > NAME_MAX) {
      this.auditMsg(LOG_ERR, 'The base name of the path is too big');
      return 1;
    }
    if (path.includes('..')) this.auditMsg(LOG_WARNING, 'Warning - relative path notation is not supported');
    if (path.includes('*') || path.includes('?')) this.auditMsg(LOG_WARNING, 'Warning - wildcard notation is not supported');
    return 0;
  }

  private setupWatchName(pathIn: string): number {
    let path = pathIn;
    let type: number = K.AUDIT_WATCH;
    if (this.checkPath(path)) return -1;
    let len = path.length;
    if (len > 2 && path[len - 1] === '/') {
      while (path[len - 1] === '/' && len > 1) {
        path = path.slice(0, len - 1);
        len--;
      }
    }
    if (this.host.fileKind(path) === 'directory') type = K.AUDIT_DIR;
    if (!addWatchDir(this.state, this.lib, this.ruleNew, type, path)) return -1;
    return 1;
  }

  private setupPerms(opt: string): number {
    if (opt.length > 4) {
      this.auditMsg(LOG_ERR, `permission ${opt} is too long`);
      return -1;
    }
    let val = 0;
    for (const ch of opt) {
      const lower = ch.toLowerCase();
      if (lower === 'r') val |= K.AUDIT_PERM_READ;
      else if (lower === 'w') val |= K.AUDIT_PERM_WRITE;
      else if (lower === 'x') val |= K.AUDIT_PERM_EXEC;
      else if (lower === 'a') val |= K.AUDIT_PERM_ATTR;
      else {
        this.auditMsg(LOG_ERR, `Permission ${ch} isn't supported`);
        return -1;
      }
    }
    if (updateWatchPerms(this.lib, this.ruleNew, val) === 0) {
      this.state.permAdded = true;
      return 1;
    }
    return -1;
  }

  private checkRuleMismatch(lineno: number, option: string): number {
    const oldElf = this.state.elf;
    switch (this.state.elf >>> 0) {
      case K.AUDIT_ARCH_X86_64 >>> 0: this.state.elf = K.AUDIT_ARCH_I386; break;
      case K.AUDIT_ARCH_PPC64 >>> 0: this.state.elf = K.AUDIT_ARCH_PPC; break;
      case K.AUDIT_ARCH_S390X >>> 0: this.state.elf = K.AUDIT_ARCH_S390; break;
      default: break;
    }
    const tmprule = new RuleData();
    for (const piece of option.split(',').filter((p) => p !== '')) ruleSyscallByName(this.lib, this.state, tmprule, piece);
    let rc = 0;
    for (let i = 0; i < 64; i++) if (tmprule.mask[i] !== this.ruleNew.mask[i]) rc = 1;
    this.state.elf = oldElf;
    if (rc) {
      if (lineno) this.auditMsg(LOG_WARNING, `WARNING - 32/64 bit syscall mismatch in line ${lineno}, you should specify an arch`);
      else this.auditMsg(LOG_WARNING, 'WARNING - 32/64 bit syscall mismatch, you should specify an arch');
    }
    return 0;
  }

  private sendSignal(optarg: string): number {
    let signal = 0;
    const lower = optarg.toLowerCase();
    if (lower === 'term' || lower === 'stop') signal = 15;
    else if (lower === 'hup' || lower === 'reload') signal = 1;
    else if (lower === 'usr1' || lower === 'rotate') signal = 10;
    else if (lower === 'usr2' || lower === 'resume') signal = 12;
    else if (lower === 'cont' || lower === 'state') signal = 18;
    if (signal === 0) {
      this.auditMsg(LOG_ERR, `${optarg} is an unsupported signal`);
      return -1;
    }
    const retval = this.requestStatus(this.fd);
    if (retval === -1) {
      if (this.errno === ECONNREFUSED) this.auditMsg(LOG_INFO, 'The audit system is disabled');
      return -1;
    }
    for (let i = 0; i < 40; i++) {
      const reply = this.getReply();
      if (typeof reply === 'number') continue;
      if (reply.type === K.NLMSG_DONE) break;
      if (reply.type === K.AUDIT_GET && reply.payload.kind === 'status') {
        if (reply.payload.status.pid === 0) {
          this.auditMsg(LOG_INFO, 'Auditd is not running');
          return -2;
        }
        const rc = this.host.signalProcess(reply.payload.status.pid, signal);
        if (rc < 0) {
          this.auditMsg(LOG_WARNING, `Failed sending signal to auditd (${strerror(-rc)})`);
          return -1;
        }
        return -2;
      }
    }
    this.auditMsg(LOG_WARNING, 'Failed sending signal to auditd (timeout)');
    return -1;
  }

  private reportStatus(): number {
    let retval = this.requestStatus(this.fd);
    if (retval === -1) {
      if (this.errno === ECONNREFUSED) this.out.eprintf('The audit system is disabled\n');
      return -1;
    }
    this.getReplies();
    retval = this.requestFeatures(this.fd);
    if (retval === -1) {
      if (this.errno === EINVAL) return -2;
      return -1;
    }
    this.getReplies();
    return -2;
  }

  private parseSyscall(optarg: string): number {
    let retval = 0;
    if (optarg.includes(',')) {
      for (const piece of optarg.split(',').filter((p) => p !== '')) {
        retval = ruleSyscallByName(this.lib, this.state, this.ruleNew, piece);
        if (retval !== 0) {
          if (retval === -1) {
            this.auditMsg(LOG_ERR, `Syscall name unknown: ${piece}`);
            retval = -3;
          }
          break;
        }
      }
      return retval;
    }
    return ruleSyscallByName(this.lib, this.state, this.ruleNew, optarg);
  }

  private parseIoUring(optarg: string): number {
    if (optarg.includes(',')) {
      let retval = 0;
      for (const piece of optarg.split(',').filter((p) => p !== '')) {
        retval = ruleUringByName(this.state, this.ruleNew, piece);
        if (retval !== 0) break;
      }
      return retval;
    }
    return ruleUringByName(this.state, this.ruleNew, optarg);
  }

  private resetVars(): number {
    this.listRequested = false;
    this.state.reset();
    this.add = FILTER_UNSET;
    this.del = FILTER_UNSET;
    this.action = -1;
    this.exclude = false;
    this.multiple = 0;
    this.ruleNew = new RuleData();
    if (this.fd < 0) {
      this.fd = this.open();
      if (this.fd < 0) {
        this.auditMsg(LOG_ERR, 'Cannot open netlink audit socket');
        return 1;
      }
    }
    return 0;
  }

  private keyMatch(rule: RuleData): boolean {
    if (this.key === '') return true;
    let offset = 0;
    for (let i = 0; i < rule.fieldCount; i++) {
      const field = rule.fields[i] & ~K.AUDIT_OPERATORS;
      if (field === K.AUDIT_FILTERKEY) {
        const keyText = rule.bufferText(offset, rule.values[i]);
        if (keyText.includes(this.key)) return true;
      }
      if (carriesString(field)) offset += rule.values[i];
    }
    return false;
  }

  private isWatch(rule: RuleData): boolean {
    let perm = false;
    let all = true;
    for (let i = 0; i < rule.fieldCount; i++) {
      const field = rule.fields[i] & ~K.AUDIT_OPERATORS;
      if (field === K.AUDIT_PERM) perm = true;
      if (field !== K.AUDIT_PERM && field !== K.AUDIT_FILTERKEY && field !== K.AUDIT_DIR && field !== K.AUDIT_WATCH) return false;
    }
    const list = rule.flags & FILTER_MASK;
    if (list !== K.AUDIT_FILTER_USER && list !== K.AUDIT_FILTER_TASK && list !== K.AUDIT_FILTER_EXCLUDE && list !== K.AUDIT_FILTER_FS) {
      for (let i = 0; i < 63; i++) {
        if (rule.mask[i] !== 0xffffffff) {
          all = false;
          break;
        }
      }
    }
    return perm && all;
  }

  private printArch(value: number, op: number): number {
    this.state.elf = value;
    const machine = elfToMachine(value);
    if (machine < 0) {
      this.out.printf(` -F arch${operatorToSymbol(op)}0x${(value >>> 0).toString(16).toUpperCase()}`);
    } else if (!this.interpret) {
      this.out.printf(` -F arch${operatorToSymbol(op)}${(0x80000000 & value) !== 0 ? 'b64' : 'b32'}`);
    } else {
      this.out.printf(` -F arch${operatorToSymbol(op)}${cs(machineToName(machine))}`);
    }
    return machine;
  }

  private printSyscall(rule: RuleData): { count: number; sc: number } {
    let count = 0;
    let sc = 0;
    let all = true;
    let machine = this.host.detectMachine();
    const list = rule.flags & FILTER_MASK;
    if (list === K.AUDIT_FILTER_USER || list === K.AUDIT_FILTER_TASK || list === K.AUDIT_FILTER_EXCLUDE || list === K.AUDIT_FILTER_FS) {
      return { count: 0, sc };
    }
    const uring = list === K.AUDIT_FILTER_URING_EXIT;
    const length = uring ? 37 : 63;
    let i = 0;
    for (; i < length; i++) {
      if (rule.mask[i] !== 0xffffffff) {
        all = false;
        break;
      }
    }
    if (all) {
      this.out.printf(' -S all');
      count = i;
    } else if (uring) {
      for (let n = 0; n < 37; n++) {
        if (rule.mask[n >>> 5] & ((1 << (n & 31)) >>> 0)) {
          const name = uringOpToName(n);
          if (!count) this.out.printf(' -S ');
          this.out.printf(name !== null ? `${count ? ',' : ''}${name}` : `${count ? ',' : ''}${n}`);
          count++;
          sc = n;
        }
      }
    } else {
      for (let n = 0; n < 64 * 32; n++) {
        if (rule.mask[n >>> 5] & ((1 << (n & 31)) >>> 0)) {
          if (this.state.elf) machine = elfToMachine(this.state.elf);
          const name = machine < 0 ? null : syscallToName(n, machine);
          if (!count) this.out.printf(' -S ');
          this.out.printf(name !== null ? `${count ? ',' : ''}${name}` : `${count ? ',' : ''}${n}`);
          count++;
          sc = n;
        }
      }
    }
    return { count, sc };
  }

  private printFieldCompare(value: number, op: number): void {
    for (const [name, constant] of Object.entries(K)) {
      if (!name.startsWith('AUDIT_COMPARE_') || constant !== value) continue;
      const [left, right] = name.slice('AUDIT_COMPARE_'.length).split('_TO_');
      this.out.printf(` -C ${left.toLowerCase()}${operatorToSymbol(op)}${right.toLowerCase()}`);
      return;
    }
  }

  private printRule(rule: RuleData): void {
    let count = 0;
    let sc = 0;
    let boffset = 0;
    let mach = -1;
    let a0 = 0n;
    let a1 = 0n;
    const watch = this.isWatch(rule);
    if (!watch) {
      this.out.printf(`-a ${cs(actionToName(rule.action))},${cs(flagToName(rule.flags))}`);
      for (let i = 0; i < rule.fieldCount; i++) {
        const field = rule.fields[i] & ~K.AUDIT_OPERATORS;
        if (field === K.AUDIT_ARCH) mach = this.printArch(rule.values[i], rule.fieldflags[i] & K.AUDIT_OPERATORS);
      }
      const printed = this.printSyscall(rule);
      count = printed.count;
      sc = printed.sc;
    }
    for (let i = 0; i < rule.fieldCount; i++) {
      const op = rule.fieldflags[i] & K.AUDIT_OPERATORS;
      const field = rule.fields[i] & ~K.AUDIT_OPERATORS;
      if (field === K.AUDIT_ARCH) continue;
      const name = fieldToName(field);
      const symbol = operatorToSymbol(op);
      const value = rule.values[i];
      if (name === null) {
        this.out.printf(` f${signed(rule.fields[i])}${symbol}${signed(value)}`);
        continue;
      }
      if (field === K.AUDIT_MSGTYPE) {
        const typeName = msgTypeToName(value);
        this.out.printf(typeName === null ? ` -F ${name}${symbol}${signed(value)}` : ` -F ${name}${symbol}${typeName}`);
      } else if (field >= K.AUDIT_SUBJ_USER && field <= K.AUDIT_OBJ_LEV_HIGH && field !== K.AUDIT_PPID) {
        this.out.printf(` -F ${name}${symbol}${rule.bufferText(boffset, value)}`);
        boffset += value;
      } else if (field === K.AUDIT_WATCH) {
        this.out.printf(watch ? `-w ${rule.bufferText(boffset, value)}` : ` -F path=${rule.bufferText(boffset, value)}`);
        boffset += value;
      } else if (field === K.AUDIT_DIR) {
        this.out.printf(watch ? `-w ${rule.bufferText(boffset, value)}` : ` -F dir=${rule.bufferText(boffset, value)}`);
        boffset += value;
      } else if (field === K.AUDIT_EXE) {
        this.out.printf(` -F exe=${rule.bufferText(boffset, value)}`);
        boffset += value;
      } else if (field === K.AUDIT_FILTERKEY) {
        const keyText = rule.bufferText(boffset, value);
        boffset += value;
        for (const piece of keyText.split(KEY_SEP).filter((p) => p !== '')) this.out.printf(watch ? ` -k ${piece}` : ` -F key=${piece}`);
      } else if (field === K.AUDIT_PERM) {
        let perms = '';
        if (value & K.AUDIT_PERM_READ) perms += 'r';
        if (value & K.AUDIT_PERM_WRITE) perms += 'w';
        if (value & K.AUDIT_PERM_EXEC) perms += 'x';
        if (value & K.AUDIT_PERM_ATTR) perms += 'a';
        this.out.printf(watch ? ` -p ${perms}` : ` -F perm=${perms}`);
      } else if (field === K.AUDIT_INODE) {
        this.out.printf(` -F ${name}${symbol}${value >>> 0}`);
      } else if (field === K.AUDIT_FIELD_COMPARE) {
        this.printFieldCompare(value, op);
      } else if (field >= K.AUDIT_ARG0 && field <= K.AUDIT_ARG3) {
        if (field === K.AUDIT_ARG0) a0 = BigInt(value);
        else if (field === K.AUDIT_ARG1) a1 = BigInt(value);
        if (count > 1 || !this.interpret) this.out.printf(` -F ${name}${symbol}0x${(value >>> 0).toString(16).toUpperCase()}`);
        else {
          const val = (value >>> 0).toString(16);
          const type = adjustType(K.AUDIT_SYSCALL, name, val);
          const out = this.interpreter.doInterpretation(type, { machine: mach, syscall: sc, a0, a1, cwd: null, name, val }, 'tty');
          this.out.printf(` -F ${name}${symbol}${cs(out)}`);
        }
      } else if (field === K.AUDIT_EXIT) {
        const e = Math.abs(signed(value));
        const err = errnoToName(e);
        this.out.printf(signed(value) < 0 && err !== null ? ` -F ${name}${symbol}-${err}` : ` -F ${name}${symbol}${signed(value)}`);
      } else if (field === K.AUDIT_FSTYPE) {
        const fsName = fstypeToName(value | 0);
        this.out.printf(fsName === null ? ` -F ${name}${symbol}${signed(value)}` : ` -F ${name}${symbol}${fsName}`);
      } else if (field === K.AUDIT_LOGINUID || field === K.AUDIT_SESSIONID) {
        this.out.printf(signed(value) === -1 && this.interpret ? ` -F ${name}${symbol}unset` : ` -F ${name}${symbol}${signed(value)}`);
      } else {
        this.out.printf(` -F ${name}${symbol}${signed(value)}`);
      }
    }
    this.out.printf('\n');
  }

  private getEnable(e: number): string {
    return e === 0 ? 'disable' : e === 1 ? 'enabled' : e === 2 ? 'enabled+immutable' : 'unknown';
  }

  private getFailure(f: number): string {
    return f === 0 ? 'silent' : f === 1 ? 'printk' : f === 2 ? 'panic' : 'unknown';
  }

  private printReply(reply: KernelMessage, fd: number): number {
    this.state.elf = 0;
    switch (reply.type) {
      case K.NLMSG_NOOP:
        return 1;
      case K.NLMSG_DONE:
        this.close(fd);
        if (!this.printed) this.out.printf('No rules\n');
        else {
          for (const node of this.collected) this.printRule(node.rule);
          this.collected = [];
        }
        break;
      case K.NLMSG_ERROR:
        if (reply.payload.kind === 'ack') this.out.printf(`NLMSG_ERROR ${-reply.payload.error} (${strerror(-reply.payload.error)})\n`);
        this.printed = true;
        break;
      case K.AUDIT_GET:
        if (reply.payload.kind === 'status') {
          const s = reply.payload.status;
          if (this.interpret) this.out.printf(`enabled ${this.getEnable(s.enabled)}\nfailure ${this.getFailure(s.failure)}\n`);
          else this.out.printf(`enabled ${s.enabled >>> 0}\nfailure ${s.failure >>> 0}\n`);
          this.out.printf(`pid ${s.pid >>> 0}\nrate_limit ${s.rateLimit >>> 0}\nbacklog_limit ${s.backlogLimit >>> 0}\nlost ${s.lost >>> 0}\nbacklog ${s.backlog >>> 0}\n`);
          this.out.printf(`backlog_wait_time ${s.backlogWaitTime >>> 0}\n`);
          this.out.printf(`backlog_wait_time_actual ${s.backlogWaitTimeActual >>> 0}\n`);
        }
        this.printed = true;
        break;
      case K.AUDIT_GET_FEATURE:
        if (reply.payload.kind === 'features') {
          const f = reply.payload.features;
          const mask = 1 << K.AUDIT_FEATURE_LOGINUID_IMMUTABLE;
          if (f.mask & mask) this.out.printf(`loginuid_immutable ${f.features & mask ? 1 : 0} ${f.lock & mask ? 'locked' : 'unlocked'}\n`);
        }
        this.printed = true;
        break;
      case K.AUDIT_LIST_RULES:
        this.listRequested = false;
        if (reply.payload.kind === 'rule' && this.keyMatch(reply.payload.rule)) this.collected.push({ rule: reply.payload.rule });
        this.printed = true;
        return 1;
      default:
        this.out.printf(`Unknown: type=${reply.type}, len=0\n`);
        this.printed = true;
        break;
    }
    return 0;
  }

  private getReplies(): void {
    this.printed = false;
    this.collected = [];
    for (let guard = 0; guard < 100000; guard++) {
      const reply = this.getReply();
      if (typeof reply === 'number') break;
      if (reply.type === K.NLMSG_ERROR && reply.payload.kind === 'ack' && reply.payload.error === 0) continue;
      if (this.printReply(reply, this.fd) === 0) break;
    }
  }

  private requestRuleList(): number {
    if (this.requestRulesList(this.fd) > 0) {
      this.listRequested = true;
      this.getReplies();
      return 1;
    }
    return 0;
  }

  private deleteAllRules(fd: number): number {
    const seq = this.requestRulesList(fd);
    if (seq <= 0) return -1;
    const found: RuleData[] = [];
    for (let guard = 0; guard < 100000; guard++) {
      const reply = this.getReply();
      if (typeof reply === 'number') break;
      if (reply.seq !== seq) continue;
      if (reply.type === K.NLMSG_DONE) break;
      if (reply.type === K.NLMSG_ERROR && reply.payload.kind === 'ack' && reply.payload.error) {
        this.auditMsg(LOG_ERR, `Error receiving rules list (${strerror(-reply.payload.error)})`);
        return -1;
      }
      if (reply.type !== K.AUDIT_LIST_RULES) continue;
      if (reply.payload.kind === 'rule' && this.keyMatch(reply.payload.rule)) found.push(reply.payload.rule);
    }
    for (const rule of found) {
      const rc = this.sendRaw(fd, K.AUDIT_DEL_RULE, { kind: 'rule', rule });
      if (rc < 0) {
        this.auditMsg(LOG_ERR, `Error deleting rule (${strerror(-rc)})`);
        return -1;
      }
    }
    return 0;
  }

  private setopt(countIn: number, lineno: number, vars: string[]): number {
    let count = countIn;
    let retval = 0;
    this.key = '';
    this.keylen = K.AUDIT_MAX_KEY_LEN;
    const getopt = new GnuGetopt(vars, 'hicslDvtC:e:f:r:b:a:A:d:S:F:m:R:w:W:k:p:q:', LONG_OPTIONS);
    getopt.optind = 0;
    for (;;) {
      if (!(retval >= 0)) break;
      const got = getopt.next();
      if (got.code === END_OF_OPTIONS) break;
      const c = got.code;
      let optarg = got.optarg;
      const optind = (): number => getopt.optind;
      const addFilter = { filter: this.add, action: this.action };
      switch (c) {
        case 104: // h
          this.out.printf(USAGE);
          retval = -1;
          break;
        case 105: // i
          this.ignore = true;
          retval = -2;
          break;
        case 99: // c
          this.ignore = true;
          this.continueError = 1;
          retval = -2;
          break;
        case 115: // s
          if (count > 3) {
            this.auditMsg(LOG_ERR, 'Too many options for status command');
            retval = -1;
            break;
          } else if (optind() === 2 && count === 3) {
            if (vars[optind()] === '-i') {
              this.interpret = true;
              count -= 1;
            } else {
              this.auditMsg(LOG_ERR, 'Only -i option is allowed');
              retval = -1;
              break;
            }
          }
          retval = this.reportStatus();
          break;
        case 101: // e
          if (optarg !== null && (optarg === '0' || optarg === '1' || optarg === '2')) {
            if (this.setEnabled(this.fd, Number(strtoulBig(optarg, 0))) > 0) this.requestStatus(this.fd);
            else retval = -1;
          } else {
            this.auditMsg(LOG_ERR, `Enable must be 0, 1, or 2 was ${cs(optarg)}`);
            retval = -1;
          }
          break;
        case 102: // f
          if (optarg !== null && (optarg === '0' || optarg === '1' || optarg === '2')) {
            if (this.setFailure(this.fd, Number(strtoulBig(optarg, 0))) > 0) this.requestStatus(this.fd);
            else return -1;
          } else {
            this.auditMsg(LOG_ERR, `Failure must be 0, 1, or 2 was ${cs(optarg)}`);
            retval = -1;
          }
          break;
        case 114: // r
          if (optarg !== null && isDigit(optarg[0])) {
            const rate = toU32(strtoulBig(optarg, 0));
            if (this.setRateLimit(this.fd, rate) > 0) this.requestStatus(this.fd);
            else return -1;
          } else {
            this.auditMsg(LOG_ERR, `Rate must be a numeric value was ${cs(optarg)}`);
            retval = -1;
          }
          break;
        case 98: // b
          if (optarg !== null && isDigit(optarg[0])) {
            const limit = toU32(strtoulBig(optarg, 0));
            if (this.setBacklogLimit(this.fd, limit) > 0) this.requestStatus(this.fd);
            else return -1;
          } else {
            this.auditMsg(LOG_ERR, `Backlog must be a numeric value was ${cs(optarg)}`);
            retval = -1;
          }
          break;
        case 108: // l
          if (count > 4) {
            this.auditMsg(LOG_ERR, 'Wrong number of options for list request');
            retval = -1;
            break;
          }
          if (count === 3) {
            if (vars[optind()] === '-i') {
              this.interpret = true;
              count -= 1;
            } else {
              this.auditMsg(LOG_ERR, 'Only -k or -i options are allowed');
              retval = -1;
              break;
            }
          } else if (count === 4) {
            if (vars[optind()] !== undefined && vars[optind()] === '-k') {
              this.key += (vars[3] ?? '').slice(0, this.keylen);
              count -= 2;
            } else {
              this.auditMsg(LOG_ERR, 'Only -k or -i options are allowed');
              retval = -1;
              break;
            }
          }
          if (this.requestRuleList()) {
            this.listRequested = true;
            retval = -2;
          } else retval = -1;
          break;
        case 97: // a
          if (optarg!.includes('task') && this.state.syscallAdded) {
            this.auditMsg(LOG_ERR, 'Syscall auditing requested for task list');
            retval = -1;
          } else {
            addFilter.filter = this.add;
            addFilter.action = this.action;
            const rc = this.ruleSetup(optarg!, addFilter);
            this.add = addFilter.filter;
            this.action = addFilter.action;
            if (rc === 3) {
              this.auditMsg(LOG_ERR, 'Multiple rule insert/delete operations are not allowed\n');
              retval = -1;
            } else if (rc === 2) {
              this.auditMsg(LOG_ERR, `Append rule - bad keyword ${optarg}`);
              retval = -1;
            } else if (rc === 1) {
              this.auditMsg(LOG_ERR, 'Append rule - possible is deprecated');
              return -3;
            } else retval = 1;
          }
          break;
        case 65: // A
          if (optarg!.includes('task') && this.state.syscallAdded) {
            this.auditMsg(LOG_ERR, 'Error: syscall auditing requested for task list');
            retval = -1;
          } else {
            addFilter.filter = this.add;
            addFilter.action = this.action;
            const rc = this.ruleSetup(optarg!, addFilter);
            this.add = addFilter.filter;
            this.action = addFilter.action;
            if (rc === 3) {
              this.auditMsg(LOG_ERR, 'Multiple rule insert/delete operations are not allowed');
              retval = -1;
            } else if (rc === 2) {
              this.auditMsg(LOG_ERR, `Add rule - bad keyword ${optarg}`);
              retval = -1;
            } else if (rc === 1) {
              this.auditMsg(LOG_WARNING, 'Append rule - possible is deprecated');
              return -3;
            } else {
              this.add |= FILTER_PREPEND;
              retval = 1;
            }
          }
          break;
        case 100: { // d
          const delFilter = { filter: this.del, action: this.action };
          const rc = this.ruleSetup(optarg!, delFilter);
          this.del = delFilter.filter;
          this.action = delFilter.action;
          if (rc === 3) {
            this.auditMsg(LOG_ERR, 'Multiple rule insert/delete operations are not allowed');
            retval = -1;
          } else if (rc === 2) {
            this.auditMsg(LOG_ERR, `Delete rule - bad keyword ${optarg}`);
            retval = -1;
          } else if (rc === 1) {
            this.auditMsg(LOG_INFO, 'Delete rule - possible is deprecated');
            return -3;
          } else retval = 1;
          break;
        }
        case 83: { // S
          const unknownArch = !this.state.elf;
          const listBits = (value: number): number => value & (FILTER_MASK | FILTER_UNSET);
          if (listBits(this.add) === K.AUDIT_FILTER_URING_EXIT || listBits(this.del) === K.AUDIT_FILTER_URING_EXIT) {
            const rc = this.parseIoUring(optarg!);
            if (rc === 0) {
              this.state.syscallAdded = true;
              retval = 1;
            } else if (rc === -1) {
              this.auditMsg(LOG_ERR, `io_uring op unknown: ${optarg}`);
              retval = -1;
            }
            break;
          }
          if (listBits(this.add) === K.AUDIT_FILTER_TASK || listBits(this.del) === K.AUDIT_FILTER_TASK) {
            this.auditMsg(LOG_ERR, 'Error: syscall auditing being added to task list');
            return -1;
          } else if (listBits(this.add) === K.AUDIT_FILTER_USER || listBits(this.del) === K.AUDIT_FILTER_USER) {
            this.auditMsg(LOG_ERR, 'Error: syscall auditing being added to user list');
            return -1;
          } else if (listBits(this.add) === K.AUDIT_FILTER_FS || listBits(this.del) === K.AUDIT_FILTER_FS) {
            this.auditMsg(LOG_ERR, 'Error: syscall auditing being added to filesystem list');
            return -1;
          } else if (this.exclude) {
            this.auditMsg(LOG_ERR, 'Error: syscall auditing cannot be put on exclude list');
            return -1;
          } else if (unknownArch) {
            const machine = this.host.detectMachine();
            if (machine < 0) {
              this.auditMsg(LOG_ERR, 'Error detecting machine type');
              return -1;
            }
            const elf = machineToElf(machine);
            if (elf === 0) {
              this.auditMsg(LOG_ERR, `Error looking up elf type ${machine}`);
              return -1;
            }
            this.state.elf = elf;
          }
          const rc = this.parseSyscall(optarg!);
          switch (rc) {
            case 0:
              this.state.syscallAdded = true;
              if (unknownArch && this.add !== FILTER_UNSET) {
                if (this.checkRuleMismatch(lineno, optarg!) === -1) retval = -1;
              }
              break;
            case -1:
              this.auditMsg(LOG_ERR, `Syscall name unknown: ${optarg}`);
              retval = -1;
              break;
            case -2:
              this.auditMsg(LOG_ERR, `Elf type unknown: 0x${(this.state.elf >>> 0).toString(16)}`);
              retval = -1;
              break;
            case -3:
              retval = -1;
              break;
            default:
              break;
          }
          break;
        }
        case 70: { // F
          let flags = FILTER_UNSET;
          if (this.add !== FILTER_UNSET) flags = this.add & FILTER_MASK;
          else if (this.del !== FILTER_UNSET) flags = this.del & FILTER_MASK;
          else if (optind() >= count || !optarg!.includes('arch=') || vars[optind()] !== '-t') {
            this.auditMsg(LOG_ERR, 'List must be given before field');
            retval = -1;
            break;
          }
          if (optarg!.startsWith('key=')) {
            optarg = optarg!.slice(4);
            retval = this.processKeys(optarg, retval);
            break;
          }
          const holder = new CString(optarg!);
          const rc = ruleFieldPair(this.lib, this.state, this.ruleNew, holder, flags);
          if (rc !== 0) {
            numberToErrmsg(this.lib, rc, holder.value);
            retval = -1;
          } else {
            const lastField = this.ruleNew.fields[this.ruleNew.fieldCount - 1];
            if (lastField === K.AUDIT_PERM) this.state.permAdded = true;
            if (lastField === K.AUDIT_EXE) this.state.exeAdded = true;
          }
          break;
        }
        case 67: { // C
          let flags = FILTER_UNSET;
          if (this.add !== FILTER_UNSET) flags = this.add & FILTER_MASK;
          else if (this.del !== FILTER_UNSET) flags = this.del & FILTER_MASK;
          const holder = new CString(optarg!);
          const rc = ruleInterfieldCompare(this.lib, this.ruleNew, holder, flags);
          if (rc !== 0) {
            numberToErrmsg(this.lib, rc, holder.value);
            retval = -1;
          } else if (this.ruleNew.fields[this.ruleNew.fieldCount - 1] === K.AUDIT_PERM) this.state.permAdded = true;
          break;
        }
        case 109: { // m
          if (count > 3) {
            this.auditMsg(LOG_ERR, 'The -m option must be only the only option and takes 1 parameter');
            retval = -1;
          } else {
            for (const ch of optarg!) {
              if (ch.charCodeAt(0) < 32) {
                this.auditMsg(LOG_ERR, 'Illegal character in audit event');
                return -1;
              }
            }
            if (this.logUserMessage(this.fd, `text=${optarg}`) <= 0) retval = -1;
            else return -2;
          }
          break;
        }
        case 82: // R
          this.auditMsg(LOG_ERR, 'Error - nested rule files not supported');
          retval = -1;
          break;
        case 68: // D
          if (count > 4 || count === 3) {
            this.auditMsg(LOG_ERR, 'Wrong number of options for Delete all request');
            retval = -1;
            break;
          }
          if (count === 4) {
            if (vars[optind()] === '-k') {
              this.key += (vars[3] ?? '').slice(0, this.keylen);
              count -= 2;
            } else {
              this.auditMsg(LOG_ERR, 'Only the -k option is allowed');
              retval = -1;
              break;
            }
          }
          retval = this.deleteAllRules(this.fd);
          if (retval === 0) {
            this.requestRuleList();
            this.key = '';
            retval = -2;
          }
          break;
        case 119: // w
          if (this.add !== FILTER_UNSET || this.del !== FILTER_UNSET) {
            this.auditMsg(LOG_ERR, "watch option can't be given with a syscall");
            retval = -1;
          } else if (optarg !== null) {
            this.add = K.AUDIT_FILTER_EXIT;
            this.action = K.AUDIT_ALWAYS;
            this.state.syscallAdded = true;
            retval = this.setupWatchName(optarg);
          } else {
            this.auditMsg(LOG_ERR, 'watch option needs a path');
            retval = -1;
          }
          break;
        case 87: // W
          if (optarg !== null) {
            this.del = K.AUDIT_FILTER_EXIT;
            this.action = K.AUDIT_ALWAYS;
            this.state.syscallAdded = true;
            retval = this.setupWatchName(optarg);
          } else {
            this.auditMsg(LOG_ERR, 'watch option needs a path');
            retval = -1;
          }
          break;
        case 107: // k
          if (!(this.state.syscallAdded || this.state.permAdded || this.state.exeAdded || this.state.filterFsAdded)
            || (this.add === FILTER_UNSET && this.del === FILTER_UNSET)) {
            this.auditMsg(LOG_ERR, 'key option needs a watch or syscall given prior to it');
            retval = -1;
            break;
          } else if (optarg === null) {
            this.auditMsg(LOG_ERR, 'key option needs a value');
            retval = -1;
            break;
          }
          retval = this.processKeys(optarg, retval);
          break;
        case 112: // p
          if (this.add === FILTER_UNSET && this.del === FILTER_UNSET) {
            this.auditMsg(LOG_ERR, 'permission option needs a watch given prior to it');
            retval = -1;
          } else if (optarg === null) {
            this.auditMsg(LOG_ERR, 'permission option needs a filter');
            retval = -1;
          } else retval = this.setupPerms(optarg);
          break;
        case 113: { // q
          if (this.state.syscallAdded) {
            this.auditMsg(LOG_ERR, 'Syscall auditing requested for make equivalent');
            retval = -1;
          } else {
            const comma = optarg!.indexOf(',');
            const parsed = comma >= 0 && comma + 1 < optarg!.length && !optarg!.slice(comma + 1).includes(',');
            if (!parsed) {
              this.auditMsg(LOG_ERR, 'Error parsing equivalent parts');
              retval = -1;
            } else {
              retval = this.makeEquivalent(this.fd, optarg!.slice(0, comma), optarg!.slice(comma + 1));
              if (retval <= 0) retval = -1;
              else return -2;
            }
          }
          break;
        }
        case 116: // t
          retval = this.trimSubtrees(this.fd);
          if (retval <= 0) retval = -1;
          else return -2;
          break;
        case 118: // v
          this.out.printf(`${AUDITCTL_VERSION}\n`);
          retval = -2;
          break;
        case 1:
          retval = this.setFeature(this.fd, K.AUDIT_FEATURE_LOGINUID_IMMUTABLE, 1, 1);
          if (retval <= 0) retval = -1;
          else return -2;
          break;
        case 2:
          if (optarg !== null && isDigit(optarg[0])) {
            const bwt = toU32(strtoulBig(optarg, 0));
            if (this.setBacklogWaitTime(this.fd, bwt) > 0) this.requestStatus(this.fd);
            else return -1;
          } else {
            this.auditMsg(LOG_ERR, `Backlog_wait_time must be a numeric value was ${cs(optarg)}`);
            retval = -1;
          }
          break;
        case 3: {
          const rc = this.resetLost(this.fd);
          if (rc >= 0) {
            this.auditMsg(LOG_INFO, `lost: ${rc}`);
            return -2;
          }
          numberToErrmsg(this.lib, rc, LONG_OPTIONS[got.longIndex].name);
          retval = -1;
          break;
        }
        case 4: {
          const rc = this.resetBacklogWaitTimeActual(this.fd);
          if (rc >= 0) {
            this.auditMsg(LOG_INFO, `backlog_wait_time_actual: ${rc}`);
            return -2;
          }
          numberToErrmsg(this.lib, rc, LONG_OPTIONS[got.longIndex].name);
          retval = -1;
          break;
        }
        case 5:
          retval = this.sendSignal(optarg!);
          break;
        default: {
          const badOpt = optind() >= 2 ? vars[optind() - 1] : ' ';
          if (lineno) this.auditMsg(LOG_ERR, `Option ${badOpt} on line ${lineno} is invalid`);
          else this.auditMsg(LOG_ERR, `Option ${badOpt} is invalid`);
          retval = -1;
          break;
        }
      }
    }
    this.optind = getopt.optind;
    if (getopt.optind === 1) retval = -1;
    else if (getopt.optind < count && retval !== -1) {
      this.auditMsg(LOG_ERR, 'parameter passed without an option given');
      retval = -1;
    }
    if (this.key !== '' && !this.listRequested) {
      let flags = 0;
      if (this.add !== FILTER_UNSET) flags = this.add & FILTER_MASK;
      else if (this.del !== FILTER_UNSET) flags = this.del & FILTER_MASK;
      const holder = new CString(`key=${this.key}`);
      const ret = ruleFieldPair(this.lib, this.state, this.ruleNew, holder, flags);
      if (ret !== 0) {
        numberToErrmsg(this.lib, ret, holder.value);
        retval = -1;
      }
    }
    if (retval === -1 && this.errno === ECONNREFUSED) this.auditMsg(LOG_ERR, 'The audit system is disabled');
    return retval;
  }

  private processKeys(optarg: string, retval: number): number {
    if (optarg.length + this.key.length + (this.key !== '' ? 1 : 0) > K.AUDIT_MAX_KEY_LEN) {
      this.auditMsg(LOG_ERR, 'key option exceeds size limit');
      return -1;
    }
    if (optarg.includes(KEY_SEP)) this.auditMsg(LOG_ERR, `key ${optarg} has illegal character`);
    if (this.key !== '') {
      this.key += KEY_SEP;
      this.keylen--;
    }
    this.key += optarg.slice(0, this.keylen);
    this.keylen = K.AUDIT_MAX_KEY_LEN - this.key.length;
    return retval;
  }

  private isReady(): boolean {
    if (this.isEnabled(this.fd) === 2) {
      this.auditMsg(LOG_ERR, 'The audit system is in immutable mode, no rule changes allowed');
      return false;
    }
    if (this.errno === ECONNREFUSED) {
      this.auditMsg(LOG_ERR, 'The audit system is disabled');
      return false;
    }
    return true;
  }

  private handleRequest(statusIn: number): number {
    let status = statusIn;
    if (status === 0) {
      if (this.state.syscallAdded) {
        this.auditMsg(LOG_ERR, 'Error - no list specified');
        return -1;
      }
      this.getReplies();
    } else if (status === -2) status = 0;
    else if (status > 0) {
      let rc: number;
      if (this.add !== FILTER_UNSET) {
        if ((this.add & FILTER_MASK) !== K.AUDIT_FILTER_TASK && !this.state.syscallAdded) ruleSyscallByName(this.lib, this.state, this.ruleNew, 'all');
        this.mode = 'quiet';
        rc = this.addRuleData(this.fd, this.ruleNew, this.add, this.action);
        this.mode = 'stderr';
        if (rc < 0) {
          if (this.errno === EINVAL && this.ruleNew.fields[0] === K.AUDIT_DIR) {
            this.ruleNew.fields[0] = K.AUDIT_WATCH;
            rc = this.addRuleData(this.fd, this.ruleNew, this.add, this.action);
          } else {
            this.auditMsg(LOG_ERR, `Error sending add rule data request (${this.errno === EEXIST ? 'Rule exists' : strerror(-rc)})`);
          }
        }
      } else if (this.del !== FILTER_UNSET) {
        if ((this.del & FILTER_MASK) !== K.AUDIT_FILTER_TASK && !this.state.syscallAdded) ruleSyscallByName(this.lib, this.state, this.ruleNew, 'all');
        this.mode = 'quiet';
        rc = this.deleteRuleData(this.fd, this.ruleNew, this.del, this.action);
        this.mode = 'stderr';
        if (rc < 0) {
          if (this.errno === EINVAL && this.ruleNew.fields[0] === K.AUDIT_DIR) {
            this.ruleNew.fields[0] = K.AUDIT_WATCH;
            rc = this.deleteRuleData(this.fd, this.ruleNew, this.del, this.action);
          } else {
            this.auditMsg(LOG_ERR, `Error sending delete rule data request (${this.errno === EEXIST ? 'Rule exists' : strerror(-rc)})`);
          }
        }
      } else {
        this.out.printf(USAGE);
        this.close(this.fd);
        throw new ExitSignal(1);
      }
      status = rc <= 0 ? -1 : 0;
    } else status = -1;
    if (!this.listRequested) this.close(this.fd);
    this.fd = -1;
    return status;
  }

  private fileopt(file: string): number {
    const kind = this.host.fileKind(file);
    if (kind === 'missing') {
      this.auditMsg(LOG_ERR, `audit rules file ${file} doesn't exist`);
      return 2;
    }
    if (kind !== 'file') {
      this.auditMsg(LOG_ERR, `Error - ${file} is not a regular file`);
      return 1;
    }
    const text = this.host.readFile(file);
    if (text === null) {
      this.auditMsg(LOG_ERR, `Error opening ${file} (Permission denied)`);
      return 1;
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let lineno = 1;
    for (const rawLine of lines) {
      let buf = rawLine.length >= LINE_SIZE ? rawLine.slice(0, LINE_SIZE - 1) : rawLine;
      let idx = 0;
      while (buf[idx] === ' ') idx++;
      if (idx >= buf.length) {
        lineno++;
        continue;
      }
      buf = this.preprocess(buf);
      const pieces = buf.split(' ').filter((p) => p !== '');
      if (pieces.length === 0) break;
      if (pieces[0][0] === '#') {
        lineno++;
        continue;
      }
      const nf = Math.floor(buf.length / 3) + 3;
      const fields = ['auditctl', pieces[0], ...pieces.slice(1, nf - 2).map((p) => this.postprocess(p))];
      if (this.resetVars()) return -1;
      const rc = this.setopt(fields.length, lineno, fields);
      if (rc !== -3) {
        if (this.handleRequest(rc) === -1) {
          if (this.errno !== ECONNREFUSED) this.auditMsg(LOG_ERR, `There was an error in line ${lineno} of ${file}`);
          else {
            this.auditMsg(LOG_ERR, 'The audit system is disabled');
            return 0;
          }
          if (!this.ignore) return -1;
          if (this.continueError) this.continueError = -1;
        }
      }
      lineno++;
    }
    return 0;
  }

  private preprocess(buf: string): string {
    const chars = [...buf];
    let esc = false;
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === '\\' && !esc) esc = true;
      else if (esc) {
        if (chars[i] === ' ') {
          chars[i] = '\u0007';
          chars[i - 1] = '\u0007';
        } else if (chars[i] === '\\') {
          chars[i] = '\u0004';
          chars[i - 1] = '\u0004';
        }
        esc = false;
      }
    }
    return chars.join('');
  }

  private postprocess(buf: string): string {
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === '\u0007') {
        out += ' ';
        i++;
      } else if (buf[i] === '\u0004') {
        out += '\\';
        i++;
      } else out += buf[i];
    }
    return out;
  }

  run(argv: string[]): number {
    const vars = ['auditctl', ...argv];
    const argc = vars.length;
    this.mode = 'stderr';
    if (argc === 1) {
      this.out.printf(USAGE);
      return 1;
    }
    const helpOrList = argc === 2 && (vars[1] === '--help' || vars[1] === '-h' || (vars[1] === '-l' && this.host.isRoot()));
    if (!helpOrList && !this.host.isRoot()) {
      this.auditMsg(LOG_WARNING, 'You must be root to run this program.');
      return 4;
    }
    let retval: number;
    if (argc === 3 && vars[1] === '-R') {
      this.mode = 'syslog';
      this.ruleFileMode = true;
      this.fd = this.open();
      if (!this.isReady()) return 1;
      if (this.fileopt(vars[2])) return 1;
      return this.continueError < 0 ? 1 : 0;
    }
    if (this.resetVars()) return 1;
    retval = this.setopt(argc, 0, vars);
    if (retval === -3) return 0;
    if (this.add !== FILTER_UNSET || this.del !== FILTER_UNSET) {
      this.fd = this.open();
      if (!this.isReady()) return 1;
    }
    retval = this.handleRequest(retval);
    if (retval === -1) {
      if (this.errno !== ECONNREFUSED) this.auditMsg(LOG_ERR, 'There was an error while processing parameters');
      else {
        this.auditMsg(LOG_ERR, 'The audit system is disabled');
        return 0;
      }
    }
    return retval;
  }
}

export function runAuditctl(host: AuditctlHost, argv: string[]): ToolResult {
  const out = new ToolOutput();
  const tool = new Auditctl(host, out);
  let exitCode: number;
  try {
    exitCode = tool.run(argv) & 0xff;
  } catch (error) {
    if (error instanceof ExitSignal) exitCode = error.code;
    else throw error;
  }
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}
