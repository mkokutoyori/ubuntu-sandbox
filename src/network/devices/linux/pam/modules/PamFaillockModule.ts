import type { LinuxPamHost } from '../PamLinuxHost';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';

export const FAILLOCK_DEFAULT_CONF = '/etc/security/faillock.conf';
export const FAILLOCK_DEFAULT_TALLYDIR = '/var/run/faillock';

export const TALLY_STATUS_VALID = 0x1;
export const TALLY_STATUS_RHOST = 0x2;
export const TALLY_STATUS_TTY = 0x4;

const MAX_TIME_INTERVAL = 604800;

export interface TallyRecord {
  source: string;
  status: number;
  time: number;
}

type Action = 'preauth' | 'authsucc' | 'authfail';

interface Options {
  action: Action;
  denyRoot: boolean;
  audit: boolean;
  silent: boolean;
  noLogInfo: boolean;
  unlocked: boolean;
  localOnly: boolean;
  deny: number;
  failInterval: number;
  unlockTime: number;
  rootUnlockTime: number;
  dir: string;
  adminGroup: string | null;
  user: string;
  uid: number;
  isAdmin: boolean;
  failures: number;
  latestTime: number;
  now: number;
}

export function parseTally(content: string | null): TallyRecord[] {
  if (content === null) return [];
  const records: TallyRecord[] = [];
  for (const line of content.split('\n')) {
    const match = /^(\d+) (\d+) ?(.*)$/.exec(line);
    if (match !== null) records.push({ time: Number(match[1]), status: Number(match[2]), source: match[3] });
  }
  return records;
}

export function renderTally(records: readonly TallyRecord[]): string {
  return records.map((record) => `${record.time} ${record.status} ${record.source}`).join('\n') + (records.length > 0 ? '\n' : '');
}

export function tallyPath(dir: string, user: string): string {
  return `${dir.endsWith('/') ? dir : `${dir}/`}${user}`;
}

function setOption(pamh: PamHandle<LinuxPamHost>, options: Options, name: string, value: string): void {
  const number = (): number | null => (/^\d+$/.test(value) ? Number.parseInt(value, 10) : null);
  switch (name) {
    case 'dir':
      if (!value.startsWith('/')) pamh.syslog('err', `Tally directory is not absolute path (${value}); keeping default`);
      else options.dir = value;
      break;
    case 'deny': {
      const parsed = number();
      if (parsed === null) pamh.syslog('err', 'Bad number supplied for deny argument');
      else options.deny = parsed & 0xffff;
      break;
    }
    case 'fail_interval': {
      const parsed = number();
      if (parsed === null || parsed > MAX_TIME_INTERVAL) pamh.syslog('err', 'Bad number supplied for fail_interval argument');
      else options.failInterval = parsed;
      break;
    }
    case 'unlock_time': {
      const parsed = number();
      if (value === 'never') options.unlockTime = 0;
      else if (parsed === null || parsed > MAX_TIME_INTERVAL) pamh.syslog('err', 'Bad number supplied for unlock_time argument');
      else options.unlockTime = parsed;
      break;
    }
    case 'root_unlock_time': {
      const parsed = number();
      if (value === 'never') options.rootUnlockTime = 0;
      else if (parsed === null || parsed > MAX_TIME_INTERVAL) pamh.syslog('err', 'Bad number supplied for root_unlock_time argument');
      else options.rootUnlockTime = parsed;
      break;
    }
    case 'admin_group': options.adminGroup = value; break;
    case 'even_deny_root': options.denyRoot = true; break;
    case 'audit': options.audit = true; break;
    case 'silent': options.silent = true; break;
    case 'no_log_info': options.noLogInfo = true; break;
    case 'local_users_only': options.localOnly = true; break;
    default: pamh.syslog('err', `Unknown option: ${name}`);
  }
}

function readConfigFile(pamh: PamHandle<LinuxPamHost>, options: Options, path: string, isDefault: boolean): number {
  const content = pamh.host.readFile(path);
  if (content === null) return isDefault ? PamReturn.SUCCESS : PamReturn.SERVICE_ERR;
  for (const raw of content.split('\n')) {
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/\s+$/, '').replace(/^\s+/, '');
    if (line === '') continue;
    const match = /^([^\s=]+)(?:\s*=\s*|\s+)?(.*)$/.exec(line);
    if (match !== null) setOption(pamh, options, match[1], match[2]);
  }
  return PamReturn.SUCCESS;
}

