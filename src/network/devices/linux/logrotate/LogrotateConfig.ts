import { fnmatch } from '../fs/Glob';
import { poptParseArgvString } from './PoptArgv';
import { MESS_DEBUG, MESS_ERROR, MESS_NORMAL, MessageLog } from './LogrotateLog';
import { isFailure, STRERROR, type LogrotateSystem } from './LogrotateSystem';

export const FLAG = {
  COMPRESS: 1 << 0,
  CREATE: 1 << 1,
  IFEMPTY: 1 << 2,
  DELAYCOMPRESS: 1 << 3,
  COPYTRUNCATE: 1 << 4,
  MISSINGOK: 1 << 5,
  MAILFIRST: 1 << 6,
  SHAREDSCRIPTS: 1 << 7,
  COPY: 1 << 8,
  DATEEXT: 1 << 9,
  SHRED: 1 << 10,
  SU: 1 << 11,
  DATEYESTERDAY: 1 << 12,
  OLDDIRCREATE: 1 << 13,
  TMPFILENAME: 1 << 14,
  DATEHOURAGO: 1 << 15,
  ALLOWHARDLINK: 1 << 16,
} as const;

export type Criterium = 'hourly' | 'days' | 'weekly' | 'monthly' | 'yearly' | 'size';

export const NO_MODE = -1;
export const NO_UID = -1;
export const NO_GID = -1;

export const COMPRESS_COMMAND = '/bin/gzip';
export const UNCOMPRESS_COMMAND = '/bin/gunzip';
export const COMPRESS_EXT = '.gz';

export interface LogInfo {
  pattern: string | null;
  files: string[];
  oldDir: string | null;
  criterium: Criterium;
  weekday: number;
  threshold: number;
  maxsize: number;
  minsize: number;
  rotateCount: number;
  rotateMinAge: number;
  rotateAge: number;
  logStart: number;
  pre: string | null;
  post: string | null;
  first: string | null;
  last: string | null;
  preremove: string | null;
  logAddress: string | null;
  extension: string | null;
  addextension: string | null;
  compressProg: string | null;
  uncompressProg: string | null;
  compressExt: string | null;
  dateformat: string | null;
  flags: number;
  shredCycles: number;
  createMode: number;
  createUid: number;
  createGid: number;
  suUid: number;
  suGid: number;
  olddirMode: number;
  olddirUid: number;
  olddirGid: number;
  compressOptions: string[];
}

export function defaultLogInfo(): LogInfo {
  return {
    pattern: null, files: [], oldDir: null, criterium: 'size', weekday: 0, threshold: 1024 * 1024,
    maxsize: 0, minsize: 0, rotateCount: 0, rotateMinAge: 0, rotateAge: 0, logStart: -1,
    pre: null, post: null, first: null, last: null, preremove: null, logAddress: null,
    extension: null, addextension: null, compressProg: null, uncompressProg: null, compressExt: null,
    dateformat: null, flags: FLAG.IFEMPTY, shredCycles: 0,
    createMode: NO_MODE, createUid: NO_UID, createGid: NO_GID, suUid: NO_UID, suGid: NO_GID,
    olddirMode: NO_MODE, olddirUid: NO_UID, olddirGid: NO_GID, compressOptions: [],
  };
}

function copyLogInfo(from: LogInfo): LogInfo {
  return {
    ...defaultLogInfo(),
    oldDir: from.oldDir, criterium: from.criterium, weekday: from.weekday, threshold: from.threshold,
    minsize: from.minsize, maxsize: from.maxsize, rotateCount: from.rotateCount,
    rotateMinAge: from.rotateMinAge, rotateAge: from.rotateAge, logStart: from.logStart,
    pre: from.pre, post: from.post, first: from.first, last: from.last, preremove: from.preremove,
    logAddress: from.logAddress, extension: from.extension, compressProg: from.compressProg,
    uncompressProg: from.uncompressProg, compressExt: from.compressExt, flags: from.flags,
    shredCycles: from.shredCycles, createMode: from.createMode, createUid: from.createUid,
    createGid: from.createGid, suUid: from.suUid, suGid: from.suGid, olddirMode: from.olddirMode,
    olddirUid: from.olddirUid, olddirGid: from.olddirGid, compressOptions: [...from.compressOptions],
    dateformat: from.dateformat,
  };
}

const STATE_DEFAULT = 2;
const STATE_SKIP_LINE = 4;
const STATE_DEFINITION_END = 8;
const STATE_SKIP_CONFIG = 16;
const STATE_LOAD_SCRIPT = 32;
const STATE_ERROR = 64;

const DEFAULT_TABOO_EXTENSIONS = [
  ',v', '.bak', '.cfsaved', '.disabled', '.dpkg-bak', '.dpkg-del', '.dpkg-dist', '.dpkg-new',
  '.dpkg-old', '.dpkg-tmp', '.rhn-cfg-tmp-*', '.rpmnew', '.rpmorig', '.rpmsave', '.swp',
  '.ucf-dist', '.ucf-new', '.ucf-old', '~',
];

const COMPRESS_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['gzip', '.gz'], ['bzip2', '.bz2'], ['xz', '.xz'], ['zstd', '.zst'], ['compress', '.Z'], ['zip', 'zip'],
];

const MAX_NESTING = 16;

