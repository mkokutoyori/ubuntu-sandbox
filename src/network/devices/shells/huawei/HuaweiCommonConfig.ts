/**
 * HuaweiCommonConfig — VRP lifecycle / management commands identical on
 * switches and routers (save, reboot, reset saved-configuration, commit,
 * screen-length, header banner).
 *
 * The simulator is non-interactive, so the Y/N confirmation prompts are
 * skipped and only the final result line is returned. Single source of
 * truth so HuaweiSwitchShell and HuaweiVRPShell don't duplicate it (DRY).
 */

import type { CommandTrie } from '../CommandTrie';

/** `save` / `save force` — persist running config to "flash". */
export function saveConfiguration(): string {
  return [
    'Info: The current configuration was saved to the device successfully.',
  ].join('\n');
}

/** `reset saved-configuration` — erase the startup config. */
export function resetSavedConfiguration(): string {
  return 'Info: Succeeded in clearing the configuration in the device.';
}

/** `reboot` — acknowledge (the sim does not actually power-cycle). */
export function rebootDevice(): string {
  return 'Info: The system is now comparing the configuration, please wait.\nInfo: System will reboot.';
}

/** `commit` — two-stage commit; a no-op success in the sim. */
export function commitConfiguration(): string {
  return '';
}

/**
 * `screen-length <n> [temporary]` / `screen-length disable` — terminal
 * paging. No paging in the sim, so this is a recognised no-op.
 */
export function screenLength(): string {
  return '';
}

/**
 * `header {login|shell} information <text>` — banner text. Accepted and
 * stored by the caller if it cares; here it's a recognised no-op so the
 * CLI does not reject it.
 */
export function setHeader(): string {
  return '';
}

/**
 * Register the VRP lifecycle / management commands on a CommandTrie.
 * Called by BOTH HuaweiSwitchShell and HuaweiVRPShell so the wiring
 * itself isn't duplicated (DRY).
 */
export function registerHuaweiCommonMgmt(trie: CommandTrie): void {
  trie.registerGreedy('save', 'Save current configuration', () => saveConfiguration());
  trie.register('reboot', 'Reboot the device', () => rebootDevice());
  trie.register('reset saved-configuration', 'Erase startup configuration', () =>
    resetSavedConfiguration());
  trie.register('commit', 'Commit candidate configuration', () => commitConfiguration());
  trie.registerGreedy('screen-length', 'Set terminal screen length', () => screenLength());
  trie.registerGreedy('header', 'Configure login/shell banner', () => setHeader());
  trie.register('terminal monitor', 'Enable terminal monitoring', () => 'Info: Current terminal monitor is on.');
  trie.register('undo terminal monitor', 'Disable terminal monitoring', () => 'Info: Current terminal monitor is off.');
  trie.register('terminal debugging', 'Enable terminal debugging', () => 'Info: Current terminal debugging is on.');
  trie.register('undo terminal debugging', 'Disable terminal debugging', () => 'Info: Current terminal debugging is off.');
  trie.registerGreedy('debugging ip icmp', 'Enable ICMP debugging', (args) =>
    `Info: ip icmp${args.length ? ' ' + args.join(' ') : ''} debugging is on.`);
  trie.registerGreedy('debugging ip packet', 'Enable IP packet debugging', (args) =>
    `Info: ip packet${args.length ? ' ' + args.join(' ') : ''} debugging is on.`);
  trie.registerGreedy('undo debugging ip icmp', 'Disable ICMP debugging', () =>
    'Info: ip icmp debugging is off.');
  trie.registerGreedy('undo debugging ip packet', 'Disable IP packet debugging', () =>
    'Info: ip packet debugging is off.');
  trie.registerGreedy('debugging', 'Enable debugging', (args) =>
    `Info: ${args.join(' ') || 'all'} debugging is on.`);
  trie.registerGreedy('undo debugging', 'Disable debugging', (args) =>
    args.join(' ').toLowerCase().startsWith('all')
      ? 'Info: All possible debugging functions are off.'
      : `Info: ${args.join(' ')} debugging is off.`);
}
