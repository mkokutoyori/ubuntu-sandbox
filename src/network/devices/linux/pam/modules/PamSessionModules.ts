import { parseOctal, searchKey } from '../PamFileSearch';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';

const LOGIN_DEFS = '/etc/login.defs';
const LOGIN_CONF = '/etc/default/login';
const SHELLS_FILE = '/etc/shells';
const DEFAULT_SHELL = '/bin/sh';
const S_IWOTH = 0o002;

interface UmaskOptions {
  debug: boolean;
  usergroups: boolean;
  silent: boolean;
  umask: string | null;
}

function parseUmaskOptions(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): UmaskOptions {
  const options: UmaskOptions = { debug: false, usergroups: false, silent: false, umask: null };
  for (const argument of args) {
    if (argument === '') continue;
    const lowered = argument.toLowerCase();
    if (lowered === 'debug') options.debug = true;
    else if (lowered.startsWith('umask=')) options.umask = argument.slice(6);
    else if (lowered === 'usergroups') options.usergroups = true;
    else if (lowered === 'nousergroups') options.usergroups = false;
    else if (lowered === 'silent') options.silent = true;
    else pamh.syslog('err', `Unknown option: \`${argument}'`);
  }
  if (options.umask === null) options.umask = searchKey((path) => pamh.host.readFile(path), LOGIN_DEFS, 'UMASK');
  if (options.umask === null) options.umask = searchKey((path) => pamh.host.readFile(path), LOGIN_CONF, 'UMASK');
  return options;
}

function niceBy(pamh: PamHandle<LinuxPamHost>, increment: number): boolean {
  const state = pamh.host.process;
  const wanted = Math.max(-20, Math.min(19, state.priority + increment));
  if (increment < 0 && pamh.host.caller.euid !== 0) return false;
  state.priority = wanted;
  return true;
}

function* applyGecos(
  pamh: PamHandle<LinuxPamHost>, options: UmaskOptions, user: { name: string; uid: number; gid: number; gecos: string },
): PamConversationFlow<void> {
  const state = pamh.host.process;
  if (options.usergroups && user.uid !== 0) {
    const group = pamh.host.accounts.findGroupByGid(user.gid);
    if (group !== null && group.name === user.name) {
      const old = state.umask;
      state.umask = (old & ~0o070) | ((old >> 3) & 0o070);
    }
  }
  for (const field of user.gecos.split(',')) {
    const lowered = field.toLowerCase();
    if (lowered.startsWith('umask=')) {
      state.umask = (parseInt(field.slice(6), 8) || 0) & 0o777;
    } else if (lowered.startsWith('pri=')) {
      if (!niceBy(pamh, parseInt(field.slice(4), 10) || 0)) {
        if (!options.silent || options.debug) yield* pamh.notify('error', 'nice failed: Operation not permitted\n');
        pamh.syslog('err', 'nice failed: Operation not permitted');
      }
    } else if (lowered.startsWith('ulimit=')) {
      const bytes = 512 * (parseInt(field.slice(7), 10) || 0);
      const current = state.limits.get('fsize');
      if (current !== undefined && bytes > current.hard && pamh.host.caller.euid !== 0) {
        if (!options.silent || options.debug) yield* pamh.notify('error', 'setrlimit failed: Operation not permitted\n');
        pamh.syslog('err', 'setrlimit failed: Operation not permitted');
      } else {
        state.limits.set('fsize', { soft: bytes, hard: bytes });
      }
    }
  }
}

function* umaskOpenSession(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const options = parseUmaskOptions(pamh, args);
  if ((flags & PamFlag.SILENT) !== 0) options.silent = true;
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) {
    pamh.syslog('notice', `cannot determine user name: ${lookup.code}`);
    return lookup.code;
  }
  const user = pamh.host.accounts.findUser(lookup.value);
  if (user === null) {
    pamh.syslog('notice', `account for ${lookup.value} not found`);
    return PamReturn.USER_UNKNOWN;
  }
  if (options.umask !== null) {
    const mask = parseOctal(options.umask);
    if (mask !== null) pamh.host.process.umask = mask & 0o777;
  }
  yield* applyGecos(pamh, options, user);
  return PamReturn.SUCCESS;
}

