/**
 * WindowsSshClient — outbound `ssh user@host` for Windows machines.
 *
 * The Windows analogue of {@link runSshClient}: it resolves the target
 * through the simulated topology, asks the remote machine whether its
 * OpenSSH server is accepting connections, applies the login policy and
 * — on success — returns the transcript a Windows OpenSSH client would
 * print (the remote command prompt banner, or a remote command's
 * output in exec mode).
 *
 * It is built section by section alongside the Windows SSH test suite,
 * mirroring the Linux suite. Today it covers the happy-path connect.
 */

import { findHostByAddress } from '../../linux/network/HostLookup';
import { SshKnownHostsFile } from '../../../protocols/ssh/SshKnownHostsFile';

export interface WinSshClientResult {
  output: string;
  exitCode: number;
}

export interface WinSshClientOpts {
  /** argv passed to `ssh` (excluding the verb). */
  args: string[];
  /** Local hostname — appears in the remote's logon record. */
  sourceHostname: string;
  /** Local IP — the "from" address of the connection. */
  sourceIp: string;
  /** Local user invoking `ssh` (the default remote user). */
  sourceUser: string;
  /** Optional NTFS filesystem — needed to persist known_hosts on first connect. */
  localFs?: {
    readFile: (p: string) => { ok: boolean; content?: string };
    createFile: (p: string, content: string) => { ok: boolean; error?: string };
  };
  /** %USERPROFILE% for the current user (default `C:\Users\<user>`). */
  sourceHome?: string;
}

/**
 * The capabilities the SSH client needs from a remote Windows machine.
 * Implemented by {@link WindowsPC}; kept structural to avoid a circular
 * import between the device and its client command.
 */
export interface WindowsSshTarget {
  /** Whether the OpenSSH server (`sshd` service) is accepting connections. */
  isSshActive(): boolean;
  /** Login-policy decision for a user (account exists, enabled, …). */
  sshdAcceptsLogin(user: string): { ok: boolean; reason?: string };
  /** Record the connection attempt in the remote's audit trail. */
  recordSshLogin(user: string, fromIp: string, fromHost: string, accepted: boolean): void;
  /** The remote's command-prompt version banner. */
  sshBanner(): string;
  /** Run a command on the remote as `user`, in exec mode. */
  runSshCommand(
    user: string,
    command: string,
  ): Promise<{ output: string; exitCode: number }> | { output: string; exitCode: number };
}

const RE_USERHOST = /^(?:([\w.\-\\]+)@)?([\w.-]+)$/;

/** SSH short options that consume a value — used to skip them in argv. */
const SSH_VALUE_FLAGS = new Set(['p', 'i', 'l', 'o', 'L', 'R', 'D', 'F', 'c', 'm', 'J', 'b', 'E', 'S', 'W', 'w']);

/**
 * Split argv into option flags and positionals (host, then the remote
 * command). Combined short-flag bundles are expanded; a value-taking
 * flag captures its argument. Everything after the host is the remote
 * command — matching OpenSSH semantics.
 */
function splitSshArgs(args: string[]): { positional: string[]; flags: string[] } {
  const positional: string[] = [];
  const flags: string[] = [];
  let hostFound = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (hostFound || !a.startsWith('-') || a === '-') {
      positional.push(a);
      hostFound = true;
      continue;
    }
    if (a.startsWith('--')) { flags.push(a); continue; }
    const chars = a.slice(1);
    for (let c = 0; c < chars.length; c++) {
      const ch = chars[c];
      flags.push('-' + ch);
      if (SSH_VALUE_FLAGS.has(ch)) {
        const glued = chars.slice(c + 1);
        flags.push(glued !== '' ? glued : (args[++i] ?? ''));
        break;
      }
    }
  }
  return { positional, flags };
}

