import { IPAddress, IPv6Address, SubnetMask } from '../../../../core/types';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost, PamUserRecord } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamReturn } from '../PamReturnCode';

const DEFAULT_CONFIG = '/etc/security/access.conf';
const ACCESS_DIRECTORY = '/etc/security/access.d';

const ALL = 2;
const YES = 1;
const NO = 0;
const NOMATCH = -1;

interface LoginInfo {
  user: PamUserRecord;
  from: string | null;
  configFile: string;
  hostname: string | null;
  debug: boolean;
  onlyNewGroupSyntax: boolean;
  fieldSeparator: string;
  listSeparator: string;
  fromRemoteHost: boolean;
  resolved: readonly string[] | null;
}

type MatchFunction = (token: string) => number;

function parseArguments(pamh: PamHandle<LinuxPamHost>, info: LoginInfo, args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument.startsWith('fieldsep=')) info.fieldSeparator = argument.slice(9);
    else if (argument.startsWith('listsep=')) info.listSeparator = argument.slice(8);
    else if (argument.startsWith('accessfile=')) {
      const path = argument.slice(11);
      if (pamh.host.readFile(path) !== null) info.configFile = path;
      else {
        pamh.syslog('err', `failed to open accessfile=[${path}]: No such file or directory`);
        return false;
      }
    } else if (argument === 'debug') info.debug = true;
    else if (argument === 'nodefgroup') info.onlyNewGroupSyntax = true;
    else if (argument === 'noaudit') continue;
    else pamh.syslog('err', `unrecognized option [${argument}]`);
  }
  return true;
}

function tokens(text: string, separators: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const character of text) {
    if (separators.includes(character)) {
      if (current !== '') out.push(current);
      current = '';
    } else current += character;
  }
  if (current !== '') out.push(current);
  return out;
}

function parseAddress(text: string): { family: 4; address: IPAddress } | { family: 6; address: IPv6Address } | null {
  const v4 = IPAddress.tryParse(text);
  if (v4 !== null) return { family: 4, address: v4 };
  const v6 = IPv6Address.tryParse(text);
  if (v6 !== null) return { family: 6, address: v6 };
  return null;
}

function prefixOfMask(text: string, family: 4 | 6): number | null {
  const mask = parseAddress(text);
  if (mask === null || mask.family !== family) return null;
  const bits = family === 4
    ? (mask.address as IPAddress).toString().split('.').map((octet) => parseInt(octet, 10).toString(2).padStart(8, '0')).join('')
    : (mask.address as IPv6Address).toString().split(':').length > 0
      ? (mask.address as IPv6Address).toFullString().split(':').map((group) => parseInt(group, 16).toString(2).padStart(16, '0')).join('')
      : '';
  return /^1*0*$/.test(bits) ? bits.indexOf('0') < 0 ? bits.length : bits.indexOf('0') : null;
}

function addressesEqual(left: string, right: string, netmask: string | null): boolean {
  const a = parseAddress(left);
  const b = parseAddress(right);
  if (a === null || b === null || a.family !== b.family) return false;
  if (netmask !== null) {
    const prefix = /^\d+$/.test(netmask) ? parseInt(netmask, 10) : prefixOfMask(netmask, a.family);
    if (prefix !== null) {
      if (a.family === 4) return a.address.isInSameSubnet(b.address as IPAddress, SubnetMask.fromCIDR(prefix));
      return a.address.isInSameSubnet(b.address as IPv6Address, prefix);
    }
  }
  return a.address.toString() === b.address.toString();
}

function stringMatch(pamh: PamHandle<LinuxPamHost>, token: string, value: string | null, debug: boolean): number {
  if (debug) pamh.syslog('debug', `string_match: tok=${token}, item=${value}`);
  if (token.toLowerCase() === 'all') return ALL;
  if (value !== null) {
    if (token.toLowerCase() === value.toLowerCase()) return YES;
  } else if (token.toLowerCase() === 'none') return YES;
  return NO;
}

function groupMatch(pamh: PamHandle<LinuxPamHost>, token: string, user: string, debug: boolean): number {
  if (debug) pamh.syslog('debug', `group_match: grp=${token}, user=${user}`);
  if (token.length < 3) return NO;
  return pamh.host.accounts.groupNames(user).includes(token.slice(1, -1)) ? YES : NO;
}

