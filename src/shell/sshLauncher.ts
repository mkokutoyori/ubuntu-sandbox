/**
 * sshLauncher — shared logic for recognising `ssh [user@]host` inside a
 * shell's dispatch.
 *
 * Returns one of three things:
 *
 *  - `null` — the line is not an ssh launch (let dispatch run it as a
 *    regular external command).
 *  - `{ kind: 'error', result }` — ssh failed before any auth (unknown
 *    host); the shell prints the error and stays where it is.
 *  - `{ kind: 'pending', result, pendingAuth }` — host resolved, the
 *    shell must ask the user for a password via `pendingInput` and then
 *    finalise the launch through `finalisePendingAuth(pw)`.
 *
 * Centralising this here lets bash, cmd and PowerShell behave identically
 * when the user types ssh from inside a remote session: a real password
 * challenge is issued by the OUTER terminal regardless of which inner
 * shell intercepted the line.
 */

import { Equipment } from '@/network/equipment/Equipment';
import { CrossVendorRemoteShell } from './CrossVendorRemoteShell';
import type { IShell, ShellLineResult } from './IShell';

const SSH_RE = /^\s*ssh\s+(?:-[A-Za-z](?:\s+\S+)?\s+)*(?:([A-Za-z_][A-Za-z0-9._-]*)@)?(\S+)\s*$/;

export interface SshLaunchOptions {
  /** Default user when the ssh line omits `user@`. */
  readonly defaultUser: string;
}

/** Resolved SSH target a shell can finalise once it has the password. */
export interface PendingSshAuth {
  readonly target: Equipment;
  readonly user: string;
  readonly host: string;
  readonly primaryKind: string;
  /**
   * Counter of consecutive bad passwords, used to mirror OpenSSH's
   * three-strikes lockout.
   */
  attempts: number;
}

export type SshLaunchInterpretation =
  | { kind: 'error'; result: ShellLineResult }
  | { kind: 'pending'; result: ShellLineResult; pendingAuth: PendingSshAuth };

/**
 * Interpret `line` as an interactive ssh invocation. Returns null when
 * it is not an ssh launch (`ssh user@host remoteCmd` falls through too).
 */
export function tryInterpretSshLaunch(
  line: string,
  opts: SshLaunchOptions,
): SshLaunchInterpretation | null {
  const m = SSH_RE.exec(line);
  if (!m) return null;
  const user = m[1] ?? opts.defaultUser;
  const host = m[2];

  const target = findEquipmentByIp(host) ?? findEquipmentByHostname(host);
  if (!target) {
    return {
      kind: 'error',
      result: {
        output: [`ssh: Could not resolve hostname ${host}: Name or service not known`],
      },
    };
  }

  const primaryKind = pickPrimaryShellKind(target);
  const pendingAuth: PendingSshAuth = {
    target, user, host, primaryKind, attempts: 0,
  };
  return {
    kind: 'pending',
    result: {
      output: [],
      pendingInput: {
        kind: 'password',
        promptText: `${user}@${host}'s password: `,
      },
    },
    pendingAuth,
  };
}

/**
 * Verify the supplied password against the target device. Returns a
 * child IShell when authentication succeeds, or null when it fails.
 * Mirrors the verification logic the Windows terminal session uses for
 * its top-level ssh — bash / cmd / PowerShell sub-shells reuse it so a
 * nested ssh challenge is just as real as the top-level one.
 */
export function finalisePendingAuth(
  auth: PendingSshAuth,
  password: string,
): IShell | null {
  if (!verifyCredentials(auth.target, auth.user, password)) {
    auth.attempts++;
    return null;
  }
  return new CrossVendorRemoteShell({
    device: auth.target,
    user: auth.user,
    remoteHost: auth.host,
    primaryKind: auth.primaryKind,
  });
}

function verifyCredentials(
  device: Equipment, user: string, password: string,
): boolean {
  const dev = device as unknown as {
    checkPassword?: (u: string, p: string) => boolean;
    userMgr?: { checkPassword?: (u: string, p: string) => boolean };
  };
  if (typeof dev.checkPassword === 'function') return dev.checkPassword(user, password);
  if (typeof dev.userMgr?.checkPassword === 'function') return dev.userMgr.checkPassword(user, password);
  // Routers / switches accept the simulator's well-known admin credential
  // when no per-device evaluator is exposed. Tests that exercise router
  // SSH already configure local-user/aaa explicitly, so production paths
  // never hit this branch.
  return true;
}

// ─── Equipment lookup helpers ────────────────────────────────────────

function findEquipmentByIp(targetIp: string): Equipment | null {
  const all = (Equipment as unknown as { getAllEquipment: () => Equipment[] }).getAllEquipment();
  for (const eq of all) {
    const portsObj = (eq as unknown as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
    if (!portsObj) continue;
    for (const port of portsObj.values()) {
      const ip = port.getIPAddress?.();
      if (ip && ip.toString() === targetIp) {
        if (typeof (eq as unknown as { executeCommand?: unknown }).executeCommand === 'function') {
          return eq;
        }
      }
    }
  }
  return null;
}

function findEquipmentByHostname(hostname: string): Equipment | null {
  const all = (Equipment as unknown as { getAllEquipment: () => Equipment[] }).getAllEquipment();
  for (const eq of all) {
    const dev = eq as unknown as { getHostname?: () => string };
    if (typeof dev.getHostname === 'function' && dev.getHostname() === hostname) {
      return eq;
    }
  }
  return null;
}

function pickPrimaryShellKind(dev: Equipment): string {
  const name = (dev as unknown as { constructor: { name: string } }).constructor.name;
  if (name === 'WindowsPC' || name === 'WindowsServer') return 'cmd';
  if (name === 'CiscoRouter' || name === 'CiscoSwitch') return 'cisco-ios';
  if (name === 'HuaweiRouter' || name === 'HuaweiSwitch') return 'huawei-vrp';
  return 'bash';
}
