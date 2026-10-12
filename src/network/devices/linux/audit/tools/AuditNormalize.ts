import { AuparseEvent } from './AuparseEvent';
import { AUDIT_NUMBERS, EVENT_KIND_NAMES, NORM, OBJECT_KIND_NAMES, RECORD_ACTIONS, SYSCALL_OBJECT_KINDS } from './AuditNormalizeTables';

export type NormalizeOption = 'all' | 'no-attrs';

export interface Location {
  record: number;
  field: number;
}

type Loc = Location | null;

const A = AUDIT_NUMBERS;
const ACTION_BY_TYPE = new Map<number, string>(RECORD_ACTIONS);
const NORM_ACCT_MAX_SYS = 1000;
const NORM_ACCT_MAX_USER = 60000;
const S_IFMT = 0o170000;

const inRange = (value: number, low: string, high: string): boolean => value >= A[low] && value <= A[high];
const isOneOf = (value: number, ...names: string[]): boolean => names.some((name) => A[name] === value);

export interface NormalizeHost {
  userUid(name: string): number | null;
}

interface Thing {
  primary: Loc;
  secondary: Loc;
  two: Loc;
  attr: Location[];
  what: number;
}

interface Actor {
  primary: Loc;
  secondary: Loc;
  what: string | null;
  attr: Location[];
}

function determineEventKind(type: number): string {
  let kind: number = NORM.NORM_EVTYPE_UNKNOWN;
  if (inRange(type, 'USER_AUTH', 'USER_ACCT') || inRange(type, 'CRED_ACQ', 'USER_END') || inRange(type, 'USER_CHAUTHTOK', 'CRED_REFR')
    || inRange(type, 'USER_LOGIN', 'USER_LOGOUT') || type === A.LOGIN) kind = NORM.NORM_EVTYPE_USER_LOGIN;
  else if (isOneOf(type, 'GRP_AUTH', 'CHGRP_ID')) kind = NORM.NORM_EVTYPE_GROUP_CHANGE;
  else if (type === A.USER_MGMT || inRange(type, 'ADD_USER', 'DEL_GROUP') || inRange(type, 'GRP_MGMT', 'GRP_CHAUTHTOK')
    || inRange(type, 'ACCT_LOCK', 'ACCT_UNLOCK')) kind = NORM.NORM_EVTYPE_USER_ACCT;
  else if (type === A.KERNEL || inRange(type, 'SYSTEM_BOOT', 'SERVICE_STOP')) kind = NORM.NORM_EVTYPE_SYSTEM_SERVICES;
  else if (isOneOf(type, 'USYS_CONFIG', 'CONFIG_CHANGE', 'NETFILTER_CFG', 'FEATURE_CHANGE', 'TIME_INJOFFSET', 'TIME_ADJNTPVAL', 'USER_DEVICE', 'SOFTWARE_UPDATE')) kind = NORM.NORM_EVTYPE_CONFIG;
  else if (type === A.SECCOMP) kind = NORM.NORM_EVTYPE_DAC_DECISION;
  else if (inRange(type, 'TEST', 'TRUSTED_APP') || isOneOf(type, 'USER_CMD', 'CHUSER_ID')) kind = NORM.NORM_EVTYPE_USERSPACE;
  else if (isOneOf(type, 'USER_TTY', 'TTY')) kind = NORM.NORM_EVTYPE_TTY;
  else if (type === A.EVENT_LISTENER || inRange(type, 'FIRST_DAEMON', 'LAST_DAEMON')) kind = NORM.NORM_EVTYPE_AUDIT_DAEMON;
  else if (isOneOf(type, 'USER_SELINUX_ERR', 'USER_AVC', 'APPARMOR_ERROR') || inRange(type, 'APPARMOR_ALLOWED', 'APPARMOR_DENIED') || inRange(type, 'AVC', 'AVC_PATH')) kind = NORM.NORM_EVTYPE_MAC_DECISION;
  else if (inRange(type, 'INTEGRITY_FIRST_MSG', 'INTEGRITY_LAST_MSG') || type === A.ANOM_RBAC_INTEGRITY_FAIL) kind = NORM.NORM_EVTYPE_INTEGRITY;
  else if (inRange(type, 'FIRST_KERN_ANOM_MSG', 'LAST_KERN_ANOM_MSG') || inRange(type, 'FIRST_ANOM_MSG', 'ANOM_RBAC_FAIL') || inRange(type, 'ANOM_CRYPTO_FAIL', 'LAST_ANOM_MSG')) kind = NORM.NORM_EVTYPE_ANOMALY;
  else if (inRange(type, 'FIRST_ANOM_RESP', 'LAST_ANOM_RESP')) kind = NORM.NORM_EVTYPE_ANOMALY_RESP;
  else if (inRange(type, 'MAC_POLICY_LOAD', 'LAST_SELINUX') || inRange(type, 'AA', 'APPARMOR_AUDIT') || inRange(type, 'APPARMOR_HINT', 'APPARMOR_STATUS')
    || inRange(type, 'FIRST_USER_LSPP_MSG', 'LAST_USER_LSPP_MSG')) kind = NORM.NORM_EVTYPE_MAC;
  else if (inRange(type, 'FIRST_KERN_CRYPTO_MSG', 'LAST_KERN_CRYPTO_MSG') || inRange(type, 'FIRST_CRYPTO_MSG', 'LAST_CRYPTO_MSG')) kind = NORM.NORM_EVTYPE_CRYPTO;
  else if (inRange(type, 'FIRST_VIRT_MSG', 'LAST_VIRT_MSG')) kind = NORM.NORM_EVTYPE_VIRT;
  else if (inRange(type, 'SYSCALL', 'SOCKETCALL') || inRange(type, 'SOCKADDR', 'MQ_GETSETATTR') || inRange(type, 'FD_PAIR', 'OBJ_PID')
    || inRange(type, 'BPRM_FCAPS', 'NETFILTER_PKT') || type === A.URINGOP) kind = NORM.NORM_EVTYPE_AUDIT_RULE;
  else if (type === A.FANOTIFY) kind = NORM.NORM_EVTYPE_AV_DECISION;
  else if (type === A.BPF) kind = NORM.NORM_EVTYPE_BPF;
  return EVENT_KIND_NAMES[kind];
}

