import { daysSinceEpoch, type LinuxPamHost, type PamShadowRecord } from '../PamLinuxHost';
import { PamFlag, PamReturn } from '../PamReturnCode';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { PamModuleImplementation } from '../PamModule';

const MAX_RETRIES = 3;
const FAIL_PREFIX = '-UN*X-FAIL-';

interface UnixControl {
  nullok: boolean;
  nullresetok: boolean;
  likeauth: boolean;
  audit: boolean;
  debug: boolean;
  quiet: boolean;
  noPassExpiry: boolean;
  noDelay: boolean;
  useAuthtok: boolean;
  minLength: number | null;
  remember: number | null;
}

interface FailedAuth {
  user: string;
  loginName: string;
  uid: number;
  euid: number;
  count: number;
}

const FLAG_TOKENS: ReadonlySet<string> = new Set([
  'shadow', 'md5', 'bigcrypt', 'sha256', 'sha512', 'blowfish', 'des', 'gost_yescrypt', 'yescrypt', 'nodelay',
  'nis', 'noreap', 'broken_shadow', 'obscure', 'use_first_pass', 'try_first_pass',
]);

function parseControl(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): UnixControl {
  const control: UnixControl = {
    nullok: false, nullresetok: false, likeauth: false, audit: false, debug: false, quiet: false,
    noPassExpiry: false, noDelay: false, useAuthtok: false, minLength: null, remember: null,
  };
  for (const argument of args) {
    if (argument === 'nullok') control.nullok = true;
    else if (argument === 'nullresetok') control.nullresetok = true;
    else if (argument === 'likeauth') control.likeauth = true;
    else if (argument === 'audit') { control.audit = true; control.debug = true; }
    else if (argument === 'debug') control.debug = true;
    else if (argument === 'quiet') control.quiet = true;
    else if (argument === 'no_pass_expiry') control.noPassExpiry = true;
    else if (argument === 'nodelay') control.noDelay = true;
    else if (argument === 'use_authtok') control.useAuthtok = true;
    else if (argument.startsWith('minlen=')) control.minLength = Number.parseInt(argument.slice(7), 10) || 0;
    else if (argument.startsWith('remember=')) control.remember = Math.min(400, Number.parseInt(argument.slice(9), 10) || 0);
    else if (argument.startsWith('rounds=') || argument.startsWith('authtok_type=')) continue;
    else if (!FLAG_TOKENS.has(argument)) pamh.syslog('err', `unrecognized option [${argument}]`);
  }
  if ((flags & PamFlag.DISALLOW_NULL_AUTHTOK) !== 0) control.nullok = false;
  return control;
}

function* remark(pamh: PamHandle<LinuxPamHost>, flags: number, style: 'error' | 'info', text: string): PamConversationFlow<void> {
  if ((flags & PamFlag.SILENT) === 0) yield* pamh.notify(style, text);
}

function checkShadowExpiry(
  pamh: PamHandle<LinuxPamHost>, shadow: PamShadowRecord, name: string,
): { code: number; daysLeft: number } {
  const today = daysSinceEpoch(pamh.host);
  if (shadow.expire !== -1 && today >= shadow.expire) return { code: PamReturn.ACCT_EXPIRED, daysLeft: -1 };
  if (shadow.lastChange === 0) return { code: PamReturn.NEW_AUTHTOK_REQD, daysLeft: 0 };
  if (today < shadow.lastChange) {
    pamh.syslog('debug', `account ${name} has password changed in future`);
    return { code: PamReturn.SUCCESS, daysLeft: -1 };
  }
  const age = today - shadow.lastChange;
  if (shadow.max !== -1 && shadow.inactive !== -1 && age > shadow.max && age > shadow.inactive && age > shadow.max + shadow.inactive) {
    return { code: PamReturn.AUTHTOK_EXPIRED, daysLeft: shadow.lastChange + shadow.max - today };
  }
  if (shadow.max !== -1 && age > shadow.max) return { code: PamReturn.NEW_AUTHTOK_REQD, daysLeft: -1 };
  let daysLeft = -1;
  if (shadow.max !== -1 && shadow.warn !== -1 && age > shadow.max - shadow.warn) {
    daysLeft = shadow.lastChange + shadow.max - today;
  }
  if (shadow.min !== -1 && age < shadow.min) return { code: PamReturn.AUTHTOK_ERR, daysLeft };
  return { code: PamReturn.SUCCESS, daysLeft };
}

function verifyUser(pamh: PamHandle<LinuxPamHost>, name: string): { code: number; daysLeft: number } {
  const user = pamh.host.accounts.findUser(name);
  if (user === null) {
    pamh.syslog('err', `could not identify user (from getpwnam(${name}))`);
    return { code: PamReturn.USER_UNKNOWN, daysLeft: -1 };
  }
  if (user.shadow === null) return { code: PamReturn.SUCCESS, daysLeft: -1 };
  return checkShadowExpiry(pamh, user.shadow, name);
}