export const pamUmaskModule: PamModuleImplementation<LinuxPamHost> = {
  openSession: umaskOpenSession,
  closeSession: () => PamReturn.SUCCESS,
};

function* setLoginUid(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): PamConversationFlow<number> {
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) {
    pamh.syslog('notice', 'cannot determine user name');
    return PamReturn.SESSION_ERR;
  }
  const user = pamh.host.accounts.findUser(lookup.value);
  if (user === null) {
    pamh.syslog('notice', `error: login user-name '${lookup.value}' does not exist`);
    return PamReturn.SESSION_ERR;
  }
  const state = pamh.host.process;
  if (state.loginUid !== null && state.loginUid !== user.uid && pamh.host.caller.euid !== 0) {
    pamh.syslog('err', 'Error writing /proc/self/loginuid: Operation not permitted');
    pamh.syslog('err', 'set_loginuid failed');
    return PamReturn.SESSION_ERR;
  }
  state.loginUid = user.uid;
  if (args.includes('require_auditd') && !pamh.host.auditdRunning()) {
    pamh.syslog('err', 'required running auditd not detected');
    return PamReturn.SESSION_ERR;
  }
  return PamReturn.SUCCESS;
}

export const pamLoginuidModule: PamModuleImplementation<LinuxPamHost> = {
  acctMgmt: (pamh, _flags, args) => setLoginUid(pamh, args),
  openSession: (pamh, _flags, args) => setLoginUid(pamh, args),
  closeSession: () => PamReturn.SUCCESS,
};

function* shellCheck(pamh: PamHandle<LinuxPamHost>): PamConversationFlow<number> {
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) return PamReturn.SERVICE_ERR;
  const user = pamh.host.accounts.findUser(lookup.value);
  if (user === null) return PamReturn.AUTH_ERR;
  const shell = user.shell === '' ? DEFAULT_SHELL : user.shell;
  const stat = pamh.host.files.stat(SHELLS_FILE);
  if (stat === null) {
    pamh.syslog('err', `Cannot stat ${SHELLS_FILE}: No such file or directory`);
    return PamReturn.AUTH_ERR;
  }
  if ((stat.mode & S_IWOTH) !== 0 || !stat.regular) {
    pamh.syslog('err', `${SHELLS_FILE} is either world writable or not a normal file`);
    return PamReturn.AUTH_ERR;
  }
  const content = pamh.host.readFile(SHELLS_FILE);
  if (content === null) {
    pamh.syslog('err', `Error opening ${SHELLS_FILE}: Permission denied`);
    return PamReturn.SERVICE_ERR;
  }
  return content.split('\n').some((line) => line === shell) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
}

export const pamShellsModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh) => shellCheck(pamh),
  setcred: () => PamReturn.SUCCESS,
  acctMgmt: (pamh) => shellCheck(pamh),
};

function faildelayAuthenticate(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): number {
  let debug = false;
  let delay = -1;
  for (const argument of args) {
    const match = /^delay=(-?\d+)/.exec(argument);
    if (match !== null) delay = parseInt(match[1], 10);
    else if (argument === 'debug') debug = true;
    else pamh.syslog('err', `unknown option; ${argument}`);
  }
  if (delay === -1) {
    const value = searchKey((path) => pamh.host.readFile(path), LOGIN_DEFS, 'FAIL_DELAY');
    if (value === null) return PamReturn.IGNORE;
    const parsed = /^\s*([+-]?\d+)/.exec(value);
    if (parsed === null) {
      pamh.syslog('err', `FAIL_DELAY=${value} in ${LOGIN_DEFS} not valid`);
      return PamReturn.IGNORE;
    }
    delay = (parseInt(parsed[1], 10) & 0o777) * 1_000_000;
  }
  if (debug) pamh.syslog('debug', `setting fail delay to ${delay}`);
  pamh.requestFailDelay(delay);
  return PamReturn.IGNORE;
}

export const pamFaildelayModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh, _flags, args) => faildelayAuthenticate(pamh, args),
  setcred: () => PamReturn.IGNORE,
};
