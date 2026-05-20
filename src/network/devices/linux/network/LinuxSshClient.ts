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
import { SshKnownHostEntry, type SshHostKeyType } from './SshKnownHostEntry';
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
  /** Local VFS — needed to read/write ~/.ssh/known_hosts. */
  localVfs?: {
    readFile: (p: string) => string | null;
    writeFile: (p: string, c: string, uid: number, gid: number, umask: number) => void;
    resolveInode?: (p: string) => unknown;
    mkdirp?: (p: string, perm: number, uid: number, gid: number) => boolean;
  };
  /** Home dir for the source user (resolves the path of ~/.ssh/known_hosts). */
  sourceHome?: string;
}

const RE_USERHOST = /^(?:([\w.-]+)@)?([\w.-]+)$/;

/** SSH options that consume a single value (so we can skip them in argv scan). */
const SSH_OPTS_WITH_VALUE = new Set(['-p', '-i', '-l', '-o', '-L', '-R', '-D', '-F', '-c', '-m', '-J']);

/**
 * Walk argv: return positional args (host, then command tokens) and
 * detected options. Once the host token is found (the first positional),
 * everything that follows is treated as the remote command — even tokens
 * that look like options. This matches OpenSSH semantics where flags
 * after the host belong to the remote shell, e.g. `ssh host sudo -l`.
 */
function splitSshArgs(args: string[]): { positional: string[]; flags: string[] } {
  const positional: string[] = [];
  const flags: string[] = [];
  let hostFound = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (hostFound) { positional.push(a); continue; }
    if (a.startsWith('-') && SSH_OPTS_WITH_VALUE.has(a)) { flags.push(a, args[++i] ?? ''); continue; }
    if (a.startsWith('-')) { flags.push(a); continue; }
    positional.push(a);
    hostFound = true;
  }
  return { positional, flags };
}

