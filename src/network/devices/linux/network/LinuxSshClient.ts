/**
 * LinuxSshClient — outbound `ssh user@host` simulation.
 *
 * Bridges the local shell, the topology lookup, and the remote SSH
 * server's reactive state. Replaces the hardcoded "Connection refused"
 * with real behavior:
 *
 *   1. Resolve the destination through the simulated topology.
 *   2. Ask the remote device whether its `ssh` service is active
 *      (via {@link OSFeatureGate}, the cross-OS gating utility).
 *   3. Consult `/etc/ssh/sshd_config` for PermitRootLogin.
 *   4. On accept, write to the remote's /var/log/auth.log so the
 *      audit trail is coherent.
 *
 * Used identically by `LinuxPC` and `LinuxServer` — both expose
 * inbound SSH, so the client logic is shared rather than duplicated.
 */

import { findHostByAddress } from './HostLookup';
import type { LinuxMachine } from '../../LinuxMachine';

export interface SshClientResult {
  output: string;
  exitCode: number;
}

export interface SshClientOpts {
  /** argv passed to `ssh` (excluding the verb itself). */
  args: string[];
  /** Local hostname for the line written to auth.log on success. */
  sourceHostname: string;
  /** Local IP — appears as the "from" field in the remote auth.log. */
  sourceIp: string;
  /** Local user invoking ssh (defaults to "root"). */
  sourceUser: string;
}

const RE_USERHOST = /^(?:([\w.-]+)@)?([\w.-]+)$/;

export function runSshClient(opts: SshClientOpts): SshClientResult {
  const positional = opts.args.filter(a => !a.startsWith('-'));
  const target = positional[0];
  if (!target) {
    return { output: 'usage: ssh [-options] destination [command]', exitCode: 1 };
  }

  const parsed = RE_USERHOST.exec(target);
  if (!parsed) {
    return {
      output: `ssh: Could not resolve hostname ${target}: Name or service not known`,
      exitCode: 255,
    };
  }
  const remoteUser = parsed[1] ?? opts.sourceUser ?? 'root';
  const host = parsed[2];

  const found = findHostByAddress(host);
  if (!found) {
    return {
      output: `ssh: Could not resolve hostname ${host}: Name or service not known`,
      exitCode: 255,
    };
  }

  // The discovered Equipment may be a router/switch — only LinuxMachine
  // (PC or Server) ships a sshd; everything else refuses on principle.
  const machine = found.device as LinuxMachine & {
    isServiceActive?: (n: string) => boolean;
    sshdAcceptsLogin?: (u: string) => { ok: boolean; reason?: string };
    recordSshLogin?: (u: string, fromIp: string, fromHost: string, accepted: boolean) => void;
  };
  if (typeof machine.isServiceActive !== 'function') {
    return {
      output: `ssh: connect to host ${host} port 22: Connection refused`,
      exitCode: 255,
    };
  }

  // Reactive gate: only an active sshd accepts the TCP handshake.
  if (!machine.isServiceActive('ssh')) {
    machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: `ssh: connect to host ${host} port 22: Connection refused`,
      exitCode: 255,
    };
  }

  // Login policy gate (root login, allowed users, etc.).
  const login = machine.sshdAcceptsLogin?.(remoteUser) ?? { ok: true };
  if (!login.ok) {
    machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: `${remoteUser}@${host}: Permission denied (publickey,password).`,
      exitCode: 255,
    };
  }

  machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, true);
  // Real ssh would now hand control to the remote shell. The simulator
  // returns the typical "Welcome to" banner and the connection-closed
  // marker so downstream scripts see a sane transcript.
  const banner = `Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)\n`;
  const last = `Last login: ${new Date().toUTCString().replace(/^... /, '')} from ${opts.sourceHostname}\n`;
  return { output: banner + last + `Connection to ${host} closed.`, exitCode: 0 };
}