export class AuditNormalizer {
  evkind: string | null = null;
  session: Loc = null;
  actor: Actor = { primary: null, secondary: null, what: null, attr: [] };
  action: string | null = null;
  thing: Thing = { primary: null, secondary: null, two: null, attr: [], what: NORM.NORM_WHAT_UNKNOWN };
  results: Loc = null;
  how: string | null = null;
  key: Loc = null;
  private option: NormalizeOption = 'all';
  private syscallSuccess = -1;
  private attrCursor = { actor: 0, thing: 0 };

  constructor(private readonly event: AuparseEvent, private readonly host: NormalizeHost) {}

  private clear(): void {
    this.evkind = null;
    this.session = null;
    this.actor = { primary: null, secondary: null, what: null, attr: [] };
    this.action = null;
    this.thing = { primary: null, secondary: null, two: null, attr: [], what: NORM.NORM_WHAT_UNKNOWN };
    this.results = null;
    this.how = null;
    this.key = null;
    this.syscallSuccess = -1;
    this.attrCursor = { actor: 0, thing: 0 };
  }

  private here(recordNumber: number = this.event.recordNum()): Location {
    return { record: recordNumber, field: this.event.fieldNum() };
  }

  private setUnknownSubjectWhat(): void {
    this.actor.what = 'unknown-acct';
  }

  private setSubjectWhat(): number {
    let uid = 0;
    if (this.event.fieldType() === 'UID') uid = this.event.fieldInt();
    else {
      const name = this.event.fieldName();
      if (name === 'acct') {
        const account = this.event.interpretField();
        const found = account === null ? null : this.host.userUid(account);
        if (found === null) {
          this.setUnknownSubjectWhat();
          return 1;
        }
        uid = found;
      } else {
        this.setUnknownSubjectWhat();
        return 1;
      }
    }
    const unsigned = uid >>> 0;
    if (unsigned === 0) this.actor.what = 'privileged-acct';
    else if (unsigned === 4294967295) this.actor.what = 'unset-acct';
    else if (unsigned < NORM_ACCT_MAX_SYS) this.actor.what = 'service-acct';
    else if (unsigned < NORM_ACCT_MAX_USER) this.actor.what = 'user-acct';
    else this.setUnknownSubjectWhat();
    return 0;
  }

  private setPrimeSubject(name: string, recordNumber: number): number {
    if (this.event.findField(name) !== null) {
      this.actor.primary = { record: recordNumber, field: this.event.fieldNum() };
      return 0;
    }
    return 1;
  }

  private setSecondarySubject(name: string, recordNumber: number): number {
    if (this.event.findField(name) !== null) {
      this.actor.secondary = { record: recordNumber, field: this.event.fieldNum() };
      return this.setSubjectWhat();
    }
    return 1;
  }

  private addSubjectAttribute(name: string, recordNumber: number): number {
    if (this.event.findField(name) !== null) {
      this.actor.attr.push({ record: recordNumber, field: this.event.fieldNum() });
      return 0;
    }
    this.event.gotoRecordNum(recordNumber);
    return 1;
  }

  private setPrimeObject(name: string, recordNumber: number): number {
    if (this.event.findField(name) !== null) {
      this.thing.primary = { record: recordNumber, field: this.event.fieldNum() };
      return 0;
    }
    return 1;
  }

  private setPrimeObject2(name: string, adjust: number): number {
    const recordNumber = 2 + adjust;
    this.event.gotoRecordNum(recordNumber);
    this.event.firstField();
    if (this.event.findField(name) !== null) {
      this.thing.two = { record: recordNumber, field: this.event.fieldNum() };
      return 0;
    }
    return 1;
  }

  private addObjectAttribute(name: string, recordNumber: number): number {
    if (this.event.findField(name) !== null) {
      this.thing.attr.push({ record: recordNumber, field: this.event.fieldNum() });
      return 0;
    }
    this.event.gotoRecordNum(recordNumber);
    return 1;
  }

  private addSession(recordNumber: number): number {
    if (this.event.findField('ses') !== null) {
      this.session = { record: recordNumber, field: this.event.fieldNum() };
      return 0;
    }
    this.event.firstRecord();
    return 1;
  }

  private setResults(recordNumber: number): number {
    if (this.event.findField('res') !== null) {
      this.results = { record: recordNumber, field: this.event.fieldNum() };
      return 0;
    }
    return 1;
  }

  private syscallSubjectAttributes(): void {
    this.event.firstRecord();
    do {
      const recordNumber = this.event.recordNum();
      if (this.event.type() === A.SYSCALL) {
        if (this.option === 'no-attrs') {
          this.addSession(recordNumber);
          return;
        }
        for (const name of ['ppid', 'pid', 'gid', 'euid', 'suid', 'fsuid', 'egid', 'sgid', 'fsgid', 'tty']) this.addSubjectAttribute(name, recordNumber);
        this.addSession(recordNumber);
        this.addSubjectAttribute('subj', recordNumber);
        return;
      }
    } while (this.event.nextRecord() === 1);
  }

  private collectPermObject2(syscall: string): void {
    const name = syscall === 'fchmodat' ? 'a2' : 'a1';
    this.event.firstRecord();
    if (this.event.findField(name) !== null) this.thing.two = { record: 0, field: this.event.fieldNum() };
  }

  private collectOwnObject2(syscall: string): void {
    const name = syscall === 'fchownat' ? 'a2' : 'a1';
    this.event.firstRecord();
    if (this.event.findField(name) !== null) {
      if (this.event.fieldInt() === -1 && this.event.errno === 0) this.event.nextField();
      this.thing.two = { record: 0, field: this.event.fieldNum() };
    }
  }

  private collectIdObject2(syscall: string): void {
    const limits: Record<string, number> = { setuid: 1, setreuid: 2, setresuid: 3, setgid: 1, setregid: 2, setresgid: 3 };
    const limit = limits[syscall];
    if (limit === undefined) return;
    let count = 1;
    this.event.firstRecord();
    if (this.event.findField('a0') !== null) {
      while (count <= limit) {
        const text = this.event.interpretField();
        if (text === 'unset') {
          if (count < limit) {
            if (this.event.nextField() === 0) return;
            count++;
          } else return;
        } else break;
      }
      this.thing.two = { record: 0, field: this.event.fieldNum() };
    }
  }

