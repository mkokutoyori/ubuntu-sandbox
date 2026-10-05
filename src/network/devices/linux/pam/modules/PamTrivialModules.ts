import type { LinuxPamHost } from '../PamLinuxHost';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { PamModuleImplementation } from '../PamModule';
import { PamReturn } from '../PamReturnCode';

export const pamDenyModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: () => PamReturn.AUTH_ERR,
  setcred: () => PamReturn.CRED_ERR,
  acctMgmt: () => PamReturn.AUTH_ERR,
  chauthtok: () => PamReturn.AUTHTOK_ERR,
  openSession: () => PamReturn.SESSION_ERR,
  closeSession: () => PamReturn.SESSION_ERR,
};

function* permitAuthenticate(pamh: PamHandle<LinuxPamHost>): PamConversationFlow<number> {
  const user = yield* pamh.getUser();
  if (user.code !== PamReturn.SUCCESS) return user.code;
  if (user.value === '') pamh.user = 'nobody';
  return PamReturn.SUCCESS;
}

export const pamPermitModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: permitAuthenticate,
  setcred: () => PamReturn.SUCCESS,
  acctMgmt: () => PamReturn.SUCCESS,
  chauthtok: () => PamReturn.SUCCESS,
  openSession: () => PamReturn.SUCCESS,
  closeSession: () => PamReturn.SUCCESS,
};

function rootCheck(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): number {
  let debug = false;
  for (const argument of args) {
    if (argument === 'debug') debug = true;
    else pamh.syslog('err', `unknown option: ${argument}`);
  }
  const result = pamh.host.caller.uid === 0 ? PamReturn.SUCCESS : PamReturn.AUTH_ERR;
  if (debug) pamh.syslog('debug', `root check ${result === PamReturn.SUCCESS ? 'succeeded' : 'failed'}`);
  return result;
}

export const pamRootokModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh, _flags, args) => rootCheck(pamh, args),
  setcred: () => PamReturn.SUCCESS,
  acctMgmt: (pamh, _flags, args) => rootCheck(pamh, args),
};

const DEFAULT_NOLOGIN_PATH = '/var/run/nologin';
const COMPAT_NOLOGIN_PATH = '/etc/nologin';

function* nologinCheck(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): PamConversationFlow<number> {
  let whenNoFile: number = PamReturn.IGNORE;
  let file: string | null = null;
  for (const argument of args) {
    if (argument === 'successok') whenNoFile = PamReturn.SUCCESS;
    else if (argument.startsWith('file=')) file = argument.slice(5);
    else pamh.syslog('err', `unknown option: ${argument}`);
  }
  const user = yield* pamh.getUser();
  if (user.code !== PamReturn.SUCCESS || user.value === null) {
    pamh.syslog('notice', 'cannot determine user name');
    return PamReturn.USER_UNKNOWN;
  }
  const host = pamh.host;
  const content = file === null
    ? (host.readFile(DEFAULT_NOLOGIN_PATH) ?? host.readFile(COMPAT_NOLOGIN_PATH))
    : host.readFile(file);
  if (content === null) return whenNoFile;
  let retval = whenNoFile;
  let style: 'info' | 'error' = 'info';
  const record = host.accounts.findUser(user.value);
  if (record === null) {
    retval = PamReturn.USER_UNKNOWN;
    style = 'error';
  } else if (record.uid !== 0) {
    retval = PamReturn.AUTH_ERR;
    style = 'error';
  }
  yield* pamh.notify(style, content);
  return retval;
}

export const pamNologinModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: (pamh, _flags, args) => nologinCheck(pamh, args),
  setcred: () => PamReturn.SUCCESS,
  acctMgmt: (pamh, _flags, args) => nologinCheck(pamh, args),
};