function passwordHash(pamh: PamHandle<LinuxPamHost>, name: string): string | null {
  const user = pamh.host.accounts.findUser(name);
  if (user === null) return null;
  return user.shadow?.hash ?? 'x';
}

function blankPassword(pamh: PamHandle<LinuxPamHost>, control: UnixControl, name: string): boolean {
  let nullok = control.nullok;
  if (control.nullresetok && verifyUser(pamh, name).code === PamReturn.NEW_AUTHTOK_REQD) {
    pamh.syslog('debug', `user [${name}] has expired blank password, enabling nullok`);
    nullok = true;
  }
  if (!nullok) return false;
  const hash = passwordHash(pamh, name);
  return hash === '';
}

function failureCleanup(pamh: PamHandle<LinuxPamHost>, value: unknown, silent: boolean): void {
  const failure = value as FailedAuth | null;
  if (failure === null || silent || failure.count <= 1) return;
  pamh.syslog(
    'notice',
    `${failure.count - 1} more authentication failure${failure.count === 2 ? '' : 's'}; `
    + `logname=${failure.loginName} uid=${failure.uid} euid=${failure.euid} `
    + `tty=${pamh.tty ?? ''} ruser=${pamh.ruser ?? ''} rhost=${pamh.rhost ?? ''} `
    + `${failure.user !== '' ? ' user=' : ''}${failure.user}`,
  );
  if (failure.count > MAX_RETRIES) {
    pamh.syslog('notice', `service(${pamh.service}) ignoring max retries; ${failure.count} > ${MAX_RETRIES}`);
  }
}

function verifyPassword(pamh: PamHandle<LinuxPamHost>, control: UnixControl, name: string, password: string | null): number {
  if (!control.noDelay) pamh.requestFailDelay(2_000_000);
  const hash = passwordHash(pamh, name);
  const dataName = `${FAIL_PREFIX}${name}`;
  let retval: number;
  let reportedUser = name;
  if (hash === null) {
    if (control.audit) pamh.syslog('notice', `check pass; user (${name}) unknown`);
    else {
      reportedUser = '';
      pamh.syslog('notice', 'check pass; user unknown');
    }
    retval = PamReturn.USER_UNKNOWN;
  } else if (hash === '') {
    retval = control.nullok ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
  } else if (password === null || hash.startsWith('*') || hash.startsWith('!')) {
    retval = PamReturn.AUTH_ERR;
  } else {
    retval = pamh.host.accounts.passwordMatches(name, password) ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
  }
  if (retval === PamReturn.SUCCESS) {
    pamh.setData(dataName, null, failureCleanup as never);
    return retval;
  }
  const previous = pamh.getData<FailedAuth | null>(dataName) ?? null;
  const caller = pamh.host.caller;
  const failure: FailedAuth = { user: reportedUser, loginName: caller.loginName, uid: caller.uid, euid: caller.euid, count: 1 };
  if (previous !== null) {
    failure.count = previous.count + 1;
    if (failure.count >= MAX_RETRIES) retval = PamReturn.MAXTRIES;
  } else {
    pamh.syslog(
      'notice',
      `authentication failure; logname=${failure.loginName} uid=${failure.uid} euid=${failure.euid} `
      + `tty=${pamh.tty ?? ''} ruser=${pamh.ruser ?? ''} rhost=${pamh.rhost ?? ''} `
      + `${failure.user !== '' ? ' user=' : ''}${failure.user}`,
    );
  }
  pamh.setData(dataName, failure, failureCleanup as never);
  return retval;
}

function* authenticate(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const control = parseControl(pamh, flags, args);
  const user = yield* pamh.getUser();
  if (user.code !== PamReturn.SUCCESS || user.value === null) {
    if (control.debug) pamh.syslog('debug', 'could not obtain username');
    return user.code;
  }
  const name = user.value;
  if (name.startsWith('-') || name.startsWith('+')) {
    pamh.syslog('notice', `bad username [${name}]`);
    return PamReturn.USER_UNKNOWN;
  }
  if (control.debug) pamh.syslog('debug', `username [${name}] obtained`);
  if (blankPassword(pamh, control, name)) {
    pamh.syslog('debug', `user [${name}] has blank password; authenticated without it`);
    return PamReturn.SUCCESS;
  }
  const token = yield* pamh.getAuthtok(null);
  if (token.code !== PamReturn.SUCCESS) {
    pamh.syslog('crit', `auth could not identify password for [${name}]`);
    return token.code;
  }
  return verifyPassword(pamh, control, name, token.value);
}

