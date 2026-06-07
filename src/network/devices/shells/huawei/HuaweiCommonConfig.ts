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
export function registerHuaweiCommonMgmt(trie: CommandTrie, debugFlags?: Set<string>): void {
  const onDebug = (label: string) => { debugFlags?.add(label); };
  const offDebug = (label?: string) => {
    if (!debugFlags) return;
    if (!label) { debugFlags.clear(); return; }
    debugFlags.delete(label);
  };
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
  trie.registerGreedy('debugging ip icmp', 'Enable ICMP debugging', (args) => {
    const what = `ip icmp${args.length ? ' ' + args.join(' ') : ''}`;
    onDebug(`${what} debugging is on`);
    return `Info: ${what} debugging is on.`;
  });
  trie.registerGreedy('debugging ip packet', 'Enable IP packet debugging', (args) => {
    const what = `ip packet${args.length ? ' ' + args.join(' ') : ''}`;
    onDebug(`${what} debugging is on`);
    return `Info: ${what} debugging is on.`;
  });
  trie.registerGreedy('undo debugging ip icmp', 'Disable ICMP debugging', () => {
    offDebug('ip icmp debugging is on');
    return 'Info: ip icmp debugging is off.';
  });
  trie.registerGreedy('undo debugging ip packet', 'Disable IP packet debugging', () => {
    offDebug('ip packet debugging is on');
    return 'Info: ip packet debugging is off.';
  });
  trie.registerGreedy('debugging', 'Enable debugging', (args) => {
    const what = args.join(' ') || 'all';
    onDebug(`${what} debugging is on`);
    return `Info: ${what} debugging is on.`;
  });
  trie.registerGreedy('undo debugging', 'Disable debugging', (args) => {
    if (args.join(' ').toLowerCase().startsWith('all')) {
      offDebug();
      return 'Info: All possible debugging functions are off.';
    }
    offDebug(`${args.join(' ')} debugging is on`);
    return `Info: ${args.join(' ')} debugging is off.`;
  });
}
