import { searchKey } from '../PamFileSearch';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost, PamLastlogRecord } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

const LOGIN_DEFS = '/etc/login.defs';
const DEFAULT_INACTIVE_DAYS = 90;
const MAX_INACTIVE_DAYS = 100000;
const MAX_UID_VALUE = 0xffffffff;
const UT_LINESIZE = 32;
const UT_HOSTSIZE = 256;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Announce {
  date: boolean;
  host: boolean;
  line: boolean;
  never: boolean;
  debug: boolean;
  quiet: boolean;
  update: boolean;
  showFailed: boolean;
}

function parseSessionOptions(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): Announce {
  const announce: Announce = {
    date: true, host: true, line: true, never: false, debug: false, quiet: false, update: true, showFailed: false,
  };
  for (const argument of args) {
    if (argument === 'debug') announce.debug = true;
    else if (argument === 'nodate') announce.date = false;
    else if (argument === 'noterm') announce.line = false;
    else if (argument === 'nohost') announce.host = false;
    else if (argument === 'silent') announce.quiet = true;
    else if (argument === 'never') announce.never = true;
    else if (argument === 'nowtmp' || argument === 'unlimited') continue;
    else if (argument === 'noupdate') announce.update = false;
    else if (argument === 'showfailed') announce.showFailed = true;
    else pamh.syslog('err', `unknown option: ${argument}`);
  }
  if ((flags & PamFlag.SILENT) !== 0) {
    announce.quiet = true;
    announce.showFailed = false;
  }
  return announce;
}

function ttyOf(pamh: PamHandle<LinuxPamHost>): string {
  const tty = pamh.tty ?? '';
  return tty.startsWith('/dev/') ? tty.slice(5) : tty;
}

function lastlogUidMax(pamh: PamHandle<LinuxPamHost>): number {
  const value = searchKey((path) => pamh.host.readFile(path), LOGIN_DEFS, 'LASTLOG_UID_MAX');
  if (value === null) return MAX_UID_VALUE;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return MAX_UID_VALUE;
  const parsed = Number(trimmed);
  return parsed >= MAX_UID_VALUE ? MAX_UID_VALUE : parsed;
}

function formatDate(pamh: PamHandle<LinuxPamHost>, seconds: number): string {
  const time = pamh.host.localTime(seconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = padToWidth(String(time.day), 2, 'right');
  return ` ${WEEKDAYS[time.weekday]} ${MONTHS[time.month]} ${day} ${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)} ${time.abbreviation} ${time.year}`;
}

function describe(pamh: PamHandle<LinuxPamHost>, announce: Announce, record: PamLastlogRecord): string {
  const date = announce.date ? formatDate(pamh, record.time) : '';
  const host = announce.host && record.host !== '' ? ` from ${record.host.slice(0, UT_HOSTSIZE)}` : '';
  const line = announce.line && record.line !== '' ? ` on ${record.line.slice(0, UT_LINESIZE)}` : '';
  return `${date}${host}${line}`;
}

function* announceLastLogin(
  pamh: PamHandle<LinuxPamHost>, announce: Announce, previous: PamLastlogRecord | null,
): PamConversationFlow<void> {
  if (announce.quiet) return;
  if (previous !== null) {
    const detail = describe(pamh, announce, previous);
    if (detail !== '') yield* pamh.notify('info', `Last login:${detail}`);
  } else if (announce.never) {
    yield* pamh.notify('info', 'Welcome to your new account!');
  }
}

function* announceFailures(
  pamh: PamHandle<LinuxPamHost>, announce: Announce, user: string, since: number,
): PamConversationFlow<void> {
  const failed = pamh.host.lastlog.failedSince(user, since);
  if (failed === null) return;
  const detail = describe(pamh, announce, failed.last);
  if (detail !== '') yield* pamh.notify('info', `Last failed login:${detail}`);
  yield* pamh.notify('info', failed.count === 1
    ? `There was ${failed.count} failed login attempt since the last successful login.`
    : `There were ${failed.count} failed login attempts since the last successful login.`);
}

function* openSession(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const announce = parseSessionOptions(pamh, flags, args);
  const user = pamh.user;
  if (user === null || user === '') {
    pamh.syslog('notice', 'user unknown');
    return PamReturn.USER_UNKNOWN;
  }
  const account = pamh.host.accounts.findUser(user);
  if (account === null) return PamReturn.USER_UNKNOWN;
  if (account.uid > lastlogUidMax(pamh)) return PamReturn.SUCCESS;

  const previous = pamh.host.lastlog.read(user);
  if (previous === null && announce.debug) {
    pamh.syslog('debug', `first login for user with uid ${account.uid}`);
  }
  yield* announceLastLogin(pamh, announce, previous);
  if (announce.update) {
    pamh.host.lastlog.write(user, {
      time: Math.floor(pamh.host.now() / 1000),
      line: ttyOf(pamh).slice(0, UT_LINESIZE - 1),
      host: (pamh.rhost ?? '').slice(0, UT_HOSTSIZE - 1),
    });
  }
  if (announce.showFailed) yield* announceFailures(pamh, announce, user, previous?.time ?? 0);
  return PamReturn.SUCCESS;
}

function parseAuthOptions(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): { inactiveDays: number; debug: boolean } {
  let inactiveDays = DEFAULT_INACTIVE_DAYS;
  let debug = false;
  for (const argument of args) {
    if (argument === 'debug') debug = true;
    else if (argument === 'silent') continue;
    else if (argument.startsWith('inactive=')) {
      const parsed = parseInt(argument.slice(9), 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < MAX_INACTIVE_DAYS) inactiveDays = parsed;
      else pamh.syslog('err', `bad option value: ${argument}`);
    } else pamh.syslog('err', `unknown option: ${argument}`);
  }
  return { inactiveDays, debug };
}

function* denyInactive(pamh: PamHandle<LinuxPamHost>, _flags: number, args: readonly string[]): PamConversationFlow<number> {
  const options = parseAuthOptions(pamh, args);
  const lookup = yield* pamh.getUser();
  if (lookup.value === null) {
    pamh.syslog('notice', 'cannot determine user name');
    return PamReturn.USER_UNKNOWN;
  }
  const account = pamh.host.accounts.findUser(lookup.value);
  if (account === null) {
    pamh.syslog('notice', 'user unknown');
    return PamReturn.USER_UNKNOWN;
  }
  if (account.uid === 0 || account.uid > lastlogUidMax(pamh)) return PamReturn.SUCCESS;
  const previous = pamh.host.lastlog.read(lookup.value);
  if (previous === null) {
    if (options.debug) pamh.syslog('debug', 'user never logged in - pass');
    return PamReturn.SUCCESS;
  }
  const idleDays = Math.floor((pamh.host.now() / 1000 - previous.time) / 86400);
  if (idleDays > options.inactiveDays) {
    pamh.syslog('info', `user ${lookup.value} inactive for ${idleDays} days - denied`);
    return PamReturn.AUTH_ERR;
  }
  return PamReturn.SUCCESS;
}

export const pamLastlogModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: denyInactive,
  setcred: () => PamReturn.SUCCESS,
  acctMgmt: denyInactive,
  openSession,
  closeSession: () => PamReturn.SUCCESS,
};