const isSpace = (char: string): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\v' || char === '\f' || char === '\r';
const isBlank = (char: string): boolean => char === ' ' || char === '\t';
const isAlpha = (char: string): boolean => /^[A-Za-z]$/.test(char);
const isDigit = (char: string): boolean => /^[0-9]$/.test(char);
const isPrintable = (char: string): boolean => char >= ' ' && char <= '~';

const basenameOf = (path: string): string => {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1) || '/';
};

const dirnameOf = (path: string): string => {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return trimmed.slice(0, index).replace(/\/+$/, '') || '/';
};

export { basenameOf, dirnameOf };

interface Integer {
  readonly value: number;
  readonly rest: string;
}

function strtol(text: string, base: number): Integer {
  const match = /^[ \t\n\v\f\r]*([+-]?)(0[xX](?=[0-9a-fA-F])|0(?=[0-7])|)([0-9a-zA-Z]*)/.exec(text);
  if (match === null) return { value: 0, rest: text };
  const sign = match[1] === '-' ? -1 : 1;
  const prefix = match[2];
  let effective = base;
  if (base === 0) effective = /^0[xX]/.test(prefix) ? 16 : prefix === '0' ? 8 : 10;
  const digitsAllowed = effective === 16 ? /^[0-9a-fA-F]*/ : effective === 8 ? /^[0-7]*/ : /^[0-9]*/;
  const digits = digitsAllowed.exec(match[3])?.[0] ?? '';
  const consumed = match[0].length - match[3].length + digits.length;
  if (digits === '' && prefix === '') return { value: 0, rest: text };
  return { value: digits === '' ? 0 : sign * parseInt(digits, effective), rest: text.slice(consumed) };
}

export { strtol };

interface ModeScan {
  readonly count: number;
  readonly mode: number;
  readonly user: string;
  readonly group: string;
}

function scanToken(text: string, from: number): { token: string; next: number } | null {
  let i = from;
  while (i < text.length && isSpace(text[i])) i++;
  if (i >= text.length) return null;
  let end = i;
  while (end < text.length && !isSpace(text[end]) && end - i < 199) end++;
  return { token: text.slice(i, end), next: end };
}

function scanModeUserGroup(text: string, withMode: boolean): ModeScan {
  let position = 0;
  let count = 0;
  let mode = 0;
  if (withMode) {
    let i = 0;
    while (i < text.length && isSpace(text[i])) i++;
    let j = i;
    while (j < text.length && text[j] >= '0' && text[j] <= '7') j++;
    if (i >= text.length) return { count: -1, mode: 0, user: '', group: '' };
    if (j === i) return { count: 0, mode: 0, user: '', group: '' };
    mode = parseInt(text.slice(i, j), 8) & 0xffff;
    count = 1;
    position = j;
  }
  const first = scanToken(text, position);
  if (first === null) return { count: count === 0 ? -1 : count, mode, user: '', group: '' };
  count++;
  const second = scanToken(text, first.next);
  if (second === null) return { count, mode, user: first.token, group: '' };
  count++;
  if (second.next < text.length) count++;
  return { count, mode, user: first.token, group: second.token };
}

export interface ReadResult {
  readonly errors: boolean;
}

export class ConfigReader {
  readonly logs: LogInfo[] = [];
  private tabooPatterns: string[] = [];
  private recursionDepth = 0;

  constructor(private readonly system: LogrotateSystem, private readonly log: MessageLog) {}

  readAllConfigPaths(paths: readonly string[]): boolean {
    const defConfig = defaultLogInfo();
    this.tabooPatterns = DEFAULT_TABOO_EXTENSIONS.map((extension) => `*${extension}`);
    let result = false;
    for (const path of paths) {
      if (this.readConfigPath(path, defConfig)) result = true;
    }
    return result;
  }

  private checkFile(fileName: string): boolean {
    if (fileName === '.' || fileName === '..') return false;
    for (const pattern of this.tabooPatterns) {
      if (fnmatch(pattern, fileName, { period: true })) {
        this.log.debug(`Ignoring ${fileName}, because of ${pattern} pattern match\n`);
        return false;
      }
    }
    return true;
  }

  private restore(target: LogInfo, backup: LogInfo): void {
    const restored = copyLogInfo(backup);
    Object.assign(target, restored, { addextension: null, pattern: target.pattern, files: target.files });
  }