  private collectPathAttributes(): void {
    const recordNumber = this.event.recordNum();
    this.event.firstField();
    if (this.addObjectAttribute('mode', recordNumber) !== 0) return;
    while (this.event.nextField() === 1) this.thing.attr.push({ record: recordNumber, field: this.event.fieldNum() });
  }

  private simpleFileAttributes(): void {
    if (this.option === 'no-attrs') return;
    let parent = 0;
    this.event.firstRecord();
    do {
      const type = this.event.type();
      if (type === A.PATH) {
        const nametype = this.event.findField('nametype');
        if (nametype !== null && nametype === 'PARENT') {
          if (parent === 0) parent = this.event.recordNum();
          continue;
        }
        this.collectPathAttributes();
        return;
      } else if (type === A.CWD) {
        this.addObjectAttribute('cwd', this.event.recordNum());
      } else if (type === A.SOCKADDR) {
        this.addObjectAttribute('saddr', this.event.recordNum());
      }
    } while (this.event.nextRecord() === 1);
    if (parent !== 0) {
      this.event.gotoRecordNum(parent);
      this.collectPathAttributes();
    }
  }

  private setFileObject(adjust: number): void {
    let parent = 0;
    this.event.gotoRecordNum(2 + adjust);
    this.event.firstField();
    let found: string | null;
    do {
      found = this.event.findField('nametype');
      if (found !== null) {
        if (found !== 'PARENT') break;
        if (parent === 0) parent = this.event.recordNum();
      }
    } while (found !== null && this.event.nextRecord() === 1);
    let recordNumber: number;
    if (found === null) {
      if (parent === 0) return;
      this.event.gotoRecordNum(parent);
      this.event.firstField();
      recordNumber = parent;
    } else recordNumber = this.event.recordNum();
    if (this.event.type() === A.PATH) {
      this.event.firstField();
      this.setPrimeObject('name', recordNumber);
      if (this.event.findField('inode') !== null) this.thing.secondary = { record: recordNumber, field: this.event.fieldNum() };
      const mode = this.event.findField('mode');
      if (mode !== null) {
        const parsed = /^\s*([0-7]+)/.exec(mode);
        const value = parsed === null ? 0 : parseInt(parsed[1], 8);
        const format = value & S_IFMT;
        if (format === 0o100000) this.thing.what = NORM.NORM_WHAT_FILE;
        else if (format === 0o040000) this.thing.what = NORM.NORM_WHAT_DIRECTORY;
        else if (format === 0o020000) this.thing.what = NORM.NORM_WHAT_CHAR_DEV;
        else if (format === 0o060000) this.thing.what = NORM.NORM_WHAT_BLOCK_DEV;
        else if (format === 0o010000) this.thing.what = NORM.NORM_WHAT_FIFO;
        else if (format === 0o120000) this.thing.what = NORM.NORM_WHAT_LINK;
        else if (format === 0o140000) this.thing.what = NORM.NORM_WHAT_SOCKET;
      }
    }
  }

  private setSocketObject(): void {
    this.event.gotoRecordNum(1);
    this.event.firstField();
    this.setPrimeObject('saddr', 1);
  }

  private setProgramObject(): number {
    this.event.firstRecord();
    const type = this.event.type();
    if (type === A.BPF) {
      if (this.event.findField('prog-id') !== null) this.thing.primary = this.here();
    } else if (type === A.EVENT_LISTENER) {
      if (this.event.findField('nl-mcgrp') !== null) this.thing.primary = this.here();
    } else if (this.event.findField('exe') !== null) {
      const exe = this.event.interpretField() ?? '';
      if (isInterpreter(exe)) {
        const field = this.event.fieldNum();
        if (field > 0) this.event.gotoFieldNum(field - 1);
        else this.event.firstRecord();
        this.event.findField('comm');
      }
      this.thing.primary = this.here();
      return 0;
    }
    return 1;
  }

