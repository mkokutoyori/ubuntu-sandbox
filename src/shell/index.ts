/**
 * Public surface of the new Shell layer.
 *
 * Consumers (terminal sessions, SSH push, etc.) import from this file
 * only — never reaching into `adapters/` directly. The adapters' job
 * is to register themselves with the factory and then stay private.
 */

export type {
  IShell, ShellLineResult, ShellKeyEvent, ShellSpecialAction,
} from './IShell';
export {
  ShellContext, type ShellCredentials, type SuFrame,
} from './ShellContext';
export { AbstractShell, type AbstractShellOptions } from './AbstractShell';
export { ShellFactory, type ShellSpawnArgs, type ShellConstructor } from './ShellFactory';
export { installDefaultShells, reinstallDefaultShells } from './registerDefaults';