function networkNetmaskMatch(pamh: PamHandle<LinuxPamHost>, token: string, value: string, info: LoginInfo): boolean {
  if (info.debug) pamh.syslog('debug', `network_netmask_match: tok=${token}, item=${value}`);
  let network = token;
  let netmask: string | null = null;
  const slash = token.indexOf('/');
  if (slash >= 0) {
    network = token.slice(0, slash);
    const maskText = token.slice(slash + 1);
    const base = parseAddress(network);
    if (base === null) return false;
    if (parseAddress(maskText) === null) {
      if (!/^[+-]?\d+$/.test(maskText)) return false;
      const length = parseInt(maskText, 10);
      if (length < 0 || (base.family === 4 && length > 32) || (base.family === 6 && length > 128)) return false;
      netmask = length === 0 ? null : String(length);
    } else netmask = maskText;
  } else if (parseAddress(token) === null) return false;
  if (parseAddress(value) === null) {
    if (info.resolved === null) info.resolved = pamh.host.resolveHost(value);
    return info.resolved.some((address) => addressesEqual(address, network, netmask));
  }
  return addressesEqual(value, network, netmask);
}

function fromMatch(pamh: PamHandle<LinuxPamHost>, token: string, info: LoginInfo): number {
  const value = info.from;
  if (info.debug) pamh.syslog('debug', `from_match: tok=${token}, item=${value}`);
  if (value === null) return NO;
  if (token.startsWith('@')) return NO;
  const direct = stringMatch(pamh, token, value, info.debug);
  if (direct !== NO) return direct;
  if (token.startsWith('.')) {
    if (value.length > token.length && value.slice(-token.length).toLowerCase() === token.toLowerCase()) return YES;
  } else if (!info.fromRemoteHost) {
    if (token.toLowerCase() === 'local') return YES;
  } else if (token.endsWith('.')) {
    if (info.resolved === null) info.resolved = IPAddress.isValid(value) ? [value] : pamh.host.resolveHost(value);
    const dotted = info.resolved.filter((address) => IPAddress.isValid(address));
    return dotted.some((address) => `${address}.`.startsWith(token)) ? YES : NO;
  } else if (networkNetmaskMatch(pamh, token, value, info)) return YES;
  return NO;
}

function userMatch(pamh: PamHandle<LinuxPamHost>, token: string, info: LoginInfo): number {
  const name = info.user.name;
  if (info.debug) pamh.syslog('debug', `user_match: tok=${token}, item=${name}`);
  let atStart = 0;
  while (token[atStart] === '@') atStart++;
  if (token.startsWith('(') && token.endsWith(')')) return groupMatch(pamh, token, name, info.debug);
  const at = token.indexOf('@', atStart);
  if (at >= 0) {
    if (info.hostname === null) return NO;
    const fake: LoginInfo = { ...info, from: info.hostname, resolved: null, fromRemoteHost: true };
    if (!userMatch(pamh, token.slice(0, at), info)) return NO;
    return fromMatch(pamh, token.slice(at + 1), fake);
  }
  if (token.startsWith('@')) {
    if (token[1] === '@' && info.hostname === null) return NO;
    if (info.debug) pamh.syslog('debug', `netgroup_match: 0 (netgroup=${token.replace(/^@+/, '')}, user=${name})`);
    return NO;
  }
  const direct = stringMatch(pamh, token, name, info.debug);
  if (direct !== NO) return direct;
  if (!info.onlyNewGroupSyntax && pamh.host.accounts.groupNames(name).includes(token)) return YES;
  return NO;
}

function listMatch(entries: readonly string[], start: number, matcher: MatchFunction): number {
  let match = NO;
  let index = start;
  for (; index < entries.length; index++) {
    const token = entries[index];
    if (token.toLowerCase() === 'except') {
      index++;
      break;
    }
    match = matcher(token);
    if (match !== NO) {
      index++;
      break;
    }
  }
  if (match === NO) return NO;
  let found = false;
  for (; index < entries.length; index++) {
    if (entries[index].toLowerCase() === 'except') {
      found = true;
      index++;
      break;
    }
  }
  if (!found) return match;
  return listMatch(entries, index, matcher) === NO ? YES : NO;
}

function strtok(line: string, position: number, delimiters: string): { token: string | null; next: number } {
  let start = position;
  while (start < line.length && delimiters.includes(line[start])) start++;
  if (start >= line.length) return { token: null, next: line.length };
  let end = start;
  while (end < line.length && !delimiters.includes(line[end])) end++;
  return { token: line.slice(start, end), next: Math.min(end + 1, line.length) };
}

