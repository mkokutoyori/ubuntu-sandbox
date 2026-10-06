import { checkTime, clockNow, isSame, logicField, readField, ttyName, type ClockNow, type Scanner } from '../PamConfigRules';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamReturn } from '../PamReturnCode';

const DEFAULT_CONF = '/etc/security/time.conf';
function checkAccount(
  pamh: PamHandle<LinuxPamHost>, service: string, tty: string, user: string, file: string, now: ClockNow,
): number {
  const content = pamh.host.readFile(file);
  if (content === null) {
    pamh.syslog('err', `error opening ${file}: No such file or directory`);
    return PamReturn.SUCCESS;
  }
  const scanner: Scanner = { content, position: 0, state: 'newline' };
  let count = 0;
  let result: number = PamReturn.SUCCESS;
  do {
    const first = readField(pamh, scanner);
    if (first === null || first === '') continue;
    count++;
    if (scanner.state !== 'field') {
      pamh.syslog('err', `${file}: malformed rule #${count}`);
      continue;
    }
    let good = logicField(pamh, first, count, (member) => isSame(service, member));
    const ttyField = readField(pamh, scanner) ?? '';
    if (scanner.state !== 'field') {
      pamh.syslog('err', `${file}: malformed rule #${count}`);
      continue;
    }
    good = good && logicField(pamh, ttyField, count, (member) => isSame(tty, member));
    const userField = readField(pamh, scanner) ?? '';
    if (scanner.state !== 'field') {
      pamh.syslog('err', `${file}: malformed rule #${count}`);
      continue;
    }
    if (userField[0] === '@') good = false;
    else good = good && logicField(pamh, userField, count, (member) => isSame(user, member));
    const timeField = readField(pamh, scanner) ?? '';
    if (scanner.state === 'field') {
      pamh.syslog('err', `${file}: poorly terminated rule #${count}`);
      continue;
    }
    const inTime = logicField(pamh, timeField, count, (member, rule) => checkTime(pamh, now, member, rule));
    if (good && !inTime) result = PamReturn.PERM_DENIED;
  } while (scanner.state !== 'eof');
  return result;
}

function* acctMgmt(pamh: PamHandle<LinuxPamHost>, args: readonly string[]): PamConversationFlow<number> {
  let debug = false;
  let confFile = DEFAULT_CONF;
  for (const argument of args) {
    if (argument === 'debug') debug = true;
    else if (argument === 'noaudit') continue;
    else if (argument.startsWith('conffile=')) {
      const value = argument.slice(9);
      if (value === '') pamh.syslog('err', 'conffile= specification missing argument - ignored');
      else confFile = value;
    } else pamh.syslog('err', `unknown option: ${argument}`);
  }
  if (debug) pamh.syslog('debug', `conffile=${confFile}`);
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null || lookup.value === '') {
    pamh.syslog('notice', 'cannot determine user name');
    return PamReturn.USER_UNKNOWN;
  }
  const result = checkAccount(pamh, pamh.service, ttyName(pamh), lookup.value, confFile, clockNow(pamh));
  if (result !== PamReturn.SUCCESS && debug) pamh.syslog('debug', `user ${lookup.value} rejected`);
  return result;
}

export const pamTimeModule: PamModuleImplementation<LinuxPamHost> = {
  acctMgmt: (pamh, _flags, args) => acctMgmt(pamh, args),
};