  private normalizeSyscall(syscall: string | null): void {
    let objtype: number = NORM.NORM_UNKNOWN;
    let tmpKind: number = objtype;
    let ttype = 0;
    let offset = 0;
    let act: string | null = null;
    let rc = this.event.firstRecord();
    while (rc === 1) {
      ttype = this.event.type();
      if (ttype === A.AVC) {
        tmpKind = NORM.NORM_MAC;
        break;
      } else if (ttype === A.SELINUX_ERR) {
        objtype = NORM.NORM_MAC_ERR;
        break;
      } else if (ttype === A.NETFILTER_CFG) {
        objtype = NORM.NORM_IPTABLES;
        break;
      } else if (ttype === A.ANOM_PROMISCUOUS) {
        objtype = NORM.NORM_PROMISCUOUS;
        break;
      } else if (ttype === A.KERN_MODULE) {
        objtype = NORM.NORM_FILE_LDMOD;
        break;
      } else if (ttype === A.MAC_POLICY_LOAD) {
        objtype = NORM.NORM_MAC_LOAD;
        break;
      } else if (ttype === A.MAC_STATUS) {
        objtype = NORM.NORM_MAC_ENFORCE;
        break;
      } else if (ttype === A.MAC_CONFIG_CHANGE) {
        objtype = NORM.NORM_MAC_CONFIG;
        break;
      } else if (ttype === A.FANOTIFY) {
        tmpKind = NORM.NORM_AV;
        break;
      } else if (ttype === A.TIME_INJOFFSET || ttype === A.TIME_ADJNTPVAL) {
        objtype = NORM.NORM_SYSTEM_TIME;
        break;
      } else if (ttype === A.BPF) {
        objtype = NORM.NORM_BPF;
        break;
      } else if (ttype === A.EVENT_LISTENER) {
        objtype = NORM.NORM_EV_LISTEN;
        break;
      }
      rc = this.event.nextRecord();
    }
    if (objtype === NORM.NORM_UNKNOWN && syscall !== null) objtype = SYSCALL_OBJECT_KINDS[syscall] ?? objtype;
    const sys = syscall ?? '';
    const thing = this.thing;
    switch (objtype) {
      case NORM.NORM_FILE:
        act = 'opened-file';
        this.setFileObject(0);
        thing.what = NORM.NORM_WHAT_FILE;
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_CHATTR:
        act = 'changed-file-attributes-of';
        thing.what = NORM.NORM_WHAT_FILE;
        if (sys === 'fsetxattr') offset = -1;
        this.setFileObject(offset);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_CHPERM:
        act = 'changed-file-permissions-of';
        thing.what = NORM.NORM_WHAT_FILE;
        if (sys === 'fchmod') offset = -1;
        this.collectPermObject2(sys);
        this.setFileObject(offset);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_CHOWN:
        act = 'changed-file-ownership-of';
        thing.what = NORM.NORM_WHAT_FILE;
        if (sys === 'fchown') offset = -1;
        this.collectOwnObject2(sys);
        this.setFileObject(offset);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_LDMOD:
        act = 'loaded-kernel-module';
        thing.what = NORM.NORM_WHAT_FILE;
        this.event.gotoRecordNum(1);
        this.setPrimeObject('name', 1);
        break;
      case NORM.NORM_FILE_UNLDMOD:
        act = 'unloaded-kernel-module';
        thing.what = NORM.NORM_WHAT_FILE;
        break;
      case NORM.NORM_FILE_DIR:
        act = 'created-directory';
        thing.what = NORM.NORM_WHAT_FILE;
        this.setFileObject(1);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_MOUNT:
        act = 'mounted';
        thing.what = NORM.NORM_WHAT_FILESYSTEM;
        if (this.syscallSuccess === 1) this.setPrimeObject2('name', 0);
        this.setFileObject(this.syscallSuccess);
        this.collectPathAttributes();
        break;
      case NORM.NORM_FILE_RENAME:
        act = 'renamed';
        thing.what = NORM.NORM_WHAT_FILE;
        this.setPrimeObject2('name', 4);
        this.setFileObject(2);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_STAT:
        act = 'checked-metadata-of';
        thing.what = NORM.NORM_WHAT_FILE;
        this.setFileObject(0);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_SYS_STAT:
        act = 'checked-filesystem-metadata-of';
        thing.what = NORM.NORM_WHAT_FILESYSTEM;
        this.setFileObject(0);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_LNK:
        act = 'symlinked';
        thing.what = NORM.NORM_WHAT_FILE;
        this.setPrimeObject2('name', 0);
        this.setFileObject(2);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_UMNT:
        act = 'unmounted';
        thing.what = NORM.NORM_WHAT_FILESYSTEM;
        this.setFileObject(0);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_DEL:
        act = 'deleted';
        thing.what = NORM.NORM_WHAT_FILE;
        this.setFileObject(0);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_FILE_TIME:
        act = 'changed-timestamp-of';
        thing.what = NORM.NORM_WHAT_FILE;
        this.setFileObject(0);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_EXEC:
        act = 'executed';
        thing.what = NORM.NORM_WHAT_FILE;
        this.setFileObject(1);
        this.simpleFileAttributes();
        break;
      case NORM.NORM_SOCKET_ACCEPT:
        act = 'accepted-connection-from';
        thing.what = NORM.NORM_WHAT_SOCKET;
        this.setSocketObject();
        break;
      case NORM.NORM_SOCKET_BIND:
        act = 'bound-socket';
        thing.what = NORM.NORM_WHAT_SOCKET;
        this.setSocketObject();
        break;
      case NORM.NORM_SOCKET_CONN:
        act = 'connected-to';
        thing.what = NORM.NORM_WHAT_SOCKET;
        this.setSocketObject();
        break;
      case NORM.NORM_SOCKET_RECV:
        act = 'received-from';
        thing.what = NORM.NORM_WHAT_SOCKET;
        this.setSocketObject();
        break;
      case NORM.NORM_SOCKET_SEND:
        act = 'sent-to';
        thing.what = NORM.NORM_WHAT_SOCKET;
        this.setSocketObject();
        break;
      case NORM.NORM_PID:
        act = this.event.numRecords() > 2 ? 'killed-list-of-pids' : 'killed-pid';
        this.event.gotoRecordNum(1);
        this.event.firstField();
        if (this.event.findField('saddr') !== null) thing.primary = this.here();
        thing.what = NORM.NORM_WHAT_PROCESS;
        break;
      case NORM.NORM_MAC_LOAD:
        act = ACTION_BY_TYPE.get(ttype) ?? null;
        thing.what = NORM.NORM_WHAT_MAC_CONFIG;
        break;
      case NORM.NORM_MAC_CONFIG:
        act = ACTION_BY_TYPE.get(ttype) ?? null;
        if (this.event.findField('bool') !== null) thing.primary = this.here();
        thing.what = NORM.NORM_WHAT_MAC_CONFIG;
        break;
      case NORM.NORM_MAC_ENFORCE:
        act = ACTION_BY_TYPE.get(ttype) ?? null;
        if (this.event.findField('enforcing') !== null) thing.primary = this.here();
        thing.what = NORM.NORM_WHAT_MAC_CONFIG;
        break;
      case NORM.NORM_MAC_ERR:
        act = 'caused-mac-policy-error';
        thing.what = NORM.NORM_WHAT_SYSTEM;
        break;
      case NORM.NORM_IPTABLES:
        act = 'loaded-firewall-rule-to';
        this.event.firstRecord();
        if (this.event.findField('table') !== null) thing.primary = this.here();
        thing.what = NORM.NORM_WHAT_FIREWALL;
        break;
      case NORM.NORM_PROMISCUOUS:
        this.event.firstRecord();
        if (this.event.findField('dev') !== null) thing.primary = this.here();
        if (this.event.findField('prom') !== null) act = this.event.fieldInt() === 0 ? 'left-promiscuous-mode-on-device' : 'entered-promiscuous-mode-on-device';
        thing.what = NORM.NORM_WHAT_SOCKET;
        break;
      case NORM.NORM_UID:
      case NORM.NORM_GID:
        act = 'changed-identity-of';
        thing.what = NORM.NORM_WHAT_PROCESS;
        this.setProgramObject();
        if (this.how !== null) this.how = sys;
        this.collectIdObject2(sys);
        break;
      case NORM.NORM_SYSTEM_TIME:
        act = 'changed-system-time';
        thing.what = NORM.NORM_WHAT_SYSTEM;
        break;
      case NORM.NORM_MAKE_DEV:
        this.setFileObject(0);
        this.simpleFileAttributes();
        if (thing.what === NORM.NORM_WHAT_CHAR_DEV) act = 'made-character-device';
        else if (thing.what === NORM.NORM_WHAT_BLOCK_DEV) act = 'made-block-device';
        else act = 'make-device';
        break;
      case NORM.NORM_SYSTEM_NAME:
        act = 'changed-system-name';
        thing.what = NORM.NORM_WHAT_SYSTEM;
        break;
      case NORM.NORM_SYSTEM_MEMORY:
        act = 'allocated-memory';
        if (this.syscallSuccess === 1) {
          act = 'allocated-memory-in';
          this.event.firstRecord();
          if (this.event.findField('comm') !== null) thing.primary = this.here();
        }
        thing.what = NORM.NORM_WHAT_MEMORY;
        break;
      case NORM.NORM_SCHEDULER:
        act = 'adjusted-scheduling-policy-of';
        thing.what = NORM.NORM_WHAT_PROCESS;
        this.setProgramObject();
        if (this.how !== null) this.how = sys;
        break;
      case NORM.NORM_BPF:
        this.event.firstRecord();
        if (this.event.findField('op') !== null) act = this.event.fieldStr() === 'LOAD' ? 'loaded-bpf-program' : 'unloaded-bpf-program';
        else act = 'bpf-program';
        thing.what = NORM.NORM_WHAT_PROCESS;
        this.setProgramObject();
        break;
      case NORM.NORM_EV_LISTEN:
        this.event.firstRecord();
        if (this.event.findField('op') !== null) act = this.event.fieldStr() === 'connect' ? 'connected-to' : 'disconnected-from';
        else act = 'connected';
        thing.what = NORM.NORM_WHAT_SOCKET;
        this.setProgramObject();
        break;
      default: {
        this.event.firstRecord();
        const key = this.event.findField('key');
        if (key !== null && key !== '(null)') {
          act = 'triggered-audit-rule';
          thing.primary = this.here();
        } else act = 'triggered-unknown-audit-rule';
        thing.what = NORM.NORM_WHAT_AUDIT_RULE;
        break;
      }
    }
    if (tmpKind === NORM.NORM_MAC) act = 'accessed-mac-policy-controlled-object';
    else if (tmpKind === NORM.NORM_AV) act = 'accessed-policy-controlled-file';
    if (act !== null) this.action = act;
  }

