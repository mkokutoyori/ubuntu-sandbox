import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';

const STATE_KEY = 'pam_keyinit_state';

interface KeyinitState {
  mySessionKeyring: number;
  sessionCounter: number;
  doRevoke: boolean;
  revokeAsUid: number;
  debug: boolean;
}

function stateOf(pamh: PamHandle<LinuxPamHost>): KeyinitState {
  let state = pamh.getData<KeyinitState>(STATE_KEY) ?? null;
  if (state === null) {
    state = { mySessionKeyring: 0, sessionCounter: 0, doRevoke: false, revokeAsUid: 0, debug: false };
    pamh.setData(STATE_KEY, state, null);
  }
  return state;
}

function debug(pamh: PamHandle<LinuxPamHost>, state: KeyinitState, message: string): void {
  if (state.debug) pamh.syslog('debug', message);
}

function initKeyrings(
  pamh: PamHandle<LinuxPamHost>, state: KeyinitState, force: boolean, errorReturn: number,
  user: { uid: number; gid: number },
): number {
  const host = pamh.host;
  if (!force) {
    const session = host.process.sessionKeyring ?? -1;
    debug(pamh, state, `GET SESSION = ${session}`);
    const userSession = host.keyrings.userSessionKeyring(user.uid);
    debug(pamh, state, `GET SESSION = ${userSession}`);
    if (session !== userSession) return PamReturn.SUCCESS;
  }
  const joined = host.keyrings.joinAnonymousSession(user.uid, user.gid);
  debug(pamh, state, `JOIN = ${joined}`);
  host.process.sessionKeyring = joined;
  state.mySessionKeyring = joined;
  return host.keyrings.linkUserKeyring(user.uid, joined) ? PamReturn.SUCCESS : errorReturn;
}

function killKeyrings(pamh: PamHandle<LinuxPamHost>, state: KeyinitState, errorReturn: number): number {
  if (state.mySessionKeyring <= 0) return PamReturn.SUCCESS;
  debug(pamh, state, `REVOKE ${state.mySessionKeyring}`);
  const revoked = pamh.host.keyrings.revoke(state.mySessionKeyring, state.revokeAsUid);
  state.mySessionKeyring = 0;
  return revoked ? PamReturn.SUCCESS : errorReturn;
}

function* doKeyinit(pamh: PamHandle<LinuxPamHost>, args: readonly string[], errorReturn: number): PamConversationFlow<number> {
  const state = stateOf(pamh);
  let force = false;
  for (const argument of args) {
    if (argument === 'force') force = true;
    else if (argument === 'debug') state.debug = true;
    else if (argument === 'revoke') state.doRevoke = true;
  }
  if (state.mySessionKeyring > 0) return PamReturn.SUCCESS;
  const lookup = yield* pamh.getUser('key user');
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) return lookup.code;
  const user = pamh.host.accounts.findUser(lookup.value);
  if (user === null) {
    pamh.syslog('notice', `Unable to look up user "${lookup.value}"\n`);
    return PamReturn.USER_UNKNOWN;
  }
  state.revokeAsUid = user.uid;
  debug(pamh, state, `UID:${user.uid} [${pamh.host.caller.uid}]  GID:${user.gid} [${pamh.host.caller.uid}]`);
  return initKeyrings(pamh, state, force, errorReturn, user);
}

export const pamKeyinitModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: () => PamReturn.IGNORE,
  setcred: (pamh, flags, args) => {
    const state = stateOf(pamh);
    if ((flags & PamFlag.ESTABLISH_CRED) !== 0) {
      debug(pamh, state, 'ESTABLISH_CRED');
      return doKeyinit(pamh, args, PamReturn.CRED_ERR);
    }
    if ((flags & PamFlag.DELETE_CRED) !== 0 && state.mySessionKeyring > 0 && state.doRevoke) {
      debug(pamh, state, 'DELETE_CRED');
      return killKeyrings(pamh, state, PamReturn.CRED_ERR);
    }
    return PamReturn.IGNORE;
  },
  openSession: (pamh, _flags, args) => {
    const state = stateOf(pamh);
    state.sessionCounter++;
    debug(pamh, state, `OPEN ${state.sessionCounter}`);
    return doKeyinit(pamh, args, PamReturn.SESSION_ERR);
  },
  closeSession: (pamh) => {
    const state = stateOf(pamh);
    debug(pamh, state, `CLOSE ${state.sessionCounter},${state.mySessionKeyring},${state.doRevoke ? 1 : 0}`);
    state.sessionCounter--;
    if (state.sessionCounter <= 0 && state.mySessionKeyring > 0 && state.doRevoke) killKeyrings(pamh, state, PamReturn.SESSION_ERR);
    return PamReturn.SUCCESS;
  },
};
