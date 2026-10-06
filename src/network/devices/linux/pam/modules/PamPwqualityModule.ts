import { PasswordQualityPolicy, type PasswordQualityPolicyInit } from '../../iam/policy/PasswordQualityPolicy';
import { applyPwqualityOption, readPwqualityConfig } from '../../iam/policy/PwqualityConfig';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';

const PWQUALITY_CONF = '/etc/security/pwquality.conf';
const PWQUALITY_CONF_DIRECTORY = '/etc/security/pwquality.conf.d';
const DEFAULT_RETRY = 1;

function loadSettings(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): { policy: PasswordQualityPolicy; debug: boolean } {
  const merged: PasswordQualityPolicyInit = {};
  const files = [PWQUALITY_CONF];
  const directory = pamh.host.files.listDirectory(PWQUALITY_CONF_DIRECTORY) ?? [];
  for (const name of directory.filter((entry) => entry.endsWith('.conf')).sort()) files.push(`${PWQUALITY_CONF_DIRECTORY}/${name}`);
  for (const path of files) {
    const content = pamh.host.readFile(path);
    if (content === null) {
      if (path === PWQUALITY_CONF) pamh.syslog('err', 'Reading pwquality configuration file failed: Configuration file not found');
      continue;
    }
    const { init, rejected } = readPwqualityConfig(content);
    Object.assign(merged, init);
    for (const line of rejected) pamh.syslog('err', `Reading pwquality configuration file failed: Parse error: ${line}`);
  }
  let debug = false;
  for (const argument of args) {
    if (argument === 'debug') debug = true;
    else if (argument.startsWith('type=')) pamh.authtokType = argument.slice(5);
    else if (/^(difignore=|reject_username|authtok_type|use_authtok|use_first_pass|try_first_pass)/.test(argument)) continue;
    else if (!applyPwqualityOption(merged, argument)) pamh.syslog('err', `pam_parse: unknown or broken option; ${argument}`);
  }
  const policy = new PasswordQualityPolicy({ retry: DEFAULT_RETRY, ...merged });
  return { policy, debug };
}

function* chauthtok(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  const { policy, debug } = loadSettings(pamh, args);
  const retryTimes = policy.retry < 1 ? DEFAULT_RETRY : policy.retry;
  if ((flags & PamFlag.PRELIM_CHECK) !== 0) return PamReturn.SUCCESS;
  if ((flags & PamFlag.UPDATE_AUTHTOK) === 0) {
    if (debug) pamh.syslog('notice', `UNKNOWN flags setting ${flags.toString(16).padStart(2, '0').toUpperCase()}`);
    return PamReturn.SERVICE_ERR;
  }
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null) {
    if (debug) pamh.syslog('err', 'Can not get username');
    return PamReturn.AUTHTOK_ERR;
  }
  const user = lookup.value;
  const oldToken = pamh.oldAuthtok;
  for (let tries = 0; tries < retryTimes; tries++) {
    const proposed = yield* pamh.getAuthtok(null, { noverify: true });
    if (proposed.code !== PamReturn.SUCCESS || proposed.value === null) {
      if (proposed.code === PamReturn.AUTHTOK_ERR || proposed.value === null) pamh.syslog('info', 'user aborted password change');
      else pamh.syslog('err', `pam_get_authtok_noverify returned error: ${proposed.code}`);
      return PamReturn.AUTHTOK_ERR;
    }
    const newToken = proposed.value;
    if (debug && policy.localUsersOnly) pamh.syslog('info', 'Applying password quality checks to local users only');
    const account = pamh.host.accounts.findUser(user);
    const skipped = policy.localUsersOnly && account === null;
    const verdict = skipped ? null : policy.evaluate(newToken, {
      username: user,
      gecos: account?.gecos,
      oldPassword: oldToken ?? undefined,
    });
    if (verdict !== null && !verdict.acceptable) {
      const message = verdict.messages[0];
      if (debug) pamh.syslog('debug', `bad password: ${message}`);
      yield* pamh.notify('error', `BAD PASSWORD: ${message}`);
      const enforcing = policy.enforcing && (pamh.host.caller.uid !== 0 || policy.enforceForRoot || (flags & PamFlag.CHANGE_EXPIRED_AUTHTOK) !== 0);
      if (enforcing) {
        pamh.authtok = null;
        continue;
      }
    }
    const verified = yield* pamh.getAuthtokVerify(null);
    if (verified.code !== PamReturn.SUCCESS || verified.value === null) {
      pamh.authtok = null;
      if (verified.code === PamReturn.TRY_AGAIN) continue;
      if (verified.code === PamReturn.AUTHTOK_ERR || verified.value === null) pamh.syslog('info', 'user aborted password change');
      else pamh.syslog('err', `pam_get_authtok_verify returned error: ${verified.code}`);
      return PamReturn.AUTHTOK_ERR;
    }
    return PamReturn.SUCCESS;
  }
  pamh.authtok = null;
  return retryTimes > 1 ? PamReturn.MAXTRIES : PamReturn.AUTHTOK_ERR;
}

export const pamPwqualityModule: PamModuleImplementation<LinuxPamHost> = {
  chauthtok,
};
