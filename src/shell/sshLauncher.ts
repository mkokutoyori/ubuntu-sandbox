/**
 * sshLauncher — shared helper for recognising `ssh [user@]host` inside a
 * shell's dispatch and pushing a CrossVendorRemoteShell as the child.
 *
 * Centralising the lookup, hostname resolution and primary-shell pick
 * here means bash, cmd and PowerShell all behave identically when the
 * user types ssh from inside a remote session — that is what unlocks
 * deeply-nested chains like
 *
 *     Win cmd → SSH → Linux bash → SSH → Win cmd → PS → SSH → Cisco
 *
 * without forcing every shell adapter to reimplement the same logic.
 */

import { Equipment } from '@/network/equipment/Equipment';
import { CrossVendorRemoteShell } from './CrossVendorRemoteShell';
import type { IShell, ShellLineResult } from './IShell';

const SSH_RE = /^\s*ssh\s+(?:-[A-Za-z](?:\s+\S+)?\s+)*(?:([A-Za-z_][A-Za-z0-9._-]*)@)?(\S+)\s*$/;

export interface SshLaunchOptions {
  /** Default user when the ssh line omits `user@`. */
  readonly defaultUser: string;
}

/**
 * If `line` parses as an interactive `ssh [user@]host` invocation and
 * the host resolves to a simulator equipment with a known primary
 * shell, return a `ShellLineResult` that pushes the remote shell as
 * the child. Otherwise return null so the caller's dispatch runs ssh
 * as a regular external command (or prints its own error).
 */
export function tryInterpretSshLaunch(
  line: string,
  opts: SshLaunchOptions,
): ShellLineResult | null {
  const m = SSH_RE.exec(line);
  if (!m) return null;
  const user = m[1] ?? opts.defaultUser;
  const host = m[2];

  const target = findEquipmentByIp(host) ?? findEquipmentByHostname(host);
  if (!target) {
    return {
      output: [`ssh: Could not resolve hostname ${host}: Name or service not known`],
    };
  }
  const kind = pickPrimaryShellKind(target);
  const child: IShell = new CrossVendorRemoteShell({
    device: target,
    user,
    remoteHost: host,
    primaryKind: kind,
  });
  return { output: [], childShell: child };
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