  private findConfigChangeObject(): string | null {
    this.event.firstRecord();
    let found = this.event.findField('key');
    if (found !== null) {
      const text = this.event.fieldStr();
      if (text !== null && text !== '(null)') return found;
    }
    for (const name of ['audit_enabled', 'audit_pid', 'audit_backlog_limit', 'audit_failure', 'actions']) {
      this.event.firstRecord();
      found = this.event.findField(name);
      if (found !== null) return found;
    }
    return null;
  }

  private normalizeCompound(): number {
    const originalType = this.event.type();
    let type = originalType;
    if (type !== A.SYSCALL) {
      do {
        this.event.nextRecord();
        type = this.event.type();
      } while (type !== 0 && type !== A.SYSCALL);
    }
    if (type === 0) return 1;
    this.evkind = determineEventKind(originalType);
    if (type === A.SYSCALL) {
      const recordNumber = this.event.recordNum();
      let syscall: string | null = null;
      if (this.event.findField('syscall') !== null) syscall = this.event.interpretField();
      if (this.event.findField('success') !== null) {
        this.syscallSuccess = this.event.fieldStr() === 'no' ? 0 : 1;
        this.results = { record: recordNumber, field: this.event.fieldNum() };
      } else {
        if (this.event.gotoRecordNum(recordNumber) !== 1) return 1;
        this.event.firstField();
      }
      if (this.setPrimeSubject('auid', recordNumber) !== 0) {
        if (this.event.gotoRecordNum(recordNumber) !== 1) return 1;
        this.event.firstField();
      }
      if (this.setSecondarySubject('uid', recordNumber) !== 0) {
        if (this.event.gotoRecordNum(recordNumber) !== 1) return 1;
        this.event.firstField();
      }
      this.syscallSubjectAttributes();
      this.event.firstField();
      if (this.event.findField('exe') !== null) {
        this.how = this.event.interpretField() ?? '';
        if (isInterpreter(this.how)) {
          let rc = 0;
          const field = this.event.fieldNum();
          if (field > 0) rc = this.event.gotoFieldNum(field - 1);
          if (rc === 0) this.event.firstRecord();
          if (this.event.findField('comm') !== null) this.how = this.event.interpretField() ?? '';
        }
      } else {
        if (this.event.gotoRecordNum(recordNumber) !== 1) return 1;
        this.event.firstField();
      }
      if (this.event.findField('key') !== null) {
        const key = this.event.fieldStr();
        if (key !== '(null)') this.key = { record: recordNumber, field: this.event.fieldNum() };
      }
      if (originalType === A.ANOM_LINK) {
        const act = ACTION_BY_TYPE.get(originalType);
        if (act !== undefined) this.action = act;
      } else if (originalType === A.CONFIG_CHANGE) {
        this.event.firstRecord();
        if (this.event.findField('op') !== null) {
          this.action = this.event.interpretField();
          this.thing.primary = this.findSimpleObject(A.CONFIG_CHANGE);
        }
      } else this.normalizeSyscall(syscall);
    }
    return 0;
  }