function parseArguments(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): { options: Options; code: number } {
  const options: Options = {
    action: 'preauth', denyRoot: false, audit: false, silent: false, noLogInfo: false, unlocked: false, localOnly: false,
    deny: 3, failInterval: 900, unlockTime: 600, rootUnlockTime: MAX_TIME_INTERVAL + 1, dir: FAILLOCK_DEFAULT_TALLYDIR,
    adminGroup: null, user: '', uid: 0, isAdmin: false, failures: 0, latestTime: 0, now: 0,
  };
  let conf = FAILLOCK_DEFAULT_CONF;
  let customConf = false;
  for (const argument of args) {
    if (argument.startsWith('conf=')) { conf = argument.slice(5); customConf = true; }
  }
  const code = readConfigFile(pamh, options, conf, !customConf);
  if (code !== PamReturn.SUCCESS) {
    pamh.syslog('err', 'Configuration file missing or broken');
    return { options, code };
  }
  for (const argument of args) {
    if (argument === 'preauth' || argument === 'authfail' || argument === 'authsucc') {
      options.action = argument;
    } else {
      const equals = argument.indexOf('=');
      setOption(pamh, options, equals >= 0 ? argument.slice(0, equals) : argument, equals >= 0 ? argument.slice(equals + 1) : '');
    }
  }
  if (options.rootUnlockTime === MAX_TIME_INTERVAL + 1) options.rootUnlockTime = options.unlockTime;
  if ((flags & PamFlag.SILENT) !== 0) options.silent = true;
  return { options, code: PamReturn.SUCCESS };
}

function* identifyUser(pamh: PamHandle<LinuxPamHost>, options: Options): PamConversationFlow<number> {
  const user = yield* pamh.getUser();
  if (user.code !== PamReturn.SUCCESS || user.value === null) return user.code;
  if (user.value === '') return PamReturn.IGNORE;
  const record = pamh.host.accounts.findUser(user.value);
  if (record === null) {
    pamh.syslog('notice', options.audit ? `User unknown: ${user.value}` : 'User unknown');
    return PamReturn.IGNORE;
  }
  options.user = user.value;
  options.uid = record.uid;
  if (record.uid === 0) {
    options.isAdmin = true;
    return PamReturn.SUCCESS;
  }
  if (options.adminGroup !== null && options.adminGroup !== '') {
    options.isAdmin = pamh.host.accounts.groupNames(user.value).includes(options.adminGroup);
  }
  return PamReturn.SUCCESS;
}

function isLocalUser(pamh: PamHandle<LinuxPamHost>, user: string): boolean {
  return pamh.host.accounts.findUser(user) !== null;
}

function checkTally(pamh: PamHandle<LinuxPamHost>, options: Options): { code: number; records: TallyRecord[]; existed: boolean } {
  options.now = Math.floor(pamh.host.now() / 1000);
  const path = tallyPath(options.dir, options.user);
  const content = pamh.host.readFile(path);
  if (content === null) return { code: PamReturn.SUCCESS, records: [], existed: false };
  const records = parseTally(content);
  if (options.isAdmin && !options.denyRoot) return { code: PamReturn.SUCCESS, records, existed: true };
  let latest = 0;
  for (const record of records) {
    if ((record.status & TALLY_STATUS_VALID) !== 0 && record.time > latest) latest = record.time;
  }
  options.latestTime = latest;
  let failures = 0;
  for (const record of records) {
    if ((record.status & TALLY_STATUS_VALID) !== 0 && latest - record.time < options.failInterval) failures++;
  }
  options.failures = failures;
  if (options.deny !== 0 && failures >= options.deny) {
    const unlockAfter = options.isAdmin ? options.rootUnlockTime : options.unlockTime;
    if (unlockAfter !== 0 && latest + unlockAfter < options.now) {
      options.unlocked = true;
      return { code: PamReturn.SUCCESS, records, existed: true };
    }
    return { code: PamReturn.AUTH_ERR, records, existed: true };
  }
  return { code: PamReturn.SUCCESS, records, existed: true };
}