/** Resolve `-p <port>` from the flag list (default 22). */
function clientPort(flags: string[]): number {
  const i = flags.indexOf('-p');
  if (i >= 0 && flags[i + 1]) {
    const n = Number.parseInt(flags[i + 1], 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return 22;
}

/** Resolve the `-l <user>` login-name flag, or null when absent. */
function clientLoginUser(flags: string[]): string | null {
  const i = flags.indexOf('-l');
  return i >= 0 && flags[i + 1] ? flags[i + 1] : null;
}

export async function runWindowsSshClient(
  opts: WinSshClientOpts,
): Promise<WinSshClientResult> {
  const { positional, flags } = splitSshArgs(opts.args);
  const target = positional[0];
  const port = clientPort(flags);

  // The local network stack must be up to even attempt a handshake.
  if (opts.sourceIp === '127.0.0.1' || !opts.sourceIp) {
    return {
      output: `ssh: connect to host ${target ?? ''} port ${port}: Network is unreachable\n`,
      exitCode: 255,
    };
  }
  if (!target) {
    return { output: 'usage: ssh [-options] destination [command]', exitCode: 1 };
  }

  const parsed = RE_USERHOST.exec(target);
  if (!parsed) {
    return {
      output: `ssh: Could not resolve hostname ${target}: Name or service not known\n`,
      exitCode: 255,
    };
  }
  // Precedence: `user@host` overrides `-l user`, which overrides the
  // local user — matching OpenSSH.
  const remoteUser = parsed[1] ?? clientLoginUser(flags) ?? opts.sourceUser;
  const host = parsed[2];

  // A loopback target resolves to this very machine — look it up by the
  // local source IP, which the topology registry knows.
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const found = findHostByAddress(isLoopback ? opts.sourceIp : host);
  if (!found) {
    return {
      output: `ssh: Could not resolve hostname ${host}: Name or service not known\n`,
      exitCode: 255,
    };
  }
  if (found.poweredOff || found.interfaceDown) {
    return {
      output: `ssh: connect to host ${host} port ${port}: No route to host\n`,
      exitCode: 255,
    };
  }

  // Only a Windows machine running an OpenSSH server answers; anything
  // else (router, switch, …) refuses the connection.
  const machine = found.device as unknown as Partial<WindowsSshTarget>;
  if (typeof machine.isSshActive !== 'function') {
    return {
      output: `ssh: connect to host ${host} port ${port}: Connection refused\n`,
      exitCode: 255,
    };
  }
  const remote = machine as WindowsSshTarget;

  if (!remote.isSshActive()) {
    remote.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: `ssh: connect to host ${host} port ${port}: Connection refused\n`,
      exitCode: 255,
    };
  }

  // Login-policy gate (account exists, enabled, allowed, …).
  const login = remote.sshdAcceptsLogin(remoteUser);
  if (!login.ok) {
    remote.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: `${remoteUser}@${host}: Permission denied (publickey,password).`,
      exitCode: 255,
    };
  }

  remote.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, true);

  // First-connect TOFU: append the remote host key to %USERPROFILE%\.ssh\
  // known_hosts. Mirrors OpenSSH-for-Windows under StrictHostKeyChecking=
  // accept-new (the operator's typical default).
  if (opts.localFs) {
    const remoteAny = remote as unknown as { getSshHostKey?: () => { type: string; publicKey: string } };
    const hk = remoteAny.getSshHostKey?.();
    if (hk) {
      const home = opts.sourceHome ?? 'C:\\Users\\User';
      const path = `${home}\\.ssh\\known_hosts`;
      const existing = opts.localFs.readFile(path);
      const body = existing.ok ? (existing.content ?? '') : '';
      const file = SshKnownHostsFile.parse(body);
      if (!file.find(host)) {
        const updated = file.add({ hostnames: [host], keyType: hk.type, publicKey: hk.publicKey });
        opts.localFs.createFile(path, updated.serialize());
      }
    }
  }

  // Exec mode: a command after the host runs on the remote with no banner.
  const remoteCmd = positional.slice(1).join(' ').trim();
  if (remoteCmd) {
    const r = await remote.runSshCommand(remoteUser, remoteCmd);
    const normalised = r.output && !r.output.endsWith('\n') ? `${r.output}\n` : r.output;
    return { output: normalised, exitCode: r.exitCode };
  }

  // `-q` (quiet) connects but suppresses banner output.
  if (flags.includes('-q')) {
    return { output: '', exitCode: 0 };
  }

  // Interactive form: the remote command-prompt banner, then the
  // OpenSSH "Connection to <host> closed." line.
  const lines = [remote.sshBanner().replace(/^\n+/, ''), '', `Connection to ${host} closed.`];
  return { output: lines.join('\n'), exitCode: 0 };
}