export function runSshClient(opts: SshClientOpts): SshClientResult {
  const { positional } = splitSshArgs(opts.args);
  const target = positional[0];
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
  const remoteUser = parsed[1] ?? opts.sourceUser ?? 'root';
  const host = parsed[2];

  const found = findHostByAddress(host);
  if (!found) {
    return {
      output: `ssh: Could not resolve hostname ${host}: Name or service not known\n`,
      exitCode: 255,
    };
  }

  // The discovered Equipment may be a router/switch — only LinuxMachine
  // (PC or Server) ships a sshd; everything else refuses on principle.
  const machine = found.device as LinuxMachine & {
    isServiceActive?: (n: string) => boolean;
    sshdAcceptsLogin?: (u: string) => { ok: boolean; reason?: string };
    recordSshLogin?: (u: string, fromIp: string, fromHost: string, accepted: boolean) => void;
    executor?: { execute: (cmd: string) => string; userMgr?: unknown; vfs?: unknown };
  };
  if (typeof machine.isServiceActive !== 'function') {
    return {
      output: `ssh: connect to host ${host} port 22: Connection refused\n`,
      exitCode: 255,
    };
  }

  // Reactive gate: only an active sshd accepts the TCP handshake.
  if (!machine.isServiceActive('ssh')) {
    machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: `ssh: connect to host ${host} port 22: Connection refused\n`,
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

  // Update the local ~/.ssh/known_hosts with the remote's host key (or
  // emit the OpenSSH-style identification-changed warning when the key
  // already present differs from the remote's).
  const keyChanged = updateKnownHosts(opts, machine, found.ip);
  if (keyChanged) {
    return {
      output:
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
        '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n' +
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
        'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n' +
        `Add correct host key in /root/.ssh/known_hosts to get rid of this message.\n` +
        `Offending key in /root/.ssh/known_hosts:1\n`,
      exitCode: 255,
    };
  }

  // If the user provided a remote command, execute it on the remote
  // through the user's login shell and return its output / exit code.
  // This is OpenSSH's "exec mode" — no banner, no Last login.
  const remoteCmd = positional.slice(1).join(' ').trim();
  if (remoteCmd) {
    const remoteUidBeforeAfter = swapRemoteUser(machine, remoteUser);
    let execOut = '';
    let execRc = 0;
    try {
      const execMod = machine.executor as undefined | { execute: (c: string) => string; lastExitCode?: number };
      execOut = execMod?.execute?.(remoteCmd) ?? '';
      execRc = execMod?.lastExitCode ?? 0;
    } finally {
      remoteUidBeforeAfter?.();
    }
    return { output: execOut, exitCode: execRc };
  }

  // Interactive form (no command): the simulator returns the typical
  // login banner composition so downstream scripts see a coherent
  // transcript.
  const remoteVfs = (machine as LinuxMachine & { executor: { vfs: { readFile: (p: string) => string | null } } }).executor.vfs;
  const issueNet = remoteVfs.readFile('/etc/issue.net') ?? '';
  const motd     = remoteVfs.readFile('/etc/motd')      ?? '';

  // -q / -Q (quiet) suppresses banner output (still connects). Match
  // OpenSSH: stay silent on success.
  const quiet = opts.args.some(a => a === '-q' || a === '-Q');
  if (quiet) {
    return { output: '', exitCode: 0 };
  }

  const lines: string[] = [];
  if (issueNet.trim()) lines.push(issueNet.replace(/\n*$/, ''));
  lines.push(`Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)`);
  lines.push(`Last login: ${new Date().toUTCString().replace(/^... /, '')} from ${opts.sourceHostname}`);
  if (motd.trim()) lines.push(motd.replace(/\n*$/, ''));
  lines.push(`Connection to ${host} closed.`);
  return { output: lines.join('\n'), exitCode: 0 };
}

/**
 * Switch the remote machine's "current user" context for the duration of
 * an exec-mode command, then restore it. Returns the restorer.
 */
/**
 * Read the remote's host public key, find/append the matching entry in
 * the local ~/.ssh/known_hosts. Returns true when an existing entry's
 * key differs from the remote's current key (host-key changed).
 */
function updateKnownHosts(opts: SshClientOpts, machine: LinuxMachine, ip: string): boolean {
  if (!opts.localVfs) return false;
  const remoteVfs = (machine as LinuxMachine & { executor: { vfs: { readFile: (p: string) => string | null } } }).executor.vfs;
  // Read the remote's ed25519 public key (the algorithm we seed everywhere).
  const pubKeyRaw = remoteVfs.readFile('/etc/ssh/ssh_host_ed25519_key.pub') ?? '';
  const tokens = pubKeyRaw.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const keyType = tokens[0] as SshHostKeyType;
  const publicKey = tokens[1];

  const home = opts.sourceHome ?? '/root';
  const knownHostsPath = `${home}/.ssh/known_hosts`;
  const existing = opts.localVfs.readFile(knownHostsPath) ?? '';
  const entries = SshKnownHostEntry.parseFile(existing);
  const found = entries.find(e => e.matches(ip));

  if (found && found.keyType === keyType && found.publicKey !== publicKey) {
    return true; // host key changed → caller emits the big warning
  }
  if (!found) {
    entries.push(new SshKnownHostEntry({ hostnames: [ip], keyType, publicKey }));
    // mkdirp ~/.ssh if missing so the writeFile doesn't fail silently.
    const sshDir = knownHostsPath.replace(/\/[^/]+$/, '');
    if (opts.localVfs.mkdirp && opts.localVfs.resolveInode && !opts.localVfs.resolveInode(sshDir)) {
      opts.localVfs.mkdirp(sshDir, 0o700, 0, 0);
    }
    opts.localVfs.writeFile(knownHostsPath, SshKnownHostEntry.serializeFile(entries), 0, 0, 0o022);
  }
  return false;
}

function swapRemoteUser(machine: LinuxMachine, user: string): (() => void) | null {
  const exec = (machine as LinuxMachine & {
    executor: {
      userMgr: { currentUser: string; currentUid: number; currentGid: number; getUser: (u: string) => { uid: number; gid: number; home?: string } | undefined; useradd: (u: string, o?: object) => void };
      cwd: string;
    };
  }).executor;
  if (!exec?.userMgr) return null;
  // Auto-provision the user if it's not in the remote's /etc/passwd yet.
  if (!exec.userMgr.getUser(user)) exec.userMgr.useradd(user, { m: true, s: '/bin/bash' });
  const target = exec.userMgr.getUser(user);
  const before = {
    user: exec.userMgr.currentUser, uid: exec.userMgr.currentUid, gid: exec.userMgr.currentGid, cwd: exec.cwd,
  };
  if (target) {
    exec.userMgr.currentUser = user;
    exec.userMgr.currentUid = target.uid;
    exec.userMgr.currentGid = target.gid;
    exec.cwd = target.home ?? `/home/${user}`;
  }
  return () => {
    exec.userMgr.currentUser = before.user;
    exec.userMgr.currentUid = before.uid;
    exec.userMgr.currentGid = before.gid;
    exec.cwd = before.cwd;
  };
}