function resetTally(pamh: PamHandle<LinuxPamHost>, options: Options): void {
  const files = pamh.host.files;
  files.mkdirp(options.dir);
  files.writeFile(tallyPath(options.dir, options.user), '');
}

function writeTally(pamh: PamHandle<LinuxPamHost>, options: Options, records: TallyRecord[]): number {
  let oldestTime = 0;
  let oldest = 0;
  let failures = 0;
  records.forEach((record, index) => {
    if (oldestTime === 0 || record.time < oldestTime) { oldestTime = record.time; oldest = index; }
    if (options.unlocked || options.now - record.time >= options.failInterval) record.status &= ~TALLY_STATUS_VALID;
    else failures++;
  });
  if (oldest >= records.length || (records[oldest].status & TALLY_STATUS_VALID) !== 0) {
    oldest = records.length;
    records.push({ source: '', status: 0, time: 0 });
  }
  let source = pamh.rhost;
  let status = TALLY_STATUS_VALID;
  if (source !== null) {
    status |= TALLY_STATUS_RHOST;
  } else if (pamh.tty !== null) {
    source = pamh.tty;
    status |= TALLY_STATUS_TTY;
  } else {
    source = pamh.service;
  }
  records[oldest] = { source: source.slice(0, 51), status, time: options.now };
  failures++;
  if (options.deny !== 0 && failures === options.deny && !options.noLogInfo) {
    pamh.syslog('info', `Consecutive login failures for user ${options.user} account temporarily locked`);
  }
  const files = pamh.host.files;
  files.mkdirp(options.dir);
  return files.writeFile(tallyPath(options.dir, options.user), renderTally(records)) ? PamReturn.SUCCESS : PamReturn.SYSTEM_ERR;
}

function* lockedMessage(pamh: PamHandle<LinuxPamHost>, options: Options): PamConversationFlow<void> {
  if (options.silent) return;
  const unlockAfter = options.isAdmin ? options.rootUnlockTime : options.unlockTime;
  let left = options.latestTime + unlockAfter - options.now;
  yield* pamh.notify('info', `The account is locked due to ${options.failures} failed logins.`);
  if (left > 0) {
    left = Math.floor((left + 59) / 60);
    yield* pamh.notify('info', `(${left} minutes left to unlock)`);
  }
}

function* authenticate(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const parsed = parseArguments(pamh, flags, args);
  if (parsed.code !== PamReturn.SUCCESS) return parsed.code;
  const options = parsed.options;
  let result = yield* identifyUser(pamh, options);
  if (result !== PamReturn.SUCCESS) return result;
  if (options.localOnly && !isLocalUser(pamh, options.user)) return PamReturn.SUCCESS;
  switch (options.action) {
    case 'preauth': {
      const checked = checkTally(pamh, options);
      result = checked.code;
      if (result === PamReturn.AUTH_ERR && !options.silent) yield* lockedMessage(pamh, options);
      break;
    }
    case 'authsucc': {
      const checked = checkTally(pamh, options);
      result = checked.code;
      if (result === PamReturn.SUCCESS) resetTally(pamh, options);
      break;
    }
    case 'authfail': {
      const checked = checkTally(pamh, options);
      result = checked.code;
      if (result === PamReturn.SUCCESS) {
        result = PamReturn.IGNORE;
        writeTally(pamh, options, checked.records);
      }
      break;
    }
  }
  return result;
}

function* acctMgmt(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const parsed = parseArguments(pamh, flags, args);
  if (parsed.code !== PamReturn.SUCCESS) return parsed.code;
  const options = parsed.options;
  options.action = 'authsucc';
  const result = yield* identifyUser(pamh, options);
  if (result !== PamReturn.SUCCESS) return result;
  if (!options.localOnly || isLocalUser(pamh, options.user)) {
    checkTally(pamh, options);
    resetTally(pamh, options);
  }
  return result;
}

export const pamFaillockModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate,
  setcred: () => PamReturn.SUCCESS,
  acctMgmt,
};