  private findSimpleObject(type: number): Loc {
    let found = null as string | null;
    this.event.firstField();
    const thing = this.thing;
    const find = (name: string): void => {
      found = this.event.findField(name);
    };
    if (isOneOf(type, 'SERVICE_START', 'SERVICE_STOP')) {
      find('unit');
      thing.what = NORM.NORM_WHAT_SERVICE;
    } else if (type === A.SYSTEM_RUNLEVEL) {
      find('new-level');
      thing.what = NORM.NORM_WHAT_SYSTEM;
    } else if (type === A.USER_ROLE_CHANGE) {
      find('selected-context');
      thing.what = NORM.NORM_WHAT_USER_SESSION;
    } else if (isOneOf(type, 'ROLE_ASSIGN', 'ROLE_REMOVE', 'USER_MGMT', 'ACCT_LOCK', 'ACCT_UNLOCK', 'ADD_USER', 'DEL_USER', 'ADD_GROUP', 'DEL_GROUP', 'GRP_MGMT')) {
      find('id');
      if (found === null) {
        this.event.firstRecord();
        find('acct');
      }
      thing.what = NORM.NORM_WHAT_ACCT;
    } else if (isOneOf(type, 'USER_START', 'USER_END', 'USER_ERR', 'USER_LOGIN', 'USER_LOGOUT')) {
      find('terminal');
      thing.what = NORM.NORM_WHAT_USER_SESSION;
    } else if (isOneOf(type, 'USER_AUTH', 'USER_ACCT', 'CRED_ACQ', 'CRED_REFR', 'CRED_DISP', 'USER_CHAUTHTOK', 'GRP_CHAUTHTOK', 'ANOM_LOGIN_FAILURES', 'ANOM_LOGIN_TIME', 'ANOM_LOGIN_SESSIONS', 'ANOM_LOGIN_LOCATION')) {
      find('acct');
      thing.what = NORM.NORM_WHAT_USER_SESSION;
    } else if (isOneOf(type, 'ANOM_EXEC', 'USER_CMD')) {
      find('cmd');
      thing.what = NORM.NORM_WHAT_PROCESS;
    } else if (isOneOf(type, 'USER_TTY', 'TTY')) {
      this.event.firstRecord();
      find('data');
      thing.what = NORM.NORM_WHAT_KEYSTROKES;
    } else if (type === A.USER_DEVICE) {
      this.event.firstRecord();
      find('device');
      thing.what = NORM.NORM_WHAT_KEYSTROKES;
    } else if (type === A.SOFTWARE_UPDATE) {
      this.event.firstRecord();
      find('sw');
      thing.what = NORM.NORM_WHAT_SOFTWARE;
    } else if (type === A.VIRT_MACHINE_ID) {
      find('vm');
      thing.what = NORM.NORM_WHAT_VM;
    } else if (type === A.VIRT_RESOURCE) {
      find('resrc');
      thing.what = NORM.NORM_WHAT_VM;
    } else if (type === A.VIRT_CONTROL) {
      find('op');
      thing.what = NORM.NORM_WHAT_VM;
    } else if (type === A.LABEL_LEVEL_CHANGE) {
      find('printer');
      thing.what = NORM.NORM_WHAT_PRINTER;
    } else if (type === A.CONFIG_CHANGE) {
      found = this.findConfigChangeObject();
      thing.what = NORM.NORM_WHAT_AUDIT_CONFIG;
    } else if (type === A.MAC_CONFIG_CHANGE) {
      find('bool');
      thing.what = NORM.NORM_WHAT_MAC_CONFIG;
    } else if (type === A.MAC_STATUS) {
      find('enforcing');
      thing.what = NORM.NORM_WHAT_MAC_CONFIG;
    } else if (isOneOf(type, 'MAC_POLICY_LOAD', 'LABEL_OVERRIDE') || inRange(type, 'DEV_ALLOC', 'USER_MAC_CONFIG_CHANGE')) {
      thing.what = NORM.NORM_WHAT_MAC_CONFIG;
    } else if (type === A.USER) {
      find('addr');
    } else if (type === A.USYS_CONFIG) {
      find('op');
      if (found !== null) {
        this.action = this.event.interpretField();
        found = null;
      }
      thing.what = NORM.NORM_WHAT_SYSTEM;
    } else if (type === A.CRYPTO_KEY_USER) {
      find('fp');
      thing.what = NORM.NORM_WHAT_USER_SESSION;
    } else if (type === A.CRYPTO_SESSION) {
      find('addr');
      thing.what = NORM.NORM_WHAT_USER_SESSION;
    } else if (type === A.ANOM_RBAC_INTEGRITY_FAIL) {
      find('hostname');
      thing.what = NORM.NORM_WHAT_FILESYSTEM;
    }
    return found === null ? null : { record: 0, field: this.event.fieldNum() };
  }

  private findSimpleObjectSecondary(type: number): Loc {
    let found = null as string | null;
    this.event.firstField();
    if (type === A.CRYPTO_SESSION) found = this.event.findField('rport');
    else if (type === A.SOFTWARE_UPDATE) found = this.event.findField('sw_type');
    return found === null ? null : { record: 0, field: this.event.fieldNum() };
  }

  private findSimpleObjectPrimary2(type: number): Loc {
    let found = null as string | null;
    this.event.firstField();
    if (type === A.VIRT_CONTROL || type === A.VIRT_RESOURCE) found = this.event.findField('vm');
    else if (type === A.SOFTWARE_UPDATE) found = this.event.findField('root_dir');
    return found === null ? null : { record: 0, field: this.event.fieldNum() };
  }

  private collectSimpleSubjectAttributes(): void {
    if (this.option === 'no-attrs') return;
    this.event.firstRecord();
    this.addSubjectAttribute('pid', 0);
    this.addSubjectAttribute('subj', 0);
  }

  private collectUserspaceSubjectAttributes(type: number): void {
    if (this.option === 'no-attrs') return;
    this.addSubjectAttribute('hostname', 0);
    this.addSubjectAttribute('addr', 0);
    if (type !== A.USER_START && type !== A.USER_END && type !== A.USER_ERR) this.addSubjectAttribute('terminal', 0);
  }

