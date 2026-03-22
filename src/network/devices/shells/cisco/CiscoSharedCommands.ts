/**
 * CiscoSharedCommands — Commands shared between CiscoIOSShell (Router) and
 * CiscoSwitchShell (Switch).
 *
 * Eliminates DRY violations where identical commands are registered
 * independently in both shell classes.
 *
 * Shared commands:
 *   - enable (user → privileged)
 *   - configure terminal (privileged → config)
 *   - disable (privileged → user)
 *   - write memory / copy running-config startup-config
 *   - hostname (config)
 */

import type { CommandTrie } from '../CommandTrie';

// ─── User Mode Shared Commands ───────────────────────────────────

/**
 * Register common user-mode commands on a trie.
 */
export function registerSharedUserCommands(
  trie: CommandTrie,
  setMode: (mode: string) => void,
): void {
  trie.register('enable', 'Enter privileged EXEC mode', () => {
    setMode('privileged');
    return '';
  });
}

// ─── Privileged Mode Shared Commands ─────────────────────────────

export interface PrivilegedCommandsOptions {
  setMode: (mode: string) => void;
  onSave?: () => string;
}

/**
 * Register common privileged-mode commands on a trie.
 */
export function registerSharedPrivilegedCommands(
  trie: CommandTrie,
  opts: PrivilegedCommandsOptions,
): void {
  trie.register('enable', 'Enter privileged EXEC mode (already in)', () => '');

  trie.register('configure terminal', 'Enter configuration mode', () => {
    opts.setMode('config');
    return 'Enter configuration commands, one per line.  End with CNTL/Z.';
  });

  trie.register('disable', 'Return to user EXEC mode', () => {
    opts.setMode('user');
    return '';
  });

  const saveHandler = opts.onSave ?? (() => 'Building configuration...\n[OK]');

  trie.register('copy running-config startup-config', 'Save configuration', () => {
    return saveHandler();
  });

  trie.register('write memory', 'Save configuration', () => {
    return saveHandler();
  });
}

// ─── Config Mode Shared Commands ─────────────────────────────────

export interface ConfigCommandsOptions {
  setHostname: (name: string) => void;
  selectInterface: (portName: string) => void;
  resolveInterfaceName: (input: string) => string | null;
  getPort: (name: string) => unknown | undefined;
}

/**
 * Register common config-mode commands on a trie.
 * Specific commands (VLANs, routing, etc.) are registered by each shell.
 */
export function registerSharedConfigCommands(
  trie: CommandTrie,
  opts: ConfigCommandsOptions,
): void {
  trie.registerGreedy('hostname', 'Set system hostname', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    opts.setHostname(args[0]);
    return '';
  });
}
