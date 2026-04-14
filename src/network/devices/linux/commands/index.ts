/**
 * Barrel file for the Linux command module.
 *
 * Re-exports the command interfaces and the registry so that callers only
 * ever need to import from `./commands`.
 *
 * The `CORE_LINUX_COMMANDS` array is intentionally empty for Phase 1 — it
 * will be populated during Phase 2 of the migration, as commands are
 * progressively extracted from `LinuxPC` into their own files under
 * `commands/net/`, `commands/dhcp/`, `commands/dns/`, etc.
 *
 * See `linux_gap.md` §8.5 and §9 (Phase 2).
 */

export type { LinuxCommand } from './LinuxCommand';
export type { LinuxCommandContext } from './LinuxCommandContext';
export { LinuxCommandRegistry } from './LinuxCommandRegistry';

import type { LinuxCommand } from './LinuxCommand';

/** Core commands registered on every `LinuxMachine`. Empty until Phase 2. */
export const CORE_LINUX_COMMANDS: readonly LinuxCommand[] = [];
