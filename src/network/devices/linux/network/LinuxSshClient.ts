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
  /**
   * Shell environment of the `ssh` invocation (exported variables plus
   * `VAR=val` prefix assignments). Drives SendEnv/AcceptEnv forwarding.
   */
  callerEnv?: Record<string, string>;
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

/**
 * Ask the remote machine's iptables/ufw filter table whether an
 * inbound TCP SYN from `srcIp` to `dstPort` would be accepted.
 * Returns 'accept' / 'drop' / 'reject'. Defaults to 'accept' if the
 * remote has no firewall manager (e.g. switches).
 */
function inboundFirewallVerdict(machine: LinuxMachine, srcIp: string, dstPort: number): 'accept' | 'drop' | 'reject' {
  const ipt = (machine as LinuxMachine & {
    executor?: { iptables?: { filterPacket: (p: object) => 'accept' | 'drop' | 'reject' } };
  }).executor?.iptables;
  if (!ipt?.filterPacket) return 'accept';
  const dstIp = machine.getPorts().map(p => p.getIPAddress()?.toString()).find(Boolean) ?? '0.0.0.0';
  return ipt.filterPacket({
    direction: 'in', protocol: 6, srcIP: srcIp, dstIP: dstIp,
    srcPort: 50000, dstPort, iface: 'eth0',
  });
}

/** Ports configured by sshd_config on the remote machine — defaults to [22]. */
function sshdConfiguredPorts(machine: LinuxMachine): number[] {
  const raw = (machine as LinuxMachine & {
    executor: { vfs: { readFile: (p: string) => string | null } };
  }).executor.vfs.readFile('/etc/ssh/sshd_config') ?? '';
  const ports = Array.from(raw.matchAll(/^\s*Port\s+(\d+)/gim))
    .map(m => Number(m[1]))
    .filter(n => Number.isFinite(n) && n > 0 && n < 65536);
  return ports.length ? ports : [22];
}

/** Narrow view of a remote machine's executor needed for auth negotiation. */
interface RemoteExecLike {
  vfs: { readFile: (p: string) => string | null };
  userMgr: { getUser: (u: string) => { uid: number; gid: number; home?: string } | undefined };
}

/** Outcome of SSH authentication-method negotiation. */
interface SshAuthResolution {
  /** The method that will be used, or null when authentication fails. */
  method: 'publickey' | 'password' | null;
  /** Methods the client is willing to attempt — drives the failure message. */
  clientMethods: string[];
}

/** Read a single sshd_config directive's first value (lower-cased). */
function readRemoteSshdDirective(exec: RemoteExecLike, name: string): string | null {
  const raw = exec.vfs.readFile('/etc/ssh/sshd_config') ?? '';
  const m = new RegExp(`^\\s*${name}\\s+(\\S+)`, 'im').exec(raw);
  return m ? m[1].toLowerCase() : null;
}