function* acctMgmt(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const control = parseControl(pamh, flags, args);
  const name = pamh.user;
  if (name === null) {
    pamh.syslog('err', `could not identify user (from uid=${pamh.host.caller.uid})`);
    return PamReturn.USER_UNKNOWN;
  }
  const verified = verifyUser(pamh, name);
  const daysLeft = verified.daysLeft;
  let code = verified.code;
  if (control.noPassExpiry) {
    const authenticated = pamh.getData<number>('unix_setcred_return') ?? PamReturn.AUTHINFO_UNAVAIL;
    if (authenticated !== PamReturn.SUCCESS && (code === PamReturn.NEW_AUTHTOK_REQD || code === PamReturn.AUTHTOK_EXPIRED)) {
      code = PamReturn.SUCCESS;
    }
  }
  const quiet = control.quiet ? PamFlag.SILENT : 0;
  switch (code) {
    case PamReturn.ACCT_EXPIRED:
      pamh.syslog('notice', `account ${name} has expired (account expired)`);
      yield* remark(pamh, flags | quiet, 'error', 'Your account has expired; please contact your system administrator.');
      break;
    case PamReturn.NEW_AUTHTOK_REQD:
      if (daysLeft === 0) {
        pamh.syslog('notice', `expired password for user ${name} (root enforced)`);
        yield* remark(pamh, flags | quiet, 'error', 'You are required to change your password immediately (administrator enforced).');
      } else {
        pamh.syslog('debug', `expired password for user ${name} (password aged)`);
        yield* remark(pamh, flags | quiet, 'error', 'You are required to change your password immediately (password expired).');
      }
      break;
    case PamReturn.AUTHTOK_EXPIRED:
      pamh.syslog('notice', `account ${name} has expired (failed to change password)`);
      yield* remark(pamh, flags | quiet, 'error', 'Your account has expired; please contact your system administrator.');
      break;
    case PamReturn.AUTHTOK_ERR:
    case PamReturn.SUCCESS:
      if (code === PamReturn.AUTHTOK_ERR) code = PamReturn.SUCCESS;
      if (daysLeft >= 0) {
        pamh.syslog('debug', `password for user ${name} will expire in ${daysLeft} days`);
        yield* remark(pamh, flags | quiet, 'info', `Warning: your password will expire in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`);
      }
      break;
    default:
      break;
  }
  return code;
}

function openSession(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): number {
  const control = parseControl(pamh, flags, args);
  if (pamh.user === null || pamh.user === '') {
    pamh.syslog('err', 'open_session - error recovering username');
    return PamReturn.SESSION_ERR;
  }
  if (!control.quiet) {
    const record = pamh.host.accounts.findUser(pamh.user);
    const uid = record === null ? 'getpwnam error' : String(record.uid);
    const caller = pamh.host.caller;
    pamh.syslog('info', `session opened for user ${pamh.user}(uid=${uid}) by ${caller.loginName}(uid=${caller.uid})`);
  }
  return PamReturn.SUCCESS;
}

function closeSession(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): number {
  const control = parseControl(pamh, flags, args);
  if (pamh.user === null || pamh.user === '') {
    pamh.syslog('err', 'close_session - error recovering username');
    return PamReturn.SESSION_ERR;
  }
  if (!control.quiet) pamh.syslog('info', `session closed for user ${pamh.user}`);
  return PamReturn.SUCCESS;
}

function setcred(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): number {
  const control = parseControl(pamh, flags, args);
  if (control.likeauth) {
    const earlier = pamh.getData<number>('unix_setcred_return');
    if (earlier !== undefined) {
      pamh.deleteData('unix_setcred_return');
      return earlier;
    }
  }
  return PamReturn.SUCCESS;
}

function* authenticateRecording(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const retval = yield* authenticate(pamh, flags, args);
  pamh.setData('unix_setcred_return', retval);
  return retval;
}

function verifyShadow(pamh: PamHandle<LinuxPamHost>, name: string, iAmRoot: boolean): number {
  const verified = verifyUser(pamh, name);
  if (verified.code === PamReturn.USER_UNKNOWN) return verified.code;
  if (iAmRoot || verified.code === PamReturn.NEW_AUTHTOK_REQD) return PamReturn.SUCCESS;
  return verified.code;
}