  private normalizeSimple(): number {
    const type = this.event.type();
    let act: string | null = null;
    let found: string | null;
    if (type === A.SYSCALL) return this.normalizeCompound();
    this.evkind = determineEventKind(type);
    if (isOneOf(type, 'CONFIG_CHANGE', 'FEATURE_CHANGE', 'SECCOMP', 'ANOM_ABEND', 'ANOM_PROMISCUOUS')) {
      this.setPrimeSubject('auid', 0);
      this.addSession(0);
      this.collectSimpleSubjectAttributes();
      let mapped = false;
      if (type === A.CONFIG_CHANGE) {
        this.event.firstField();
        found = this.event.findField('op');
        if (found !== null) {
          let text = this.event.interpretField() ?? '';
          if (text[0] === '"') text = text.slice(1);
          if (text.startsWith('add_rule')) {
            this.action = 'added-audit-rule';
            this.thing.primary = this.findSimpleObject(type);
          } else if (text.startsWith('remove_rule')) {
            this.action = 'deleted-audit-rule';
            this.thing.primary = this.findSimpleObject(type);
          } else mapped = true;
        } else mapped = true;
      } else mapped = true;
      if (mapped) {
        act = ACTION_BY_TYPE.get(type) ?? null;
        if (act !== null) this.action = act;
        if (type === A.CONFIG_CHANGE) this.thing.primary = this.findSimpleObject(type);
        this.event.firstRecord();
      }
      if (type === A.FEATURE_CHANGE) {
        this.event.firstField();
        if (this.setSecondarySubject('uid', 0) !== 0) this.event.firstRecord();
        if (this.event.findField('exe') !== null) this.how = this.event.interpretField();
        this.setPrimeObject('feature', 0);
        this.thing.what = NORM.NORM_WHAT_SYSTEM;
      }
      if (type === A.SECCOMP) {
        this.event.firstField();
        if (this.setSecondarySubject('uid', 0) !== 0) this.event.firstRecord();
        if (this.event.findField('exe') !== null) this.how = this.event.interpretField();
        if (this.setPrimeObject('syscall', 0) !== 0) this.event.firstRecord();
        this.thing.what = NORM.NORM_WHAT_PROCESS;
        if (this.event.findField('code') !== null) this.results = { record: 0, field: this.event.fieldNum() };
        return 0;
      }
      if (type === A.ANOM_ABEND) {
        this.event.firstField();
        if (this.setSecondarySubject('uid', 0) !== 0) this.event.firstRecord();
        if (this.setPrimeObject('exe', 0) !== 0) this.event.firstRecord();
        this.thing.what = NORM.NORM_WHAT_PROCESS;
        if (this.event.findField('sig') !== null) this.how = this.event.interpretField();
      }
      if (type === A.ANOM_PROMISCUOUS) {
        this.event.firstField();
        this.setPrimeObject('dev', 0);
        this.setSecondarySubject('uid', 0);
        this.thing.what = NORM.NORM_WHAT_SOCKET;
      }
      this.setResults(0);
      return 0;
    }
    if (type === A.LOGIN) {
      if (this.setSecondarySubject('uid', 0) !== 0) this.event.firstRecord();
      this.collectSimpleSubjectAttributes();
      if (this.setPrimeSubject('old-auid', 0) !== 0) this.event.firstRecord();
      if (this.setPrimeObject('auid', 0) !== 0) this.event.firstRecord();
      this.thing.what = NORM.NORM_WHAT_USER_SESSION;
      this.addSession(0);
      this.setResults(0);
      act = ACTION_BY_TYPE.get(type) ?? null;
      if (act !== null) this.action = act;
      return 0;
    }
    if (type === A.NETFILTER_CFG) {
      this.collectSimpleSubjectAttributes();
      if (this.event.findField('comm') !== null) this.how = this.event.interpretField();
      this.action = 'loaded-firewall-rule-to';
      this.event.firstRecord();
      if (this.event.findField('table') !== null) this.thing.primary = this.here();
      this.actor.what = 'system';
      this.thing.what = NORM.NORM_WHAT_FIREWALL;
      return 0;
    }
    if (type === A.AVC) {
      if (this.event.findField('comm') !== null) this.how = this.event.interpretField();
      else this.event.firstRecord();
      this.setPrimeSubject('scontext', 0);
      this.setUnknownSubjectWhat();
      this.event.firstRecord();
      if (this.option === 'all') {
        this.setPrimeObject('tcontext', 0);
        this.event.firstRecord();
      }
      this.thing.what = NORM.NORM_WHAT_UNKNOWN;
      act = ACTION_BY_TYPE.get(type) ?? null;
      if (act !== null) this.action = act;
      this.event.firstRecord();
      if (this.event.findField('seresult') !== null) this.results = { record: 0, field: this.event.fieldNum() };
      return 0;
    }
    if (type >= A.FIRST_DAEMON && type < A.LAST_DAEMON) {
      this.setPrimeSubject('auid', 0);
      if (this.setSecondarySubject('uid', 0) !== 0) this.event.firstRecord();
      if (this.addSession(0) !== 0) this.event.firstRecord();
      this.collectSimpleSubjectAttributes();
      this.actor.what = 'auditd';
      act = ACTION_BY_TYPE.get(type) ?? null;
      if (act !== null) this.action = act;
      this.thing.what = NORM.NORM_WHAT_SERVICE;
      if (type === A.DAEMON_START) this.how = 'init';
      else if (type < A.DAEMON_ACCEPT && type !== A.DAEMON_ABORT) this.how = 'signal';
      this.setResults(0);
      return 0;
    }
    if (type === A.BPF) {
      this.actor.what = 'system';
      this.event.firstRecord();
      if (this.event.findField('op') !== null) act = this.event.fieldStr() === 'LOAD' ? 'loaded-bpf-program' : 'unloaded-bpf-program';
      else act = 'bpf-program';
      this.action = act;
      this.thing.what = NORM.NORM_WHAT_PROCESS;
      this.setProgramObject();
      return 0;
    }
    if (type === A.EVENT_LISTENER) {
      this.setPrimeSubject('auid', 0);
      this.event.firstRecord();
      this.setSecondarySubject('uid', 0);
      this.event.firstRecord();
      this.addSession(0);
      this.collectSimpleSubjectAttributes();
      this.event.firstRecord();
      if (this.event.findField('op') !== null) act = this.event.fieldStr() === 'connect' ? 'connected-to' : 'disconnected-from';
      else act = 'connected';
      this.action = act;
      this.setProgramObject();
      this.thing.what = NORM.NORM_WHAT_SOCKET;
      this.event.firstRecord();
      if (this.event.findField('exe') !== null) this.how = this.event.interpretField();
      this.event.firstRecord();
      this.setResults(0);
      return 0;
    }
    if (type >= A.MAC_UNLBL_ALLOW && type <= A.LAST_SELINUX) {
      this.setPrimeSubject('auid', 0);
      this.setSubjectWhat();
      this.addSession(0);
      this.addSubjectAttribute('subj', 0);
      if (type === A.MAC_UNLBL_ALLOW) {
        found = this.event.findField('unlbl_accept');
        if (found !== null) act = this.event.fieldInt() === 1 ? 'is-allowing-unlabeled-network-traffic' : 'is-disallowing-unlabeled-network-traffic';
        else this.event.firstRecord();
      } else act = ACTION_BY_TYPE.get(type) ?? null;
      if (act !== null) this.action = act;
      if (type === A.MAC_MAP_ADD || type === A.MAC_MAP_DEL) {
        if (this.setPrimeObject('nlbl_domain', 0) !== 0) this.event.firstRecord();
      }
      this.thing.what = NORM.NORM_WHAT_MAC_CONFIG;
      this.setResults(0);
      return 0;
    }
    if (type === A.USER_LOGIN) {
      if (this.setPrimeSubject('id', 0) !== 0) {
        this.event.firstRecord();
        if (this.setPrimeSubject('acct', 0) === 0) this.setSubjectWhat();
      } else this.setSubjectWhat();
      this.event.firstRecord();
    } else {
      if (this.setSecondarySubject('uid', 0) !== 0) this.event.firstRecord();
      this.setPrimeSubject('auid', 0);
    }
    this.addSession(0);
    this.collectSimpleSubjectAttributes();
    if ((type >= A.FIRST_USER_MSG && type < A.LAST_USER_MSG) || (type >= A.FIRST_USER_MSG2 && type < A.LAST_USER_MSG2)) this.collectUserspaceSubjectAttributes(type);
    if (type !== A.USER_AVC) this.setResults(0);
    else {
      this.event.firstRecord();
      if (this.event.findField('seresult') !== null) this.results = { record: 0, field: this.event.fieldNum() };
      this.event.firstRecord();
      this.setPrimeSubject('scontext', 0);
      if (this.option === 'all') {
        this.event.firstRecord();
        this.setPrimeObject('tcontext', 0);
      }
    }
    if (type === A.USER_DEVICE) {
      this.event.firstRecord();
      found = this.event.findField('op');
      if (found !== null) act = found;
    }
    if (act === null) act = ACTION_BY_TYPE.get(type) ?? null;
    if (act !== null) this.action = act;
    if (type !== A.USER_AVC) {
      this.event.firstRecord();
      this.thing.primary = this.findSimpleObject(type);
      this.thing.secondary = this.findSimpleObjectSecondary(type);
      this.thing.two = this.findSimpleObjectPrimary2(type);
      if (this.option === 'all') {
        if (type === A.USER_DEVICE) this.addObjectAttribute('uuid', 0);
        else if (type === A.SOFTWARE_UPDATE) {
          this.event.firstRecord();
          this.addObjectAttribute('key_enforce', 0);
          this.addObjectAttribute('gpg_res', 0);
        }
      }
    }
    if (type === A.SYSTEM_BOOT) {
      this.thing.what = NORM.NORM_WHAT_SYSTEM;
      if (this.event.findField('exe') !== null) this.how = this.event.interpretField();
      return 0;
    } else if (type === A.SYSTEM_SHUTDOWN) {
      this.thing.what = NORM.NORM_WHAT_SERVICE;
      if (this.event.findField('exe') !== null) this.how = this.event.interpretField();
      return 0;
    }
    this.event.firstRecord();
    if (type === A.ANOM_EXEC) {
      if (this.event.findField('terminal') !== null) this.how = this.event.interpretField();
      return 0;
    }
    if (type === A.TTY) {
      if (this.event.findField('comm') !== null) this.how = this.event.interpretField();
      return 0;
    }
    if (this.event.findField('exe') !== null) {
      this.how = this.event.interpretField() ?? '';
      if (isInterpreter(this.how)) {
        const field = this.event.fieldNum();
        if (field > 0) this.event.gotoFieldNum(field - 1);
        else this.event.firstRecord();
        if (this.event.findField('comm') !== null) this.how = this.event.interpretField() ?? '';
      }
    }
    return 0;
  }