/** Value of a client-side `-o Name=value` / `-o "Name value"` option. */
function clientOption(args: string[], name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' && args[i + 1] !== undefined) {
      const parts = args[i + 1].trim().split(/[=\s]+/);
      if (parts[0]?.toLowerCase() === name.toLowerCase()) {
        return (parts[1] ?? '').toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Local identity public key the client would offer (honours `-i`). The
 * current user's ~/.ssh is searched first; /root/.ssh is also probed
 * since key material is conventionally generated as root.
 */
function localIdentityPublicKey(opts: SshClientOpts): string | null {
  if (!opts.localVfs) return null;
  const home = opts.sourceHome ?? '/root';
  const iIdx = opts.args.indexOf('-i');
  const iVal = iIdx >= 0 ? opts.args[iIdx + 1] : undefined;
  const keyHomes = home === '/root' ? ['/root'] : [home, '/root'];
  const candidates = iVal
    ? [iVal.endsWith('.pub') ? iVal : `${iVal}.pub`]
    : keyHomes.flatMap((h) => [
        `${h}/.ssh/id_ed25519.pub`,
        `${h}/.ssh/id_rsa.pub`,
        `${h}/.ssh/id_ecdsa.pub`,
      ]);
  for (const c of candidates) {
    const data = opts.localVfs.readFile(c);
    if (data && data.trim()) return data.trim();
  }
  return null;
}

/** Whether the remote user's authorized_keys lists the offered identity. */
function remoteAcceptsKey(exec: RemoteExecLike, remoteUser: string, identity: string): boolean {
  const entry = exec.userMgr.getUser(remoteUser);
  const home = entry?.home ?? `/home/${remoteUser}`;
  const ak = exec.vfs.readFile(`${home}/.ssh/authorized_keys`) ?? '';
  const id = identity.split(/\s+/);
  return ak.split('\n').some((line) => {
    const t = line.trim().split(/\s+/);
    return t.length >= 2 && t[0] === id[0] && t[1] === id[1];
  });
}

/**
 * Negotiate the authentication method, mirroring OpenSSH's order: public
 * key first, then password. Honours the server's PubkeyAuthentication /
 * PasswordAuthentication directives and the client's `-o` overrides.
 */
function resolveSshAuthMethod(
  opts: SshClientOpts,
  exec: RemoteExecLike | undefined,
  remoteUser: string,
): SshAuthResolution {
  const clientPubkey = clientOption(opts.args, 'PubkeyAuthentication') !== 'no';
  const clientPassword = clientOption(opts.args, 'PasswordAuthentication') !== 'no';
  const clientMethods: string[] = [];
  if (clientPubkey) clientMethods.push('publickey');
  if (clientPassword) clientMethods.push('password');

  if (!exec) {
    return { method: clientPassword ? 'password' : null, clientMethods };
  }
  const serverPubkey = readRemoteSshdDirective(exec, 'PubkeyAuthentication') !== 'no';
  const serverPassword = readRemoteSshdDirective(exec, 'PasswordAuthentication') !== 'no';

  if (clientPubkey && serverPubkey) {
    const identity = localIdentityPublicKey(opts);
    if (identity && remoteAcceptsKey(exec, remoteUser, identity)) {
      return { method: 'publickey', clientMethods };
    }
  }
  if (clientPassword && serverPassword) {
    return { method: 'password', clientMethods };
  }
  return { method: null, clientMethods };
}

// ─── SendEnv / AcceptEnv environment forwarding ─────────────────────

/** OpenSSH ships these in the stock ssh_config / sshd_config. */
const DEFAULT_ENV_PATTERNS: readonly string[] = ['LANG', 'LC_*'];

/** Match an environment variable name against a glob pattern set. */
function envNameMatches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === name) return true;
    if (!p.includes('*') && !p.includes('?')) return false;
    const re = new RegExp(
      '^' +
        p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    );
    return re.test(name);
  });
}

/** Raw (case-preserving) value of a client-side `-o Name[=| ]value` option. */
function clientOptionRaw(args: string[], name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' && args[i + 1] !== undefined) {
      const m = new RegExp(`^${name}\\s*=?\\s*(.*)$`, 'i').exec(args[i + 1].trim());
      if (m) return m[1];
    }
  }
  return null;
}