function loginAccess(pamh: PamHandle<LinuxPamHost>, info: LoginInfo): number {
  if (info.debug) pamh.syslog('debug', `login_access: user=${info.user.name}, from=${info.from}, file=${info.configFile}`);
  const content = pamh.host.readFile(info.configFile);
  if (content === null) {
    pamh.syslog('warning', `warning: cannot open ${info.configFile}: No such file or directory`);
    return NOMATCH;
  }
  let match = NO;
  let permission = '';
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (let index = 0; index < lines.length && match === NO; index++) {
    const raw = lines[index];
    const lineNumber = index + 1;
    if (raw.startsWith('#')) continue;
    const line = raw.replace(/[ \t\r\v\f]+$/, '');
    if (line === '') continue;
    const permissionField = strtok(line, 0, info.fieldSeparator);
    const usersField = permissionField.token === null ? null : strtok(line, permissionField.next, info.fieldSeparator);
    const fromsField = usersField === null || usersField.token === null ? null : strtok(line, usersField.next, '\n');
    if (permissionField.token === null || usersField === null || usersField.token === null || fromsField === null || fromsField.token === null) {
      pamh.syslog('err', `${info.configFile}: line ${lineNumber}: bad field count`);
      continue;
    }
    if (permissionField.token[0] !== '+' && permissionField.token[0] !== '-') {
      pamh.syslog('err', `${info.configFile}: line ${lineNumber}: bad first field`);
      continue;
    }
    permission = permissionField.token;
    if (info.debug) pamh.syslog('debug', `line ${lineNumber}: ${permissionField.token} : ${usersField.token} : ${fromsField.token}`);
    match = listMatch(tokens(usersField.token, info.listSeparator), 0, (token) => userMatch(pamh, token, info));
    if (info.debug) pamh.syslog('debug', `user_match=${match}, "${info.user.name}"`);
    if (match !== NO) {
      match = listMatch(tokens(fromsField.token, info.listSeparator), 0, (token) => fromMatch(pamh, token, info));
      if (info.debug) pamh.syslog('debug', `from_match=${match}, "${info.from}"`);
    }
  }
  if (match === NO) return NOMATCH;
  return permission[0] === '+' ? YES : NO;
}

function* access(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): PamConversationFlow<number> {
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) {
    pamh.syslog('notice', 'cannot determine user name');
    return PamReturn.USER_UNKNOWN;
  }
  const user = pamh.host.accounts.findUser(lookup.value);
  if (user === null) return PamReturn.USER_UNKNOWN;
  const info: LoginInfo = {
    user, from: null, configFile: DEFAULT_CONFIG, hostname: null, debug: false, onlyNewGroupSyntax: false,
    fieldSeparator: ':', listSeparator: ', \t', fromRemoteHost: false, resolved: null,
  };
  if (!parseArguments(pamh, info, args)) {
    pamh.syslog('err', 'failed to parse the module arguments');
    return PamReturn.ABORT;
  }
  const usingDefault = info.configFile === DEFAULT_CONFIG;
  let from: string;
  if (pamh.rhost === null || pamh.rhost === '') {
    info.fromRemoteHost = false;
    if (pamh.tty === null) {
      from = pamh.service;
      if (info.debug) pamh.syslog('debug', `cannot determine tty or remote hostname, using service ${from}`);
    } else {
      from = pamh.tty;
    }
    if (from.startsWith('/')) {
      from = from.slice(1);
      const slash = from.indexOf('/');
      if (slash >= 0) from = from.slice(slash + 1);
    }
  } else {
    from = pamh.rhost;
    info.fromRemoteHost = true;
  }
  info.from = from;
  info.hostname = pamh.host.hostname();
  let verdict = loginAccess(pamh, info);
  if (verdict === NOMATCH && usingDefault) {
    const names = (pamh.host.files.listDirectory(ACCESS_DIRECTORY) ?? []).filter((name) => name.endsWith('.conf')).sort();
    for (const name of names) {
      info.configFile = `${ACCESS_DIRECTORY}/${name}`;
      verdict = loginAccess(pamh, info);
      if (verdict !== NOMATCH) break;
    }
  }
  if (verdict !== NO) return PamReturn.SUCCESS;
  pamh.syslog('err', `access denied for user \`${user.name}' from \`${from}'`);
  return PamReturn.PERM_DENIED;
}

export const pamAccessModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh, _flags, args) => access(pamh, args),
  setcred: () => PamReturn.IGNORE,
  acctMgmt: (pamh, _flags, args) => access(pamh, args),
  openSession: (pamh, _flags, args) => access(pamh, args),
  closeSession: (pamh, _flags, args) => access(pamh, args),
  chauthtok: (pamh, _flags, args) => access(pamh, args),
};
