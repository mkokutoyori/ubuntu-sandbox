import type { LinuxPamHost, PamUserRecord } from '../PamLinuxHost';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { PamModuleImplementation } from '../PamModule';
import { PamReturn } from '../PamReturnCode';

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else if (character === '[') {
      const end = pattern.indexOf(']', index + 2);
      if (end < 0) { source += '\\['; continue; }
      let set = pattern.slice(index + 1, end);
      if (set.startsWith('!')) set = `^${set.slice(1)}`;
      source += `[${set.replace(/\\/g, '\\\\')}]`;
      index = end;
    } else if (character === '\\' && index + 1 < pattern.length) {
      index++;
      source += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 's');
}

export function fnmatch(pattern: string, text: string): boolean {
  return globToRegExp(pattern).test(text);
}

function userInGroup(pamh: PamHandle<LinuxPamHost>, user: string, group: string): boolean {
  return pamh.host.accounts.groupNames(user).includes(group);
}

const WHEEL_DEBUG = 0x1;
const WHEEL_USE_UID = 0x2;
const WHEEL_TRUST = 0x4;
const WHEEL_DENY = 0x10;
const WHEEL_ROOT_ONLY = 0x20;

function* wheelCheck(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): PamConversationFlow<number> {
  let control = 0;
  let useGroup = '';
  for (const argument of args) {
    if (argument === 'debug') control |= WHEEL_DEBUG;
    else if (argument === 'use_uid') control |= WHEEL_USE_UID;
    else if (argument === 'trust') control |= WHEEL_TRUST;
    else if (argument === 'deny') control |= WHEEL_DENY;
    else if (argument === 'root_only') control |= WHEEL_ROOT_ONLY;
    else if (argument.startsWith('group=')) useGroup = argument.slice(6);
    else pamh.syslog('err', `unknown option: ${argument}`);
  }
  const debug = (control & WHEEL_DEBUG) !== 0;
  const user = yield* pamh.getUser();
  if (user.code !== PamReturn.SUCCESS || user.value === null) {
    if (debug) pamh.syslog('debug', `cannot determine user name: ${user.code}`);
    return PamReturn.SERVICE_ERR;
  }
  const username = user.value;
  const target = pamh.host.accounts.findUser(username);
  if (target === null) {
    if (debug) pamh.syslog('notice', `unknown user ${username}`);
    return PamReturn.USER_UNKNOWN;
  }
  if ((control & WHEEL_ROOT_ONLY) !== 0 && target.uid !== 0) return PamReturn.IGNORE;

  let invoker: PamUserRecord | null;
  let fromsu: string | null;
  if ((control & WHEEL_USE_UID) !== 0) {
    invoker = pamh.host.accounts.findUserByUid(pamh.host.caller.uid);
    fromsu = invoker === null ? null : invoker.name;
  } else {
    fromsu = pamh.host.caller.loginName === '' ? null : pamh.host.caller.loginName;
    invoker = fromsu === null ? null : pamh.host.accounts.findUser(fromsu);
  }
  if (fromsu === null || invoker === null) {
    if (debug) pamh.syslog('notice', 'who is running me ?!');
    return PamReturn.SERVICE_ERR;
  }

  const group = useGroup === ''
    ? (pamh.host.accounts.findGroup('wheel') ?? pamh.host.accounts.findGroupByGid(0))
    : pamh.host.accounts.findGroup(useGroup);
  if (group === null || (group.members.length === 0 && invoker.gid !== group.gid)) {
    if (debug) pamh.syslog('notice', useGroup === '' ? 'no members in a GID 0 group' : `no members in '${useGroup}' group`);
    return (control & WHEEL_DENY) !== 0 ? PamReturn.IGNORE : PamReturn.AUTH_ERR;
  }

  const member = group.members.includes(fromsu) || invoker.gid === group.gid;
  let retval: number;
  if (member) {
    if ((control & WHEEL_DENY) !== 0) retval = PamReturn.PERM_DENIED;
    else if ((control & WHEEL_TRUST) !== 0) retval = PamReturn.SUCCESS;
    else retval = PamReturn.IGNORE;
  } else if ((control & WHEEL_DENY) !== 0) {
    retval = (control & WHEEL_TRUST) !== 0 ? PamReturn.SUCCESS : PamReturn.IGNORE;
  } else {
    retval = PamReturn.PERM_DENIED;
  }
  if (debug) {
    if (retval === PamReturn.IGNORE) pamh.syslog('notice', `Ignoring access request '${fromsu}' for '${username}'`);
    else pamh.syslog('notice', `Access ${retval !== PamReturn.SUCCESS ? 'denied' : 'granted'} to '${fromsu}' for '${username}'`);
  }
  return retval;
}