/** Collect every value of a directive from an sshd_config / ssh_config blob. */
function collectDirective(content: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^\\s*${name}\\s+(.+)$`, 'i');
  for (const line of content.split('\n')) {
    const m = re.exec(line.trim());
    if (m) out.push(...m[1].trim().split(/\s+/).filter(Boolean));
  }
  return out;
}

/** Patterns the client will send: defaults + ~/.ssh/config, or `-o SendEnv`. */
function clientSendEnvPatterns(opts: SshClientOpts): string[] {
  // An explicit `-o SendEnv ...` overrides the config and the defaults.
  const override = clientOptionRaw(opts.args, 'SendEnv');
  if (override !== null) {
    return override.trim().split(/\s+/).filter(Boolean);
  }
  const patterns = [...DEFAULT_ENV_PATTERNS];
  if (opts.localVfs) {
    const cfg = opts.localVfs.readFile(`${opts.sourceHome ?? '/root'}/.ssh/config`) ?? '';
    patterns.push(...collectDirective(cfg, 'SendEnv'));
  }
  return patterns;
}

/** Patterns the server accepts: defaults + sshd_config AcceptEnv lines. */
function serverAcceptEnvPatterns(exec: RemoteExecLike): string[] {
  const raw = exec.vfs.readFile('/etc/ssh/sshd_config') ?? '';
  return [...DEFAULT_ENV_PATTERNS, ...collectDirective(raw, 'AcceptEnv')];
}

/**
 * Resolve the set of environment variables to forward to the remote
 * command: those the client offers (SendEnv) and the server accepts
 * (AcceptEnv), intersected with the caller's actual environment.
 */
function computeForwardedEnv(
  opts: SshClientOpts,
  exec: RemoteExecLike,
): Record<string, string> {
  const callerEnv = opts.callerEnv;
  if (!callerEnv) return {};
  const send = clientSendEnvPatterns(opts);
  const accept = serverAcceptEnvPatterns(exec);
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(callerEnv)) {
    if (envNameMatches(name, send) && envNameMatches(name, accept)) {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

/** Extract -p <port> from argv (default 22). */
function clientPort(args: string[]): number {
  const i = args.indexOf('-p');
  if (i >= 0 && args[i + 1]) {
    const n = Number.parseInt(args[i + 1], 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return 22;
}

export function runSshClient(opts: SshClientOpts): SshClientResult {
  const { positional } = splitSshArgs(opts.args);
  const target = positional[0];
  const port = clientPort(opts.args);

  // Local network plumbing must be up to even attempt a TCP handshake.
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
  const remoteUser = parsed[1] ?? opts.sourceUser ?? 'root';
  const host = parsed[2];

  // Loopback target (127.0.0.1 / localhost) resolves to this very machine —
  // look it up via the local source IP, which the registry knows.
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const lookupHost = isLoopback ? opts.sourceIp : host;
  const found = findHostByAddress(lookupHost, opts.localVfs);
  if (!found) {
    return {
      output: `ssh: Could not resolve hostname ${host}: Name or service not known\n`,
      exitCode: 255,
    };
  }
  if (found.poweredOff) {
    return {
      output: `ssh: connect to host ${host} port 22: No route to host\n`,
      exitCode: 255,
    };
  }
  if (found.interfaceDown) {
    return {
      output: `ssh: connect to host ${host} port ${port}: No route to host\n`,
      exitCode: 255,
    };
  }

  // The discovered Equipment may be a router/switch — only LinuxMachine
  // (PC or Server) ships a sshd; everything else refuses on principle.
  const machine = found.device as LinuxMachine & {
    isServiceActive?: (n: string) => boolean;
    sshdAcceptsLogin?: (u: string) => { ok: boolean; reason?: string };
    recordSshLogin?: (
      u: string,
      fromIp: string,
      fromHost: string,
      accepted: boolean,
      authMethod?: 'password' | 'publickey',
    ) => void;
    executor?: { execute: (cmd: string) => string; userMgr?: unknown; vfs?: unknown };
  };
  if (typeof machine.isServiceActive !== 'function') {
    return {
      output: `ssh: connect to host ${host} port 22: Connection refused\n`,
      exitCode: 255,
    };
  }

  // Reactive gate: only an active sshd accepts the TCP handshake AND
  // the requested port must match a Port directive in sshd_config.
  if (!machine.isServiceActive('ssh')) {
    machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: `ssh: connect to host ${host} port ${port}: Connection refused\n`,
      exitCode: 255,
    };
  }
  const cfgPorts = sshdConfiguredPorts(machine);
  if (!cfgPorts.includes(port)) {
    machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: `ssh: connect to host ${host} port ${port}: Connection refused\n`,
      exitCode: 255,
    };
  }

  // Inbound firewall (iptables/ufw): synth a SYN packet, ask filter.
  const verdict = inboundFirewallVerdict(machine, opts.sourceIp, port);
  if (verdict === 'drop' || verdict === 'reject') {
    machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: verdict === 'reject'
        ? `ssh: connect to host ${host} port ${port}: Connection refused\n`
        : `ssh: connect to host ${host} port ${port}: Connection timed out\n`,
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

  // Authentication-method negotiation: public key first, then password —
  // honouring both the server's Pubkey/PasswordAuthentication directives
  // and the client's `-o` overrides.
  const remoteExec = machine.executor as unknown as RemoteExecLike | undefined;
  const auth = resolveSshAuthMethod(opts, remoteExec, remoteUser);
  if (!auth.method) {
    machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    return {
      output: `${remoteUser}@${host}: Permission denied (${
        auth.clientMethods.join(',') || 'publickey,password'
      }).`,
      exitCode: 255,
    };
  }

  machine.recordSshLogin?.(
    remoteUser,
    opts.sourceIp,
    opts.sourceHostname,
    true,
    auth.method,
  );

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
      const execMod = machine.executor as undefined | {
        execute: (c: string) => string;
        executeWithEnv?: (c: string, env: Record<string, string>) => string;
        lastExitCode?: number;
      };
      // SendEnv/AcceptEnv forwarding: variables the client offers and the
      // server accepts are overlaid on the remote shell for this command.
      const forwarded = remoteExec
        ? computeForwardedEnv(opts, remoteExec)
        : {};
      execOut =
        Object.keys(forwarded).length > 0 && execMod?.executeWithEnv
          ? execMod.executeWithEnv(remoteCmd, forwarded)
          : execMod?.execute?.(remoteCmd) ?? '';
      execRc = execMod?.lastExitCode ?? 0;
    } finally {
      remoteUidBeforeAfter?.();
    }
    // Terminate the remote command's output with a newline (as a real TTY
    // does) so a following local command starts on its own line.
    const normalised = execOut && !execOut.endsWith('\n') ? `${execOut}\n` : execOut;
    return { output: normalised, exitCode: execRc };
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
