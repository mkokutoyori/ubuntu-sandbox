import { checkTime, clockNow, isSame, logicField, readField, ttyName, type ClockNow, type Scanner } from '../PamConfigRules';
import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';

const GROUP_CONF = '/etc/security/group.conf';

function groupMembers(text: string): string[] {
  return text.match(/[A-Za-z0-9_*-]+/g) ?? [];
}

function checkAccount(
  pamh: PamHandle<LinuxPamHost>, service: string, tty: string, user: string, now: ClockNow,
): number {
  const content = pamh.host.readFile(GROUP_CONF);
  const state = pamh.host.process;
  const groups = [...state.supplementaryGroups];
  let result: number = PamReturn.SUCCESS;
  if (content === null) {
    pamh.syslog('err', `error opening ${GROUP_CONF}: No such file or directory`);
  } else {
    const scanner: Scanner = { content, position: 0, state: 'newline' };
    let count = 0;
    do {
      const first = readField(pamh, scanner);
      if (first === null || first === '') continue;
      count++;
      if (scanner.state !== 'field') {
        pamh.syslog('err', `${GROUP_CONF}: malformed rule #${count}`);
        continue;
      }
      let good = logicField(pamh, first, count, (member) => isSame(service, member));
      const ttyField = readField(pamh, scanner) ?? '';
      if (scanner.state !== 'field') {
        pamh.syslog('err', `${GROUP_CONF}: malformed rule #${count}`);
        continue;
      }
      good = good && logicField(pamh, ttyField, count, (member) => isSame(tty, member));
      const userField = readField(pamh, scanner) ?? '';
      if (scanner.state !== 'field') {
        pamh.syslog('err', `${GROUP_CONF}: malformed rule #${count}`);
        continue;
      }
      if (userField[0] === '@') good = false;
      else if (userField[0] === '%') good = good && pamh.host.accounts.groupNames(user).includes(userField.slice(1));
      else good = good && logicField(pamh, userField, count, (member) => isSame(user, member));
      const timeField = readField(pamh, scanner) ?? '';
      if (scanner.state !== 'field') {
        pamh.syslog('err', `${GROUP_CONF}: malformed rule #${count}`);
        continue;
      }
      good = good && logicField(pamh, timeField, count, (member, rule) => checkTime(pamh, now, member, rule));
      const groupField = readField(pamh, scanner) ?? '';
      if (scanner.state === 'field') {
        pamh.syslog('err', `${GROUP_CONF}: poorly terminated rule #${count}`);
        continue;
      }
      if (good) {
        for (const name of groupMembers(groupField)) {
          const group = pamh.host.accounts.findGroup(name);
          if (group === null) pamh.syslog('err', `bad group: ${name}`);
          else groups.push(group.gid);
        }
      }
    } while (scanner.state !== 'eof');
  }
  if (groups.length > 0) {
    if (pamh.host.caller.euid !== 0) {
      pamh.syslog('err', 'unable to set the group membership for user: Operation not permitted');
      result = PamReturn.CRED_ERR;
    } else {
      state.supplementaryGroups = groups;
    }
  }
  return result;
}

function* setcred(pamh: PamHandle<LinuxPamHost>, flags: number): PamConversationFlow<number> {
  if ((flags & (PamFlag.ESTABLISH_CRED | PamFlag.REINITIALIZE_CRED)) === 0) return PamReturn.SUCCESS;
  const lookup = yield* pamh.getUser();
  if (lookup.code !== PamReturn.SUCCESS || lookup.value === null || lookup.value === '') {
    pamh.syslog('notice', 'cannot determine user name');
    return PamReturn.USER_UNKNOWN;
  }
  return checkAccount(pamh, pamh.service, ttyName(pamh), lookup.value, clockNow(pamh));
}

export const pamGroupModule: PamModuleImplementation<LinuxPamHost> = {
  authenticate: () => PamReturn.IGNORE,
  setcred: (pamh, flags) => setcred(pamh, flags),
};
