/**
 * Segregated host capability interfaces (formerly lying stubs on Equipment).
 * Hosts declare what they implement; consumers use optional calls
 * (`device.canSudo?.() ?? false`) or the type guards below.
 */

import type { Equipment } from './Equipment';

/** Validates <user, password> against the device's local credential store. */
export interface CredentialAuthenticator {
  checkPassword(username: string, password: string): boolean;
}

/** Local user-account management (Linux / Windows hosts). */
export interface UserAccountHost extends CredentialAuthenticator {
  setUserPassword(username: string, password: string): void;
  userExists(username: string): boolean;
}

/** Shell identity and su/sudo session semantics (POSIX-like hosts). */
export interface ShellIdentityHost {
  getCurrentUser(): string;
  getCurrentUid(): number;
  canSudo(): boolean;
  handleExit(): { output: string; inSu: boolean };
}

/** Editable filesystem surface for terminal editors and the Oracle FS sync. */
export interface FileEditorHost {
  getCwd(): string;
  resolveAbsolutePath(path: string): string;
  readFileForEditor(path: string): string | null;
  writeFileFromEditor(path: string, content: string): boolean;
}

/** An Equipment that MAY expose host capabilities. */
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