  normalize(option: NormalizeOption): number {
    this.event.firstRecord();
    const count = this.event.numRecords();
    this.event.firstRecord();
    this.clear();
    this.option = option;
    const rc = count > 1 ? this.normalizeCompound() : this.normalizeSimple();
    this.event.firstRecord();
    return rc;
  }

  private seek(location: Loc): number {
    if (location === null) return 0;
    if (this.event.gotoRecordNum(location.record) !== 1) return -1;
    if (this.event.gotoFieldNum(location.field) !== 1) return -2;
    return 1;
  }

  subjectKind(): string | null {
    return this.actor.what;
  }

  eventKind(): string | null {
    return this.evkind;
  }

  getAction(): string | null {
    return this.action;
  }

  getHow(): string | null {
    return this.how;
  }

  objectKind(): string {
    return OBJECT_KIND_NAMES[this.thing.what];
  }

  seekSession(): number {
    return this.seek(this.session);
  }

  seekSubjectPrimary(): number {
    return this.seek(this.actor.primary);
  }

  seekSubjectSecondary(): number {
    return this.seek(this.actor.secondary);
  }

  seekObjectPrimary(): number {
    return this.seek(this.thing.primary);
  }

  seekObjectSecondary(): number {
    return this.seek(this.thing.secondary);
  }

  seekObjectPrimary2(): number {
    return this.seek(this.thing.two);
  }

  seekResults(): number {
    return this.seek(this.results);
  }

  seekKey(): number {
    return this.seek(this.key);
  }

  subjectFirstAttribute(): number {
    if (this.actor.attr.length > 0) {
      this.attrCursor.actor = 0;
      return this.seek(this.actor.attr[0]);
    }
    return 0;
  }

  subjectNextAttribute(): number {
    if (this.actor.attr.length > 0) {
      const next = this.actor.attr[this.attrCursor.actor + 1];
      if (next !== undefined) {
        this.attrCursor.actor++;
        return this.seek(next);
      }
    }
    return 0;
  }

  objectFirstAttribute(): number {
    if (this.thing.attr.length > 0) {
      this.attrCursor.thing = 0;
      return this.seek(this.thing.attr[0]);
    }
    return 0;
  }

  objectNextAttribute(): number {
    if (this.thing.attr.length > 0) {
      const next = this.thing.attr[this.attrCursor.thing + 1];
      if (next !== undefined) {
        this.attrCursor.thing++;
        return this.seek(next);
      }
    }
    return 0;
  }
}

function isInterpreter(exe: string): boolean {
  return exe.startsWith('/usr/bin/python') || exe.startsWith('/usr/bin/sh') || exe.startsWith('/usr/bin/bash') || exe.startsWith('/usr/bin/perl');
}