export const pamWheelModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh, _flags, args) => wheelCheck(pamh, args),
  setcred: () => PamReturn.SUCCESS,
  acctMgmt: (pamh, _flags, args) => wheelCheck(pamh, args),
};

function evaluateNumbers(pamh: PamHandle<LinuxPamHost>, left: string, right: string, compare: (a: bigint, b: bigint) => boolean): number {
  const parse = (text: string): bigint | null => {
    const trimmed = text.trim();
    if (!/^[+-]?(0x[0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(trimmed)) return null;
    return BigInt(trimmed.startsWith('0') && !/^0x/i.test(trimmed) && trimmed.length > 1 ? `0o${trimmed.slice(1)}` : trimmed);
  };
  const a = parse(left);
  const b = parse(right);
  let failed = false;
  if (a === null) { pamh.syslog('info', `"${left}" is not a number`); failed = true; }
  if (b === null) { pamh.syslog('info', `"${right}" is not a number`); failed = true; }
  if (failed || a === null || b === null) return PamReturn.SERVICE_ERR;
  return compare(a, b) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
}

function inList(left: string, right: string): boolean {
  return right.split(':').includes(left);
}

function groupList(pamh: PamHandle<LinuxPamHost>, user: string, groups: string): boolean {
  return groups.split(':').filter((name) => name !== '').some((name) => userInGroup(pamh, user, name));
}

function succeedIfEvaluate(
  pamh: PamHandle<LinuxPamHost>, debug: boolean, leftArgument: string, qualifier: string, right: string,
  state: { record: PamUserRecord | null }, userArgument: string,
): number {
  let user = userArgument;
  let left: string | null = null;
  const attribute = leftArgument;
  const key = leftArgument.toLowerCase();
  if (key === 'login' || key === 'name' || key === 'user') left = user;
  const needsRecord = ['uid', 'gid', 'shell', 'home', 'dir', 'homedir'].includes(key);
  if (state.record === null && needsRecord) {
    state.record = pamh.host.accounts.findUser(user);
    if (state.record === null) return PamReturn.USER_UNKNOWN;
  }
  if (key === 'uid') left = String(state.record?.uid);
  else if (key === 'gid') left = String(state.record?.gid);
  else if (key === 'shell') left = state.record?.shell ?? '';
  else if (key === 'home' || key === 'dir' || key === 'homedir') left = state.record?.home ?? '';
  else if (key === 'service') left = pamh.service;
  else if (key === 'ruser') { left = pamh.ruser ?? ''; user = left; }
  else if (key === 'rhost') left = pamh.rhost ?? '';
  else if (key === 'tty') left = pamh.tty ?? '';
  if (left === null) {
    pamh.syslog('err', `unknown attribute "${leftArgument}"`);
    return PamReturn.SERVICE_ERR;
  }
  if (debug) pamh.syslog('debug', `'${attribute}' resolves to '${left}'`);
  const value = left;
  switch (qualifier.toLowerCase()) {
    case '<': case 'lt': return evaluateNumbers(pamh, value, right, (a, b) => a < b);
    case '<=': case 'le': return evaluateNumbers(pamh, value, right, (a, b) => a <= b);
    case '>': case 'gt': return evaluateNumbers(pamh, value, right, (a, b) => a > b);
    case '>=': case 'ge': return evaluateNumbers(pamh, value, right, (a, b) => a >= b);
    case 'eq': return evaluateNumbers(pamh, value, right, (a, b) => a === b);
    case '=': return value === right ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
    case 'ne': return evaluateNumbers(pamh, value, right, (a, b) => a !== b);
    case '!=': return value !== right ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
    case '=~': case 'glob': return fnmatch(right, value) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
    case '!~': case 'noglob': return !fnmatch(right, value) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
    case 'in': return inList(value, right) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
    case 'notin': return !inList(value, right) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
    case 'ingroup': return groupList(pamh, user, right) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
    case 'notingroup': return !groupList(pamh, user, right) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
    case 'innetgr': case 'notinnetgr':
      pamh.syslog('err', 'pam_succeed_if does not have netgroup support');
      return PamReturn.AUTH_ERR;
    default: return PamReturn.SERVICE_ERR;
  }
}

function* succeedIf(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): PamConversationFlow<number> {
  let quietFail = false;
  let quietSuccess = false;
  let audit = false;
  let useUid = false;
  let debug = false;
  const words: string[] = [];
  for (const argument of args) {
    if (argument === 'debug') debug = true;
    else if (argument === 'use_uid') useUid = true;
    else if (argument === 'quiet') { quietFail = true; quietSuccess = true; }
    else if (argument === 'quiet_fail') quietFail = true;
    else if (argument === 'quiet_success') quietSuccess = true;
    else if (argument === 'audit') audit = true;
    else words.push(argument);
  }
  const state: { record: PamUserRecord | null } = { record: null };
  let user: string;
  if (useUid) {
    state.record = pamh.host.accounts.findUserByUid(pamh.host.caller.uid);
    if (state.record === null) {
      pamh.syslog('err', `error retrieving information about user ${pamh.host.caller.uid}`);
      return PamReturn.USER_UNKNOWN;
    }
    user = state.record.name;
  } else {
    const lookup = yield* pamh.getUser();
    if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) {
      pamh.syslog('notice', `cannot determine user name: ${lookup.code}`);
      return lookup.code;
    }
    user = lookup.value;
  }
  let result: number = PamReturn.SUCCESS;
  let count = 0;
  let index = 0;
  for (; index + 3 <= words.length; index += 3) {
    const [left, qualifier, right] = [words[index], words[index + 1], words[index + 2]];
    count++;
    result = succeedIfEvaluate(pamh, debug, left, qualifier, right, state, user);
    if (result === PamReturn.USER_UNKNOWN && audit) pamh.syslog('notice', `error retrieving information about user ${user}`);
    if (result !== PamReturn.SUCCESS) {
      if (!quietFail && result !== PamReturn.USER_UNKNOWN) {
        pamh.syslog('info', `requirement "${left} ${qualifier} ${right}" not met by user "${user}"`);
      }
      return result;
    }
    if (!quietSuccess) pamh.syslog('info', `requirement "${left} ${qualifier} ${right}" was met by user "${user}"`);
  }
  if (words.length % 3 !== 0) {
    pamh.syslog('err', 'incomplete condition detected');
    return PamReturn.SERVICE_ERR;
  }
  if (count === 0) pamh.syslog('info', 'no condition detected; module succeeded');
  return result;
}

export const pamSucceedIfModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh, _flags, args) => succeedIf(pamh, args),
  setcred: () => PamReturn.IGNORE,
  acctMgmt: (pamh, _flags, args) => succeedIf(pamh, args),
  openSession: (pamh, _flags, args) => succeedIf(pamh, args),
  closeSession: (pamh, _flags, args) => succeedIf(pamh, args),
  chauthtok: (pamh, _flags, args) => succeedIf(pamh, args),
};