  private readConfigPath(path: string, defConfig: LogInfo): boolean {
    const stat = this.system.stat(path);
    if (isFailure(stat)) {
      this.log.error(`cannot stat ${path}: ${STRERROR[stat.errno]}\n`);
      return true;
    }
    let result = false;
    if (stat.type === 'directory') {
      const entries = this.system.listDirectory(path);
      if (isFailure(entries)) {
        this.log.error(`cannot open directory ${path}: ${STRERROR[entries.errno]}\n`);
        return true;
      }
      const names = entries.filter((name) => this.checkFile(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (names.length === 0) return false;
      const here = this.system.cwd();
      const failure = this.system.chdir(path);
      if (failure !== null) {
        this.log.error(`error in chdir("${path}"): ${STRERROR[failure]}\n`);
        return true;
      }
      for (const name of names) {
        const backup = copyLogInfo(defConfig);
        if (this.readConfigFile(name, defConfig)) {
          this.log.error(`found error in file ${name}, skipping\n`);
          this.restore(defConfig, backup);
          result = true;
        }
      }
      this.system.chdir(here);
    } else {
      const backup = copyLogInfo(defConfig);
      if (this.readConfigFile(path, defConfig)) {
        this.restore(defConfig, backup);
        result = true;
      }
    }
    return result;
  }

  private newLogInfo(template: LogInfo): LogInfo {
    const created = copyLogInfo(template);
    this.logs.push(created);
    return created;
  }

  private freeTailLogs(count: number): void {
    this.log.debug(`removing last ${count} log configs\n`);
    for (let i = 0; i < count; i++) this.logs.pop();
  }

  private resolveUid(name: string): number | null {
    const found = this.system.lookupUser(name);
    if (found !== null) return found;
    if (name !== '' && /^[0-9]+$/.test(name)) {
      const parsed = Number(name);
      if (parsed < 2147483647 && this.system.userExists(parsed)) return parsed;
    }
    return null;
  }

  private resolveGid(name: string): number | null {
    const found = this.system.lookupGroup(name);
    if (found !== null) return found;
    if (name !== '' && /^[0-9]+$/.test(name)) {
      const parsed = Number(name);
      if (parsed < 2147483647 && this.system.groupExists(parsed)) return parsed;
    }
    return null;
  }

  private readModeUidGid(
    configFile: string, lineNum: number, key: string, directive: string,
    target: { mode: number; uid: number; gid: number },
  ): boolean {
    let scan = scanModeUserGroup(key, directive !== 'su');
    let rc = scan.count;
    let mode = scan.mode;
    if (directive === 'su') {
      rc = 0;
    }
    if (rc === 0) {
      scan = scanModeUserGroup(key, false);
      rc = scan.count;
      if (rc > 0) {
        mode = target.mode;
        rc += 1;
      }
    }
    if (rc === 4) {
      this.log.error(`${configFile}:${lineNum} extra arguments for ${directive}\n`);
      return false;
    }
    if (rc > 0) target.mode = mode;
    if (rc > 1) {
      const uid = this.resolveUid(scan.user);
      if (uid === null) {
        this.log.error(`${configFile}:${lineNum} unknown user '${scan.user}'\n`);
        return false;
      }
      target.uid = uid;
    }
    if (rc > 2) {
      const gid = this.resolveGid(scan.group);
      if (gid === null) {
        this.log.error(`${configFile}:${lineNum} unknown group '${scan.group}'\n`);
        return false;
      }
      target.gid = gid;
    }
    return true;
  }

  readConfigFile(configFile: string, defConfig: LogInfo): boolean {
    const log = this.log;
    const stat = this.system.stat(configFile);
    if (isFailure(stat)) {
      log.error(`failed to open config file ${configFile}: ${STRERROR[stat.errno]}\n`);
      return true;
    }
    if (stat.type !== 'file') {
      log.debug(`Ignoring ${configFile} because it's not a regular file.\n`);
      return false;
    }
    if (!this.system.userExists(this.system.getuid())) {
      log.error(`Cannot find logrotate UID (${this.system.getuid()}) in passwd file: ${STRERROR.ENOENT}\n`);
      return true;
    }
    if (this.system.getuid() === 0) {
      if ((stat.mode & 0o7533) !== 0o400) {
        log.normal(`Potentially dangerous mode on ${configFile}: 0${(stat.mode & 0o7777).toString(8)}\n`);
      }
      if ((stat.mode & 0o022) !== 0) {
        log.error(`Ignoring ${configFile} because it is writable by group or others.\n`);
        return false;
      }
      if (stat.uid !== 0) {
        log.error(`Ignoring ${configFile} because the file owner is wrong (should be root or user with uid 0).\n`);
        return false;
      }
    }
    const text = this.system.readText(configFile);
    if (isFailure(text)) {
      log.error(`failed to open config file ${configFile}: ${STRERROR[text.errno]}\n`);
      return true;
    }
    const length = stat.size > 0 ? text.length : 0;
    if (length > 0xffffff) {
      log.error(`file ${configFile} too large, probably not a config file.\n`);
      return true;
    }
    if (length === 0) {
      log.debug(`Ignoring ${configFile} because it's empty.\n`);
      return false;
    }
    log.debug(`reading config file ${configFile}\n`);
    return this.parse(configFile, text, length, defConfig);
  }

  private parse(configFile: string, buf: string, length: number, defConfig: LogInfo): boolean {
    const log = this.log;
    const at = (index: number): string => (index >= 0 && index < length ? buf[index] : '\0');
    let start = 0;
    let key: string | null = null;
    let lineNum = 1;
    let scriptStart = -1;
    let scriptDest: keyof Pick<LogInfo, 'pre' | 'post' | 'first' | 'last' | 'preremove'> | null = null;
    let newlog = defConfig;
    let state = STATE_DEFAULT;
    let logerror = false;
    let criteriumSet = false;
    let inConfig = false;
    let globError: string | null = null;

    const isolateLine = (): string | null => {
      let endtag = start;
      while (endtag < length && buf[endtag] !== '\n') endtag++;
      const tmp = endtag - 1;
      while (isSpace(at(endtag))) endtag--;
      const value = endtag + 1 > start ? buf.slice(start, endtag + 1) : '';
      start = tmp;
      return value;
    };
    const isolateValue = (name: string): string | null => {
      let chptr = start;
      while (chptr < length && isBlank(buf[chptr])) chptr++;
      if (chptr < length && buf[chptr] === '=') {
        chptr++;
        while (chptr < length && isBlank(buf[chptr])) chptr++;
      }
      if (chptr < length && buf[chptr] === '\n') {
        log.error(`${configFile}:${lineNum} argument expected after ${name}\n`);
        return null;
      }
      start = chptr;
      return isolateLine();
    };
    const isolateWord = (): string | null => {
      let begin = start;
      while (begin < length && isBlank(buf[begin])) begin++;
      let endtag = begin;
      while (endtag < length && isAlpha(buf[endtag])) endtag++;
      const word = buf.slice(begin, endtag);
      start = endtag;
      return word;
    };
    const readPath = (name: string): string | null => {
      const path = isolateValue(name);
      if (path === null) return null;
      for (const char of path) {
        if (!(isPrintable(char) || char > '~') || isBlank(char)) {
          log.error(`${configFile}:${lineNum} bad ${name} path ${path}\n`);
          return null;
        }
      }
      return path;
    };
    const readAddress = (name: string): string | null => {
      const begin = start;
      const address = isolateValue(name);
      if (address === null) return null;
      for (const char of address) {
        if (!isPrintable(char) || char === ' ') {
          log.error(`${configFile}:${lineNum} bad ${name} address ${buf.slice(begin)}\n`);
          return null;
        }
      }
      return address;
    };
    const setCriterium = (criterium: Criterium): void => {
      if (criteriumSet && newlog.criterium !== criterium) {
        log.verbose(`warning: '${criterium === 'days' ? 'daily' : criterium}' overrides previously specified '${newlog.criterium === 'days' ? 'daily' : newlog.criterium}'\n`);
      }
      newlog.criterium = criterium;
      criteriumSet = true;
    };

    const fail = (): boolean => {
      if (newlog !== defConfig) this.freeTailLogs(1);
      return true;
    };

    for (start = 0; start < length; start++) {
      switch (state) {
        case STATE_DEFAULT: {
          const c = buf[start];
          if (isBlank(c)) continue;
          if (c === '#') {
            state = STATE_SKIP_LINE;
            continue;
          }
          if (isAlpha(c)) {
            key = isolateWord();
            if (key === null) {
              log.error(`${configFile}:${lineNum} failed to parse keyword\n`);
              if (newlog !== defConfig) { state = STATE_ERROR; continue; }
              return fail();
            }
            const after = at(start);
            if (!isSpace(after) && after !== '=') {
              log.error(`${configFile}:${lineNum} keyword '${key}' not properly separated, found 0x${after.charCodeAt(0).toString(16)}\n`);
              if (newlog !== defConfig) { state = STATE_ERROR; continue; }
              return fail();
            }
            const raise = (): 'continue' | 'fail' => {
              if (newlog !== defConfig) { state = STATE_ERROR; return 'continue'; }
              return 'fail';
            };
            let outcome: 'break' | 'continue' | 'fail' = 'break';
            const numberOption = (
              label: string, apply: (value: number) => boolean, badMessage: (raw: string) => string, parser: (raw: string) => Integer,
            ): void => {
              const raw = isolateValue(label);
              if (raw === null) { outcome = raise(); return; }
              const parsed = parser(raw);
              if (parsed.rest !== '' || !apply(parsed.value)) {
                log.error(`${configFile}:${lineNum} ${badMessage(raw)}\n`);
                outcome = raise();
              }
            };
            const asUnsigned = (raw: string): Integer => strtol(raw, 0);
            switch (key) {
              case 'compress': newlog.flags |= FLAG.COMPRESS; break;
              case 'nocompress': newlog.flags &= ~FLAG.COMPRESS; break;
              case 'delaycompress': newlog.flags |= FLAG.DELAYCOMPRESS; break;
              case 'nodelaycompress': newlog.flags &= ~FLAG.DELAYCOMPRESS; break;
              case 'shred': newlog.flags |= FLAG.SHRED; break;
              case 'noshred': newlog.flags &= ~FLAG.SHRED; break;
              case 'allowhardlink': newlog.flags |= FLAG.ALLOWHARDLINK; break;
              case 'noallowhardlink': newlog.flags &= ~FLAG.ALLOWHARDLINK; break;
              case 'sharedscripts': newlog.flags |= FLAG.SHAREDSCRIPTS; break;
              case 'nosharedscripts': newlog.flags &= ~FLAG.SHAREDSCRIPTS; break;
              case 'copytruncate': newlog.flags |= FLAG.COPYTRUNCATE; newlog.flags &= ~FLAG.TMPFILENAME; break;
              case 'nocopytruncate': newlog.flags &= ~FLAG.COPYTRUNCATE; break;
              case 'renamecopy': newlog.flags |= FLAG.TMPFILENAME; newlog.flags &= ~FLAG.COPYTRUNCATE; break;
              case 'norenamecopy': newlog.flags &= ~FLAG.TMPFILENAME; break;
              case 'copy': newlog.flags |= FLAG.COPY; break;
              case 'nocopy': newlog.flags &= ~FLAG.COPY; break;
              case 'ifempty': newlog.flags |= FLAG.IFEMPTY; break;
              case 'notifempty': newlog.flags &= ~FLAG.IFEMPTY; break;
              case 'dateext': newlog.flags |= FLAG.DATEEXT; break;
              case 'nodateext': newlog.flags &= ~FLAG.DATEEXT; break;
              case 'dateyesterday': newlog.flags |= FLAG.DATEYESTERDAY; break;
              case 'datehourago': newlog.flags |= FLAG.DATEHOURAGO; break;
              case 'dateformat': newlog.dateformat = isolateValue(key); break;
              case 'noolddir': newlog.oldDir = null; break;
              case 'mailfirst': newlog.flags |= FLAG.MAILFIRST; break;
              case 'maillast': newlog.flags &= ~FLAG.MAILFIRST; break;
              case 'su': {
                const line = isolateLine();
                const target = { mode: NO_MODE, uid: newlog.suUid, gid: newlog.suGid };
                if (line === null) {
                  log.error(`${configFile}:${lineNum} failed to parse su option value\n`);
                  outcome = raise();
                  break;
                }
                if (!this.readModeUidGid(configFile, lineNum, line, 'su', target)) {
                  outcome = raise();
                  break;
                }
                newlog.suUid = target.uid;
                newlog.suGid = target.gid;
                if (target.mode !== NO_MODE) {
                  log.error(`${configFile}:${lineNum} extra arguments for su\n`);
                  outcome = raise();
                } else if (newlog.suUid === NO_UID) {
                  log.error(`${configFile}:${lineNum} no user for su\n`);
                  outcome = raise();
                } else if (newlog.suGid === NO_GID) {
                  log.error(`${configFile}:${lineNum} no group for su\n`);
                  outcome = raise();
                } else {
                  newlog.flags |= FLAG.SU;
                }
                break;
              }
              case 'create': {
                const line = isolateLine();
                if (line === null) { outcome = 'continue'; break; }
                const target = { mode: newlog.createMode, uid: newlog.createUid, gid: newlog.createGid };
                const ok = this.readModeUidGid(configFile, lineNum, line, 'create', target);
                newlog.createMode = target.mode;
                newlog.createUid = target.uid;
                newlog.createGid = target.gid;
                if (!ok) { outcome = raise(); break; }
                newlog.flags |= FLAG.CREATE;
                break;
              }
              case 'createolddir': {
                const line = isolateLine();
                if (line === null) { outcome = 'continue'; break; }
                const target = { mode: newlog.olddirMode, uid: newlog.olddirUid, gid: newlog.olddirGid };
                const ok = this.readModeUidGid(configFile, lineNum, line, 'createolddir', target);
                newlog.olddirMode = target.mode;
                newlog.olddirUid = target.uid;
                newlog.olddirGid = target.gid;
                if (!ok) { outcome = raise(); break; }
                newlog.flags |= FLAG.OLDDIRCREATE;
                break;
              }
              case 'nocreateolddir': newlog.flags &= ~FLAG.OLDDIRCREATE; break;
              case 'nocreate': newlog.flags &= ~FLAG.CREATE; break;
              case 'size': case 'minsize': case 'maxsize': {
                const option = key;
                let value = isolateValue(option);
                if (value !== null && value !== '') {
                  const last = value[value.length - 1];
                  let multiplier = 1;
                  if (last === 'k' || last === 'K') { value = value.slice(0, -1); multiplier = 1024; }
                  else if (last === 'M') { value = value.slice(0, -1); multiplier = 1024 * 1024; }
                  else if (last === 'G') { value = value.slice(0, -1); multiplier = 1024 * 1024 * 1024; }
                  else if (!isDigit(last)) {
                    log.error(`${configFile}:${lineNum} unknown unit '${last}'\n`);
                    outcome = raise();
                    break;
                  }
                  const parsed = strtol(value, 0);
                  const size = multiplier * parsed.value;
                  if (parsed.rest !== '' || size < 0) {
                    log.error(`${configFile}:${lineNum} bad size '${value}'\n`);
                    outcome = raise();
                    break;
                  }
                  if (option === 'size') {
                    setCriterium('size');
                    newlog.threshold = size;
                  } else if (option === 'maxsize') {
                    newlog.maxsize = size;
                  } else {
                    newlog.minsize = size;
                  }
                } else {
                  outcome = 'continue';
                }
                break;
              }
              case 'shredcycles':
                numberOption('shred cycles', (value) => { newlog.shredCycles = value; return value >= 0; },
                  (raw) => `bad shred cycles '${raw}'`, asUnsigned);
                break;
              case 'hourly': setCriterium('hourly'); break;
              case 'daily': setCriterium('days'); newlog.threshold = 1; break;
              case 'monthly': setCriterium('monthly'); break;
              case 'yearly': setCriterium('yearly'); break;
              case 'weekly': {
                setCriterium('weekly');
                const line = isolateLine();
                if (line === null || line === '') {
                  newlog.weekday = 0;
                  outcome = 'continue';
                  break;
                }
                const match = /^[ \t]*(\d+)(.)?/s.exec(line);
                if (match !== null && match[2] === undefined && Number(match[1]) <= 7) {
                  newlog.weekday = Number(match[1]);
                  outcome = 'continue';
                  break;
                }
                log.error(`${configFile}:${lineNum} bad weekly directive '${line}'\n`);
                outcome = 'fail';
                break;
              }
              case 'rotate':
                numberOption('rotate count', (value) => { newlog.rotateCount = value; return value >= -1; },
                  (raw) => `bad rotation count '${raw}'`, (raw) => strtol(raw, 0));
                break;
              case 'start':
                numberOption('start count', (value) => { newlog.logStart = value; return value >= 0; },
                  (raw) => `bad start count '${raw}'`, asUnsigned);
                break;
              case 'minage':
                numberOption('minage count', (value) => { newlog.rotateMinAge = value; return value >= 0; },
                  () => `bad minimum age '${buf.slice(start)}'`, asUnsigned);
                break;
              case 'maxage':
                numberOption('maxage count', (value) => { newlog.rotateAge = value; return value >= 0; },
                  () => `bad maximum age '${buf.slice(start)}'`, asUnsigned);
                break;
              case 'errors':
                log.normal(`${configFile}: ${lineNum}: the errors directive is deprecated and no longer used.\n`);
                break;
              case 'mail': {
                newlog.logAddress = null;
                const address = readAddress('mail');
                if (address === null) { outcome = raise(); break; }
                newlog.logAddress = address;
                break;
              }
              case 'nomail': newlog.logAddress = null; break;
              case 'missingok': newlog.flags |= FLAG.MISSINGOK; break;
              case 'nomissingok': newlog.flags &= ~FLAG.MISSINGOK; break;
              case 'prerotate': case 'firstaction': case 'postrotate': case 'lastaction': case 'preremove': {
                const slot = key === 'prerotate' ? 'pre' : key === 'firstaction' ? 'first' : key === 'postrotate' ? 'post' : key === 'lastaction' ? 'last' : 'preremove';
                newlog[slot] = null;
                scriptStart = start;
                scriptDest = slot;
                state = STATE_LOAD_SCRIPT;
                break;
              }
              case 'tabooext': case 'taboopat': {
                if (newlog !== defConfig) {
                  log.error(`${configFile}:${lineNum} ${key} may not appear inside of log file definition\n`);
                  state = STATE_ERROR;
                  outcome = 'continue';
                  break;
                }
                const raw = isolateValue(key);
                if (raw === null) { outcome = 'continue'; break; }
                let cursor = 0;
                if (raw[0] === '+') {
                  cursor++;
                  while (cursor < raw.length && isSpace(raw[cursor])) cursor++;
                } else {
                  this.tabooPatterns = [];
                }
                while (cursor < raw.length) {
                  let end = cursor;
                  while (end < raw.length && !isSpace(raw[end]) && raw[end] !== ',') end++;
                  if (key === 'taboopat' || cursor < end) {
                    this.tabooPatterns.push(key === 'tabooext' ? `*${raw.slice(cursor, end)}` : raw.slice(cursor, end));
                  }
                  cursor = end;
                  if (raw[cursor] === ',') cursor++;
                  while (cursor < raw.length && isSpace(raw[cursor])) cursor++;
                }
                break;
              }
              case 'include': {
                let raw = isolateValue('include');
                if (raw === null) { outcome = raise(); break; }
                if (raw[0] === '~' && raw[1] === '/') {
                  let home = this.system.homeDirectory();
                  if (home === null) {
                    log.debug(`${configFile}:${lineNum} cannot get HOME directory from environment to replace ~/ in include directive\n`);
                    log.error(`${configFile}:${lineNum} cannot get passwd entry for running user ${this.system.getuid()}: ${STRERROR.ENOENT}\n`);
                    outcome = raise();
                    break;
                  }
                  const replaced = `${home}/${raw.slice(2)}`;
                  log.debug(`${configFile}:${lineNum} replaced ${raw} with '${home}' for include directive\n`);
                  home = null;
                  raw = replaced;
                }
                log.debug(`including ${raw}\n`);
                if (this.recursionDepth >= MAX_NESTING) {
                  log.error(`${configFile}:${lineNum} include nesting too deep\n`);
                  logerror = true;
                  outcome = 'continue';
                  break;
                }
                this.recursionDepth++;
                const failed = this.readConfigPath(raw, newlog);
                this.recursionDepth--;
                if (failed) {
                  logerror = true;
                  outcome = 'continue';
                }
                break;
              }
              case 'olddir': {
                newlog.oldDir = null;
                const path = readPath('olddir');
                if (path === null) { outcome = raise(); break; }
                newlog.oldDir = path;
                log.debug(`olddir is now ${newlog.oldDir}\n`);
                break;
              }
              case 'extension': {
                const value = isolateValue('extension name');
                if (value === null) { outcome = raise(); break; }
                newlog.extension = value;
                log.debug(`extension is now ${newlog.extension}\n`);
                break;
              }
              case 'addextension': {
                const value = isolateValue('addextension name');
                if (value === null) { outcome = raise(); break; }
                newlog.addextension = value;
                log.debug(`addextension is now ${newlog.addextension}\n`);
                break;
              }
              case 'compresscmd': {
                newlog.compressProg = null;
                const program = readPath('compress');
                if (program === null) { outcome = raise(); break; }
                newlog.compressProg = program;
                log.debug(`compress_prog is now ${program}\n`);
                const base = basenameOf(program);
                for (const [command, extension] of COMPRESS_COMMANDS) {
                  if (command === base) {
                    newlog.compressExt = extension;
                    log.debug(`compress_ext was changed to ${extension}\n`);
                    break;
                  }
                }
                break;
              }
              case 'uncompresscmd': {
                newlog.uncompressProg = null;
                const program = readPath('uncompress');
                if (program === null) { outcome = raise(); break; }
                newlog.uncompressProg = program;
                log.debug(`uncompress_prog is now ${program}\n`);
                break;
              }
              case 'compressoptions': {
                newlog.compressOptions = [];
                const options = isolateLine();
                if (options === null) { outcome = raise(); break; }
                const parsed = poptParseArgvString(options);
                if (!parsed.ok) {
                  log.error(`${configFile}:${lineNum} invalid compression options\n`);
                  outcome = raise();
                  break;
                }
                newlog.compressOptions = parsed.argv;
                log.debug(`compress_options is now ${options}\n`);
                break;
              }
              case 'compressext': {
                newlog.compressExt = null;
                const extension = readPath('compress-ext');
                if (extension === null) { outcome = raise(); break; }
                newlog.compressExt = extension;
                log.debug(`compress_ext is now ${extension}\n`);
                break;
              }
              default:
                log.error(`${configFile}:${lineNum} unknown option '${key}' -- ignoring line\n`);
                if (at(start) !== '\n') state = STATE_SKIP_LINE;
                break;
            }
            if (outcome === 'fail') return fail();
            if (outcome === 'continue') continue;
          } else if (c === '/' || c === '"' || c === '\'' || c === '~') {
            inConfig = false;
            if (newlog !== defConfig) {
              log.error(`${configFile}:${lineNum} unexpected log filename\n`);
              state = STATE_ERROR;
              continue;
            }
            if (newlog.compressProg === null) newlog.compressProg = COMPRESS_COMMAND;
            if (newlog.uncompressProg === null) newlog.uncompressProg = UNCOMPRESS_COMMAND;
            if (newlog.compressExt === null) newlog.compressExt = COMPRESS_EXT;
            newlog = this.newLogInfo(defConfig);

            let globString = '';
            let stateGlob = 0;
            let closed = false;
            for (; start < length && buf[start] !== '\0'; start++) {
              const ch = buf[start];
              if (stateGlob === 0) {
                if (ch === '#') stateGlob = 2;
                else if (!isSpace(ch)) stateGlob = 1;
              } else if (ch === '\n') {
                stateGlob = 0;
              }
              if (stateGlob === 2) continue;
              if (ch === '}') {
                log.error(`${configFile}:${lineNum} unexpected } (missing previous '{')\n`);
                return fail();
              }
              if (ch === '{') { closed = true; break; }
              globString += ch;
            }
            if (!closed) {
              log.error(`${configFile}:${lineNum} missing '{' after log files definition\n`);
              return fail();
            }
            inConfig = true;
            const parsed = poptParseArgvString(globString);
            if (!parsed.ok) {
              log.error(`${configFile}:${lineNum} error parsing filename\n`);
              return fail();
            }
            if (parsed.argv.length < 1) {
              log.error(`${configFile}:${lineNum} { expected after log file name(s)\n`);
              return fail();
            }
            newlog.files = [];
            for (const pattern of parsed.argv) {
              globError = null;
              const matches = this.system.glob(pattern, true);
              for (const path of matches) {
                const stat = this.system.lstat(path);
                if (!isFailure(stat) && stat.type === 'directory') continue;
                let duplicate = false;
                for (const other of this.logs) {
                  if (!other.files.includes(path)) continue;
                  log.error(`${configFile}:${lineNum} duplicate log entry for ${path}\n`);
                  logerror = true;
                  duplicate = true;
                  break;
                }
                if (duplicate) break;
                newlog.files.push(path);
              }
            }
            newlog.pattern = globString;
          } else if (c === '}') {
            if (newlog === defConfig) {
              log.error(`${configFile}:${lineNum} unexpected }\n`);
              return fail();
            }
            if (!inConfig) {
              log.error(`${configFile}:${lineNum} unexpected } (missing previous '{')\n`);
              return fail();
            }
            inConfig = false;
            if (globError !== null) {
              if ((newlog.flags & FLAG.MISSINGOK) === 0) {
                log.error(globError);
                return fail();
              }
              globError = null;
            }
            if (newlog.oldDir !== null && !this.verifyOldDir(configFile, lineNum, newlog)) return fail();
            criteriumSet = false;
            newlog = defConfig;
            state = STATE_DEFINITION_END;
          } else if (c !== '\n') {
            log.error(`${configFile}:${lineNum} lines must begin with a keyword or a filename (possibly in double quotes)\n`);
            if (newlog !== defConfig) { state = STATE_ERROR; continue; }
            return fail();
          }
          break;
        }
        case STATE_SKIP_LINE:
        case STATE_SKIP_LINE | STATE_SKIP_CONFIG:
          if (buf[start] === '\n') state = (state & STATE_SKIP_CONFIG) !== 0 ? STATE_SKIP_CONFIG : STATE_DEFAULT;
          break;
        case STATE_SKIP_LINE | STATE_LOAD_SCRIPT:
          if (buf[start] === '\n') state = STATE_LOAD_SCRIPT;
          break;
        case STATE_SKIP_LINE | STATE_LOAD_SCRIPT | STATE_SKIP_CONFIG:
          if (buf[start] === '\n') state = STATE_LOAD_SCRIPT | STATE_SKIP_CONFIG;
          break;
        case STATE_DEFINITION_END:
        case STATE_DEFINITION_END | STATE_SKIP_CONFIG:
          if (isBlank(buf[start])) continue;
          if (buf[start] !== '\n') {
            log.error(`${configFile}:${lineNum}, unexpected text after }\n`);
            state = STATE_SKIP_LINE | ((state & STATE_SKIP_CONFIG) !== 0 ? STATE_SKIP_CONFIG : 0);
          } else {
            state = (state & STATE_SKIP_CONFIG) !== 0 ? STATE_SKIP_CONFIG : STATE_DEFAULT;
          }
          break;
        case STATE_ERROR:
          log.error(`found error in ${newlog.pattern ?? 'log config'}, skipping\n`);
          logerror = true;
          state = STATE_SKIP_CONFIG;
          break;
        case STATE_LOAD_SCRIPT:
        case STATE_LOAD_SCRIPT | STATE_SKIP_CONFIG: {
          key = isolateWord();
          if (key === null) continue;
          if (key === 'endscript') {
            if ((state & STATE_SKIP_CONFIG) === 0) {
              let endtag = start - 9;
              while (at(endtag) !== '\n') endtag--;
              endtag++;
              if (scriptDest !== null) newlog[scriptDest] = buf.slice(scriptStart, endtag);
              scriptDest = null;
              scriptStart = -1;
            }
            state = (state & STATE_SKIP_CONFIG) !== 0 ? STATE_SKIP_CONFIG : STATE_DEFAULT;
            if ((state & STATE_SKIP_CONFIG) !== 0) scriptStart = -1;
          } else {
            state = (at(start) === '\n' ? 0 : STATE_SKIP_LINE) | STATE_LOAD_SCRIPT
              | ((state & STATE_SKIP_CONFIG) !== 0 ? STATE_SKIP_CONFIG : 0);
          }
          break;
        }
        case STATE_SKIP_CONFIG:
          if (buf[start] === '}') {
            state = STATE_DEFAULT;
            this.freeTailLogs(1);
            newlog = defConfig;
          } else {
            key = isolateWord();
            if (key === null) continue;
            if (key === 'postrotate' || key === 'prerotate' || key === 'firstaction' || key === 'lastaction' || key === 'preremove') {
              state = STATE_LOAD_SCRIPT | STATE_SKIP_CONFIG;
            } else if (at(start) !== '\n') {
              state = STATE_SKIP_LINE | STATE_SKIP_CONFIG;
            }
          }
          break;
        default:
          log.message(6, `${configFile}: ${lineNum}: readConfigFile() unknown state: 0x${state.toString(16)}\n`);
      }
      if (at(start) === '\n') lineNum++;
    }

    if (scriptStart >= 0) {
      log.error(`${configFile}:prerotate, postrotate or preremove without endscript\n`);
      return fail();
    }
    return logerror;
  }

  private verifyOldDir(configFile: string, lineNum: number, newlog: LogInfo): boolean {
    const log = this.log;
    const oldDir = newlog.oldDir as string;
    for (const file of newlog.files) {
      const directory = dirnameOf(file);
      const logDir = this.system.stat(directory);
      if (isFailure(logDir)) {
        if ((newlog.flags & FLAG.MISSINGOK) === 0) {
          log.error(`${configFile}:${lineNum} error verifying log file path ${directory}: ${STRERROR[logDir.errno]}\n`);
          return false;
        }
        log.debug(`${configFile}:${lineNum} verifying log file path failed ${directory}: ${STRERROR[logDir.errno]}, log is probably missing, but missingok is set, so this is not an error.\n`);
        continue;
      }
      const target = oldDir[0] !== '/' ? `${directory}/${oldDir}` : oldDir;
      let oldDirStat = this.system.stat(target);
      if (isFailure(oldDirStat)) {
        if (oldDirStat.errno === 'ENOENT' && (newlog.flags & FLAG.OLDDIRCREATE) !== 0) {
          if (!this.makePath(target, newlog.olddirMode, newlog.olddirUid, newlog.olddirGid)) return false;
          oldDirStat = this.system.stat(target);
          if (isFailure(oldDirStat)) {
            log.error(`${configFile}:${lineNum} error verifying created olddir path ${target}: ${STRERROR[oldDirStat.errno]}\n`);
            return false;
          }
        } else {
          log.error(`${configFile}:${lineNum} error verifying olddir path ${target}: ${STRERROR[oldDirStat.errno]}\n`);
          return false;
        }
      }
      if (logDir.dev !== oldDirStat.dev && (newlog.flags & (FLAG.COPYTRUNCATE | FLAG.COPY | FLAG.TMPFILENAME)) === 0) {
        log.error(`${configFile}:${lineNum} olddir ${oldDir} and log file ${file} are on different devices\n`);
        return false;
      }
    }
    return true;
  }

  private makeDirectory(path: string, mode: number, uid: number, gid: number): boolean {
    const log = this.log;
    const failure = this.system.mkdir(path, mode, uid, gid);
    if (failure === null) return true;
    if (failure === 'EEXIST') {
      const stat = this.system.stat(path);
      if (!isFailure(stat) && stat.type === 'directory') return true;
      log.error(`path ${path} already exists, but it is not a directory\n`);
      return false;
    }
    log.error(`error creating ${path}: ${STRERROR[failure]}\n`);
    return false;
  }

  private makePath(path: string, mode: number, uid: number, gid: number): boolean {
    let offset = 0;
    while (offset < path.length) {
      const slash = path.indexOf('/', offset);
      if (slash < 0) break;
      if (slash !== offset) {
        if (!this.makeDirectory(path.slice(0, slash), mode, uid, gid)) return false;
      }
      offset = slash + 1;
    }
    return this.makeDirectory(path, mode, uid, gid);
  }
}

export { MESS_DEBUG, MESS_ERROR, MESS_NORMAL };
