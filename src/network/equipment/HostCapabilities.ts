/**
 * HostCapabilities — segregated capability interfaces for host-like devices.
 *
 * These methods used to live as stub implementations on the Equipment base
 * class, which violated the Interface Segregation Principle: a CiscoRouter
 * inherited `canSudo()` (returning a lying `true`), `readFileForEditor()`
 * (returning `null`), `getCurrentUid()` (returning 0 — i.e. "root") and so
 * on, none of which mean anything on a router.
 *
 * Devices that genuinely implement a capability declare it with
 * `implements` (LinuxMachine, WindowsPC, Router for credential checks).
 * Consumers either:
 *   - work against {@link HostCapableDevice} and use optional calls
 *     (`device.canSudo?.() ?? false`) so capability absence is explicit
 *     at the call site, or
 *   - narrow with the exported type guards when a whole capability
 *     surface is needed.
 */

import type { Equipment } from './Equipment';

/**
 * Validates <user, password> against the device's local credential store.
 * Single entry point used by SSH/console login regardless of vendor:
 * Linux hosts check /etc/shadow-style state, Windows hosts their SAM,
 * routers their local-user AAA database.
 */
export interface CredentialAuthenticator {
  checkPassword(username: string, password: string): boolean;
}

/** Full local user-account management (Linux / Windows hosts). */
export interface UserAccountHost extends CredentialAuthenticator {
  setUserPassword(username: string, password: string): void;
  userExists(username: string): boolean;
}

/** Per-terminal shell identity and su/sudo session semantics (POSIX-like hosts). */
export interface ShellIdentityHost {
  getCurrentUser(): string;
  getCurrentUid(): number;
  canSudo(): boolean;
  handleExit(): { output: string; inSu: boolean };
}

/** Editable filesystem surface consumed by terminal editors and the Oracle FS sync. */
export interface FileEditorHost {
  getCwd(): string;
  resolveAbsolutePath(path: string): string;
  readFileForEditor(path: string): string | null;
  writeFileFromEditor(path: string, content: string): boolean;
}

/**
 * An Equipment that MAY expose host capabilities. The terminal layer types
 * its device references with this so that capability absence shows up at
 * the call site (`device.getCwd?.() ?? fallback`) instead of being masked
 * by base-class stubs that silently return fake values.
 */
export type HostCapableDevice = Equipment &
  Partial<UserAccountHost & ShellIdentityHost & FileEditorHost>;

const hasFn = (obj: unknown, name: string): boolean =>
  typeof (obj as Record<string, unknown> | null)?.[name] === 'function';

export function isCredentialAuthenticator(dev: unknown): dev is CredentialAuthenticator {
  return hasFn(dev, 'checkPassword');
}

export function isUserAccountHost(dev: unknown): dev is UserAccountHost {
  return hasFn(dev, 'checkPassword')
    && hasFn(dev, 'setUserPassword')
    && hasFn(dev, 'userExists');
}

export function isShellIdentityHost(dev: unknown): dev is ShellIdentityHost {
  return hasFn(dev, 'getCurrentUser')
    && hasFn(dev, 'getCurrentUid')
    && hasFn(dev, 'canSudo')
    && hasFn(dev, 'handleExit');
}

export function isFileEditorHost(dev: unknown): dev is FileEditorHost {
  return hasFn(dev, 'getCwd')
    && hasFn(dev, 'resolveAbsolutePath')
    && hasFn(dev, 'readFileForEditor')
    && hasFn(dev, 'writeFileFromEditor');
}