type ListItem = 'user' | 'tty' | 'rhost' | 'ruser' | 'group' | 'shell';

function* listfileCheck(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): PamConversationFlow<number> {
  let onerr: number = PamReturn.SERVICE_ERR;
  let sense: number | null = null;
  let quiet = false;
  let file: string | null = null;
  let item: ListItem | null = null;
  let applyKind: 'none' | 'user' | 'group' | null = null;
  let applyValue = '';
  for (const argument of args) {
    if (argument === 'quiet') { quiet = true; continue; }
    const equals = argument.indexOf('=');
    if (equals < 0) {
      pamh.syslog('err', `Bad option: "${argument}"`);
      continue;
    }
    const name = argument.slice(0, equals);
    const value = argument.slice(equals + 1);
    if (name === 'onerr') {
      if (value === 'succeed') onerr = PamReturn.SUCCESS;
      else if (value === 'fail') onerr = PamReturn.SERVICE_ERR;
      else return PamReturn.SERVICE_ERR;
    } else if (name === 'sense') {
      if (value === 'allow') sense = 0;
      else if (value === 'deny') sense = 1;
      else return onerr;
    } else if (name === 'file') {
      file = value;
    } else if (name === 'item') {
      item = (['user', 'tty', 'rhost', 'ruser', 'group', 'shell'] as const).find((candidate) => candidate === value) ?? null;
    } else if (name === 'apply') {
      applyKind = 'none';
      if (value.startsWith('@')) { applyKind = 'group'; applyValue = value.slice(1); } else { applyKind = 'user'; applyValue = value; }
    } else {
      pamh.syslog('err', `Unknown option: ${name}`);
      return onerr;
    }
  }
  if (item === null) {
    pamh.syslog('err', 'Unknown item or item not specified');
    return onerr;
  }
  if (file === null) {
    pamh.syslog('err', 'List filename not specified');
    return onerr;
  }
  if (sense === null) {
    pamh.syslog('err', 'Unknown sense or sense not specified');
    return onerr;
  }
  if (applyKind === 'none' || (applyKind !== null && applyValue === '')) {
    pamh.syslog('err', 'Invalid usage for apply= parameter');
    return onerr;
  }
  if (applyKind !== null && (item === 'user' || item === 'ruser' || item === 'group')) {
    pamh.syslog('warning', 'Non-sense use for apply= parameter');
    applyKind = null;
  }
  const lookup = yield* pamh.getUser();
  if (lookup.code === PamReturn.SUCCESS && lookup.value !== null && lookup.value !== '') {
    if (applyKind === 'user' && lookup.value !== applyValue) return PamReturn.IGNORE;
    if (applyKind === 'group' && !userInGroup(pamh, lookup.value, applyValue)) return PamReturn.IGNORE;
  }

  let subject: string | null;
  switch (item) {
    case 'user': case 'group': case 'shell': subject = pamh.user; break;
    case 'tty': subject = pamh.tty; break;
    case 'rhost': subject = pamh.rhost; break;
    case 'ruser': subject = pamh.ruser; break;
  }
  if ((item === 'user' || item === 'group' || item === 'shell') && subject === null) {
    const again = yield* pamh.getUser();
    if (again.code !== PamReturn.SUCCESS) return PamReturn.SERVICE_ERR;
    subject = again.value;
  }
  if (item === 'tty' && subject !== null && subject.startsWith('/dev/')) subject = subject.slice(5);
  if (subject === null || subject.length === 0) return sense !== 0 ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
  if (item === 'shell') {
    const record = pamh.host.accounts.findUser(subject);
    if (record === null) {
      pamh.syslog('notice', `getpwnam(${subject}) failed`);
      return onerr;
    }
    subject = record.shell;
  }

  const stat = pamh.host.files.stat(file);
  if (stat === null) {
    if (!quiet) pamh.syslog('err', `Couldn't open ${file}`);
    return onerr;
  }
  if ((stat.mode & 0o002) !== 0 || !stat.regular) {
    pamh.syslog('err', `${file} is either world writable or not a normal file`);
    return onerr;
  }
  const content = pamh.host.readFile(file);
  if (content === null) {
    if (!quiet) pamh.syslog('err', `Error opening ${file}`);
    return onerr;
  }
  let matched = false;
  for (const raw of content.split('\n')) {
    let line = raw;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') continue;
    if (item === 'tty' && line.startsWith('/dev/')) line = line.slice(5);
    matched = item === 'group' ? userInGroup(pamh, subject, line) : line === subject;
    if (matched) break;
  }
  const retval = matched ? 0 : 1;
  if ((sense !== 0 && retval !== 0) || (sense === 0 && retval === 0)) return PamReturn.SUCCESS;
  if (!quiet) pamh.syslog('notice', `Refused user ${pamh.user ?? ''} for service ${pamh.service}`);
  return PamReturn.AUTH_ERR;
}

export const pamListfileModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh, _flags, args) => listfileCheck(pamh, args),
  setcred: () => PamReturn.SUCCESS,
  acctMgmt: (pamh, _flags, args) => listfileCheck(pamh, args),
  openSession: (pamh, _flags, args) => listfileCheck(pamh, args),
  closeSession: (pamh, _flags, args) => listfileCheck(pamh, args),
  chauthtok: (pamh, _flags, args) => listfileCheck(pamh, args),
};