function* approvePassword(
  pamh: PamHandle<LinuxPamHost>, control: UnixControl, iAmRoot: boolean, silent: boolean,
  old: string | null, fresh: string | null,
): PamConversationFlow<number> {
  const say = (text: string): PamConversationFlow<void> => (silent ? remark(pamh, PamFlag.SILENT, 'error', text) : pamh.notify('error', text));
  if (fresh === null || (old !== null && old === fresh)) {
    if (control.debug) pamh.syslog('debug', 'bad authentication token');
    yield* say(fresh === null ? 'No password has been supplied.' : 'The password has not been changed.');
    return PamReturn.AUTHTOK_ERR;
  }
  let message: string | null = null;
  if (fresh.length > 127) {
    message = 'You must choose a shorter password.';
  } else if (!iAmRoot) {
    if (control.minLength !== null && fresh.length < control.minLength) message = 'You must choose a longer password.';
    if (control.remember !== null && pamh.user !== null && pamh.host.accounts.rememberedPasswordUsed(pamh.user, fresh, control.remember)) {
      message = 'Password has been already used. Choose another.';
    }
  }
  if (message !== null) {
    yield* say(message);
    return PamReturn.AUTHTOK_ERR;
  }
  return PamReturn.SUCCESS;
}

function* chauthtok(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const control = parseControl(pamh, flags, args);
  const quiet = (flags & PamFlag.SILENT) !== 0;
  const iAmRoot = pamh.host.caller.uid === 0 && (flags & PamFlag.CHANGE_EXPIRED_AUTHTOK) === 0;
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) {
    if (control.debug) pamh.syslog('debug', 'password - could not identify user');
    return lookup.code;
  }
  const name = lookup.value;
  if (name.startsWith('-') || name.startsWith('+')) {
    pamh.syslog('notice', `bad username [${name}]`);
    return PamReturn.USER_UNKNOWN;
  }
  if (control.debug) pamh.syslog('debug', `username [${name}] obtained`);
  if (pamh.host.accounts.findUser(name) === null) {
    pamh.syslog('debug', `user "${name}" does not exist in /etc/passwd`);
    return PamReturn.USER_UNKNOWN;
  }
  const checkControl: UnixControl = { ...control, nullok: true };

  if ((flags & PamFlag.PRELIM_CHECK) !== 0) {
    if (blankPassword(pamh, checkControl, name)) return PamReturn.SUCCESS;
    let retval: number;
    if (!iAmRoot) {
      if (!quiet) yield* pamh.notify('info', `Changing password for ${name}.`);
      const old = yield* pamh.getAuthtok(null, { item: 'oldauthtok' });
      if (old.code !== PamReturn.SUCCESS) {
        pamh.syslog('notice', 'password - (old) token not obtained');
        return old.code;
      }
      retval = verifyPassword(pamh, control, name, old.value);
    } else {
      retval = PamReturn.SUCCESS;
    }
    if (retval !== PamReturn.SUCCESS) return retval;
    retval = verifyShadow(pamh, name, iAmRoot);
    if (retval === PamReturn.AUTHTOK_ERR) {
      if (!iAmRoot) yield* remark(pamh, flags, 'error', 'You must wait longer to change your password.');
      else retval = PamReturn.SUCCESS;
    }
    return retval;
  }

  if ((flags & PamFlag.UPDATE_AUTHTOK) !== 0) {
    const oldToken = pamh.oldAuthtok;
    let retval: number = PamReturn.AUTHTOK_ERR;
    let chosen: string | null = null;
    let retry = control.useAuthtok ? 2 : 0;
    while (retval !== PamReturn.SUCCESS && retry++ < 3) {
      const proposed = yield* pamh.getAuthtok(null);
      if (proposed.code !== PamReturn.SUCCESS) {
        if (control.debug) pamh.syslog('err', 'password - new password not obtained');
        return proposed.code;
      }
      chosen = proposed.value === '' ? null : proposed.value;
      retval = yield* approvePassword(pamh, control, iAmRoot, quiet, oldToken, chosen);
      if (retval !== PamReturn.SUCCESS) pamh.authtok = null;
    }
    if (retval !== PamReturn.SUCCESS || chosen === null) {
      pamh.syslog('notice', 'new password not acceptable');
      return retval;
    }
    if (oldToken !== null && verifyPassword(pamh, control, name, oldToken) !== PamReturn.SUCCESS) {
      pamh.syslog('notice', 'user password changed by another process');
      return PamReturn.AUTH_ERR;
    }
    retval = verifyShadow(pamh, name, iAmRoot);
    if (retval !== PamReturn.SUCCESS) {
      pamh.syslog('notice', 'user shadow entry expired');
      return retval;
    }
    retval = yield* approvePassword(pamh, control, iAmRoot, quiet, oldToken, chosen);
    if (retval !== PamReturn.SUCCESS) {
      pamh.syslog('notice', 'new password not acceptable 2');
      return retval;
    }
    if (control.remember !== null && oldToken !== null) pamh.host.accounts.rememberPassword(name, oldToken, control.remember);
    pamh.host.accounts.setPassword(name, chosen);
    return PamReturn.SUCCESS;
  }
  pamh.syslog('crit', 'password received unknown request');
  return PamReturn.ABORT;
}

export const pamUnixModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: authenticateRecording,
  setcred,
  acctMgmt,
  openSession,
  closeSession,
  chauthtok,
};
