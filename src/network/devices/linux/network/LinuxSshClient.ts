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
import { IPAddress } from '../../../core/types';
import { type SshHostKeyType } from './SshKnownHostEntry';
import { SshPortForward } from './SshPortForward';
import type { SshForwardingTable } from './SshForwardingTable';
import type { SshAgent } from '../../../protocols/ssh/SshAgent';
import type { LinuxMachine } from '../../LinuxMachine';
import { isSshExecTarget, type SshExecTarget } from '../../../protocols/ssh/server/SshExecTarget';
import { SshConfig } from '../../../protocols/ssh/SshConfig';
import { SshKnownHostsFile } from '../../../protocols/ssh/SshKnownHostsFile';
import type { CrossVendorSshHost } from '../../../protocols/ssh/server/CrossVendorSshHost';
import { SshConnectionRequest } from '../../../protocols/ssh/server/SshConnectionRequest';
import { SshdServerConfig } from '../../../protocols/ssh/server/SshdServerConfig';

/** The four-tuple of a TCP handshake the SSH client performed. */
export interface SshConnectionTuple {
  localIp: string;
  peerIp: string;
  peerPort: number;
}

export interface SshClientResult {
  output: string;
  exitCode: number;
  /**
   * Set once the TCP handshake reached a live sshd. Lets the caller
   * record the connection for `tcpdump` / socket accounting.
   */
  connection?: SshConnectionTuple;
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
    resolveInode?: (p: string, followSymlinks?: boolean) => { uid: number; gid: number; permissions: number } | null;
    mkdirp?: (p: string, perm: number, uid: number, gid: number) => boolean;
  };
  /** Home dir for the source user (resolves the path of ~/.ssh/known_hosts). */
  sourceHome?: string;
  /**
   * Shell environment of the `ssh` invocation (exported variables plus
   * `VAR=val` prefix assignments). Drives SendEnv/AcceptEnv forwarding.
   */
  callerEnv?: Record<string, string>;
  /**
   * The local machine's port-forwarding table — `-L` / `-D` listeners are
   * bound here so the tunnel surfaces through `ss` / `netstat`.
   */
  localForwarding?: SshForwardingTable;
  /**
   * The local machine's ssh-agent — when `-A` (agent forwarding) is used,
   * its identities are exposed to the remote command for its duration.
   */
  localAgent?: SshAgent;
}

const RE_USERHOST = /^(?:([\w.-]+)@)?([\w.-]+)$/;

/**
 * Short `ssh` options that consume a value — the character right after
 * the dash (`-p 22`, `-L spec`, `-o Name=val`, …). `-q` / `-Q` are
 * deliberately excluded: the simulator treats them as the quiet switch.
 */
const SSH_VALUE_FLAGS = new Set(
  ['b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'p', 'R', 'S', 'W', 'w'],
);

/**
 * Walk argv: separate option flags from positionals (host, then remote
 * command tokens). Combined short-flag bundles (`-fNL`) are expanded into
 * their constituents, and a value-taking flag captures its argument
 * whether it is glued on (`-p22`) or a separate token (`-p 22`).
 *
 * Once the host token (the first positional) is found, everything after
 * it is the remote command — even tokens that look like options — which
 * matches OpenSSH semantics where flags after the host belong to the
 * remote shell, e.g. `ssh host sudo -l`.
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
    // Expand a bundle of short flags: `-fNL` → -f -N -L, `-p22` → -p 22.
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

/**
 * Ask the remote machine's iptables/ufw filter table whether an
 * inbound TCP SYN from `srcIp` to `dstPort` would be accepted.
 * Returns 'accept' / 'drop' / 'reject'. Defaults to 'accept' if the
 * remote has no firewall manager (e.g. switches).
 */
function inboundFirewallVerdict(machine: LinuxMachine, srcIp: string, dstPort: number): 'accept' | 'drop' | 'reject' {
  const exec = (machine as LinuxMachine & {
    executor?: {
      iptables?: { filterPacket: (p: object) => 'accept' | 'drop' | 'reject' };
      firewall?: {
        logBlockedPacket: (o: {
          verdict: 'drop' | 'reject'; iface: string; src: string;
          dst: string; proto: string; sport: number; dport: number;
        }) => void;
      };
    };
  }).executor;
  const ipt = exec?.iptables;
  if (!ipt?.filterPacket) return 'accept';
  const dstIp = machine.getPorts().map(p => p.getIPAddress()?.toString()).find(Boolean) ?? '0.0.0.0';
  const verdict = ipt.filterPacket({
    direction: 'in', protocol: 6, srcIP: srcIp, dstIP: dstIp,
    srcPort: 50000, dstPort, iface: 'eth0',
  });
  // Reactively record the drop in /var/log/ufw.log, as the kernel does.
  if (verdict === 'drop' || verdict === 'reject') {
    exec?.firewall?.logBlockedPacket({
      verdict, iface: 'eth0', src: srcIp, dst: dstIp,
      proto: 'tcp', sport: 50000, dport: dstPort,
    });
  }
  return verdict;
}

function remoteSshdConfig(machine: LinuxMachine): SshdServerConfig {
  const raw = (machine as LinuxMachine & {
    executor: { vfs: { readFile: (p: string) => string | null } };
  }).executor.vfs.readFile('/etc/ssh/sshd_config') ?? '';
  return SshdServerConfig.parse(raw);
}

function sshdConfiguredPorts(machine: LinuxMachine): readonly number[] {
  return remoteSshdConfig(machine).ports;
}

/** Narrow view of a remote machine's executor needed for auth negotiation. */
interface RemoteExecLike {
  vfs: {
    readFile: (p: string) => string | null;
    resolveInode?: (p: string, followSymlinks?: boolean) => { uid: number; gid: number; permissions: number } | null;
  };
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
function localIdentityPublicKey(opts: SshClientOpts, flags: string[]): string | null {
  // Files on disk (or the explicit -i) take precedence over the agent —
  // matching OpenSSH's identity resolution order.
  if (opts.localVfs) {
    const home = opts.sourceHome ?? '/root';
    const iIdx = flags.indexOf('-i');
    const iVal = iIdx >= 0 ? flags[iIdx + 1] : undefined;
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
  }
  // Agent fallback — when no on-disk identity matches but the SSH agent
  // holds keys (e.g. linux2's adopted agent after -A from linux1), offer
  // the first agent key's public-key line. Real OpenSSH iterates them;
  // one is enough for the simulator's match against authorized_keys.
  const agentKeys = opts.localAgent?.list();
  for (const k of agentKeys ?? []) {
    if (k.publicKey) return k.publicKey;
  }
  return null;
}

/** Whether the remote user's authorized_keys lists the offered identity. */
function remoteAcceptsKey(exec: RemoteExecLike, remoteUser: string, identity: string): boolean {
  const entry = exec.userMgr.getUser(remoteUser);
  if (!entry) return false;
  const home = entry.home ?? `/home/${remoteUser}`;
  if (!passesStrictModes(exec, entry.uid, home)) return false;
  const ak = exec.vfs.readFile(`${home}/.ssh/authorized_keys`) ?? '';
  const id = identity.split(/\s+/);
  return ak.split('\n').some((line) => {
    const t = line.trim().split(/\s+/);
    return t.length >= 2 && t[0] === id[0] && t[1] === id[1];
  });
}

/**
 * OpenSSH StrictModes check: ~/.ssh and authorized_keys must be owned by
 * the user (or root) and not be group/world writable. Defaults to enabled
 * (the simulator does not read StrictModes back since OpenSSH ships it
 * as `yes`).
 */
function passesStrictModes(exec: RemoteExecLike, userUid: number, home: string): boolean {
  if (!exec.vfs.resolveInode) return true;
  for (const path of [`${home}/.ssh`, `${home}/.ssh/authorized_keys`]) {
    const inode = exec.vfs.resolveInode(path, true);
    if (!inode) continue;
    if (inode.uid !== userUid && inode.uid !== 0) return false;
    if ((inode.permissions & 0o022) !== 0) return false;
  }
  return true;
}

/**
 * Negotiate the authentication method, mirroring OpenSSH's order: public
 * key first, then password. Honours the server's PubkeyAuthentication /
 * PasswordAuthentication directives and the client's `-o` overrides.
 */
function resolveSshAuthMethod(
  opts: SshClientOpts,
  flags: string[],
  exec: RemoteExecLike | undefined,
  remoteUser: string,
): SshAuthResolution {
  const clientPubkey = clientOption(flags, 'PubkeyAuthentication') !== 'no';
  const clientPassword = clientOption(flags, 'PasswordAuthentication') !== 'no';
  const clientMethods: string[] = [];
  if (clientPubkey) clientMethods.push('publickey');
  if (clientPassword) clientMethods.push('password');

  if (!exec) {
    return { method: clientPassword ? 'password' : null, clientMethods };
  }
  const serverPubkey = readRemoteSshdDirective(exec, 'PubkeyAuthentication') !== 'no';
  const serverPassword = readRemoteSshdDirective(exec, 'PasswordAuthentication') !== 'no';

  if (clientPubkey && serverPubkey) {
    const identity = localIdentityPublicKey(opts, flags);
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
function clientSendEnvPatterns(opts: SshClientOpts, flags: string[]): string[] {
  // An explicit `-o SendEnv ...` overrides the config and the defaults.
  const override = clientOptionRaw(flags, 'SendEnv');
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

function serverAcceptEnvPatterns(exec: RemoteExecLike): string[] {
  const raw = exec.vfs.readFile('/etc/ssh/sshd_config') ?? '';
  const cfg = SshdServerConfig.parse(raw);
  return [...DEFAULT_ENV_PATTERNS, ...cfg.acceptEnv];
}

/**
 * Resolve the set of environment variables to forward to the remote
 * command: those the client offers (SendEnv) and the server accepts
 * (AcceptEnv), intersected with the caller's actual environment.
 */
function computeForwardedEnv(
  opts: SshClientOpts,
  flags: string[],
  exec: RemoteExecLike,
): Record<string, string> {
  const callerEnv = opts.callerEnv;
  if (!callerEnv) return {};
  const send = clientSendEnvPatterns(opts, flags);
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

// ─── SSH port forwarding (-L / -R / -D) ─────────────────────────────

/** PID attributed to a backgrounded `ssh` client holding a -L/-D listener. */
const SSH_CLIENT_FORWARD_PID = 2200;
/** PID of the remote sshd that owns a -R listener (matches initDefaultSockets). */
const SSHD_PID = 985;

/**
 * Honour the `-L` / `-R` / `-D` flags: open a listening socket for each
 * forward on whichever host owns it — the client for `-L`/`-D`, the SSH
 * server for `-R`. The server's `AllowTcpForwarding` directive gates the
 * request: `no` blocks everything, `local` permits only `-L`/`-D`,
 * `remote` permits only `-R`, anything else (default) permits all.
 *
 * Returns OpenSSH-style diagnostic text for any forward the policy
 * rejects — empty when every forward is permitted (or none were asked).
 */
function setupPortForwards(
  opts: SshClientOpts,
  flags: string[],
  machine: LinuxMachine,
  remoteExec: RemoteExecLike | undefined,
): string {
  const forwards = SshPortForward.collect(flags);
  if (forwards.length === 0) return '';

  const policy = remoteExec
    ? readRemoteSshdDirective(remoteExec, 'AllowTcpForwarding')
    : null;
  const permits = (f: SshPortForward): boolean => {
    if (policy === 'no') return false;
    if (policy === 'local') return f.kind !== 'remote';
    if (policy === 'remote') return f.kind === 'remote';
    return true; // null / 'yes' / 'all' / unrecognised → OpenSSH default
  };

  const remoteForwarding = (machine as unknown as {
    executor?: { forwardingTable?: SshForwardingTable | null };
  }).executor?.forwardingTable;

  let diagnostics = '';
  for (const fwd of forwards) {
    if (!permits(fwd)) {
      diagnostics +=
        'channel 0: open failed: administratively prohibited: open failed\n';
      continue;
    }
    if (fwd.listensOnServer) {
      // -R : the listener lives on the SSH server, owned by its sshd.
      remoteForwarding?.open(fwd, SSHD_PID, 'sshd');
    } else {
      // -L / -D : the listener lives on the client host, owned by ssh.
      opts.localForwarding?.open(fwd, SSH_CLIENT_FORWARD_PID, 'ssh');
    }
  }
  return diagnostics;
}

export function runSshClient(opts: SshClientOpts): SshClientResult {
  const { positional, flags } = splitSshArgs(opts.args);
  const target = positional[0];
  let port = clientPort(flags);

  // OpenSSH UNPROTECTED PRIVATE KEY check: when `-i path` is given, refuse
  // to load the key if its mode is group/world-readable. Real ssh prints
  // the warning and ignores the key; with no other auth available, this
  // bubbles up as Permission denied.
  const iIdx = flags.indexOf('-i');
  const iVal = iIdx >= 0 ? flags[iIdx + 1] : undefined;
  if (iVal && opts.localVfs?.resolveInode) {
    const inode = opts.localVfs.resolveInode(iVal, true);
    if (inode && (inode.permissions & 0o077) !== 0) {
      return {
        output:
          `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n` +
          `@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n` +
          `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n` +
          `Permissions 0${inode.permissions.toString(8)} for '${iVal}' are too open.\n` +
          `It is required that your private key files are NOT accessible by others.\n` +
          `This private key will be ignored.\n` +
          `Load key "${iVal}": bad permissions\n` +
          `${opts.sourceUser}@${target ?? ''}: Permission denied (publickey,password).`,
        exitCode: 255,
      };
    }
  }

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
  const cfgRaw = opts.localVfs.readFile(`${opts.sourceHome ?? '/root'}/.ssh/config`);
  const cfgEntry = cfgRaw ? SshConfig.parse(cfgRaw).resolve(parsed[2]) : null;
  const remoteUser = parsed[1] ?? cfgEntry?.user ?? opts.sourceUser ?? 'root';
  let host = cfgEntry?.hostName ?? parsed[2];
  if (cfgEntry?.port && !flags.includes('-p')) {
    flags.push('-p', String(cfgEntry.port));
    port = cfgEntry.port;
  }
  if (cfgEntry?.identityFile && !flags.includes('-i')) {
    flags.push('-i', cfgEntry.identityFile);
  }

  // Loopback target (127.0.0.1 / localhost) resolves to this very machine —
  // look it up via the local source IP, which the registry knows.
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  // If the loopback target hits an active `-L` / `-D` forward, retarget
  // through the tunnel's far end (destHost/destPort). Matches what the
  // local OpenSSH forwarder would do on a real machine.
  if (isLoopback && opts.localForwarding) {
    const fwd = opts.localForwarding.list().find(f => f.listenPort === port);
    if (fwd?.destHost && fwd?.destPort) {
      host = fwd.destHost;
      port = fwd.destPort;
    }
  }
  const stillLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const lookupHost = stillLoopback ? opts.sourceIp : host;
  const found = findHostByAddress(lookupHost, opts.localVfs);
  if (!found) {
    // A *valid* numeric IPv4 that nothing on the LAN owns is a routing
    // failure (OpenSSH prints "No route to host"). Strings that merely
    // look like IPs but have out-of-range octets ("10.0.0.999") are
    // treated as hostnames by the resolver, so they keep the original
    // name-resolution error.
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    const isValidIPv4 = m !== null
      && m.slice(1).every(o => Number(o) >= 0 && Number(o) <= 255);
    return {
      output: isValidIPv4
        ? `ssh: connect to host ${host} port ${port}: No route to host\n`
        : `ssh: Could not resolve hostname ${host}: Name or service not known\n`,
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

  // Cross-platform dispatch (Windows / Cisco / Huawei). A target that
  // implements SshExecTarget but is *not* a LinuxMachine (no in-process
  // `executor` shortcut) handles its own auth + exec synchronously.
  const linuxLike = (found.device as Partial<LinuxMachine & { executor: unknown }>).executor !== undefined;
  if (!linuxLike && isSshExecTarget(found.device)) {
    return runCrossPlatformExec(found.device, remoteUser, positional, port, host, opts);
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
  // MaxStartups gate — drop connections from a source that has crossed
  // the configured 'full' threshold of recent failed attempts. Mirrors
  // OpenSSH's accept-loop throttle exactly.
  const throttler = (machine as unknown as { sshThrottler?: {
    shouldDrop: (ip: string, cfg: { start: number; rate: number; full: number }, now: number) => boolean;
  } }).sshThrottler;
  const cfg = remoteSshdConfig(machine);
  if (throttler && throttler.shouldDrop(opts.sourceIp, cfg.maxStartups, Date.now())) {
    return {
      output: `ssh: connect to host ${host} port ${port}: Connection refused (MaxStartups drop)\n`,
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
    throttler?.recordFailure(opts.sourceIp, Date.now());
    return {
      output: `${remoteUser}@${host}: Permission denied (publickey,password).`,
      exitCode: 255,
    };
  }

  // Authentication-method negotiation: public key first, then password —
  // honouring both the server's Pubkey/PasswordAuthentication directives
  // and the client's `-o` overrides.
  const remoteExec = machine.executor as unknown as RemoteExecLike | undefined;
  const auth = resolveSshAuthMethod(opts, flags, remoteExec, remoteUser);
  if (!auth.method) {
    machine.recordSshLogin?.(remoteUser, opts.sourceIp, opts.sourceHostname, false);
    throttler?.recordFailure(opts.sourceIp, Date.now());
    return {
      output: `${remoteUser}@${host}: Permission denied (${
        auth.clientMethods.join(',') || 'publickey,password'
      }).`,
      exitCode: 255,
    };
  }
  // Successful authentication clears the failure history for this IP.
  if (throttler) (throttler as unknown as { reset: (ip: string) => void }).reset(opts.sourceIp);

  machine.recordSshLogin?.(
    remoteUser,
    opts.sourceIp,
    opts.sourceHostname,
    true,
    auth.method,
  );

  // StrictHostKeyChecking=yes — refuse if no known_hosts entry exists
  // for the remote IP. The default behaviour (ask/accept-new) keeps the
  // OpenSSH-style TOFU and is handled by updateKnownHosts() below.
  if (clientOption(flags, 'StrictHostKeyChecking') === 'yes' && opts.localVfs) {
    const home = opts.sourceHome ?? '/root';
    const existing = opts.localVfs.readFile(`${home}/.ssh/known_hosts`) ?? '';
    if (!SshKnownHostsFile.parse(existing).find(found.ip)) {
      return {
        output:
          `No matching host key fingerprint found in DNS.\n` +
          `No ED25519 host key is known for ${found.ip} and you have requested strict checking.\n` +
          `Host key verification failed.`,
        exitCode: 255,
      };
    }
  }

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

  // ── SSH port forwarding (-L / -R / -D) ──────────────────────────────
  // Each requested forward opens a listening socket on whichever host
  // owns it (the client for -L/-D, the SSH server for -R). The server's
  // `AllowTcpForwarding` directive decides whether the request stands.
  const forwardingError = setupPortForwards(opts, flags, machine, remoteExec);

  // `-N` (no remote command) — paired with `-f` to hold a tunnel open.
  // The session carries no shell, so there is no banner: only forwarding
  // diagnostics, if any, are surfaced.
  if (flags.includes('-N')) {
    return { output: forwardingError, exitCode: 0 };
  }

  // The TCP handshake reached a live sshd — record the four-tuple so the
  // caller can feed `tcpdump` / socket accounting.
  const connection: SshConnectionTuple = {
    localIp: opts.sourceIp,
    peerIp: found.ip,
    peerPort: port,
  };

  // `-v` / `-vv` / `-vvv` — verbose: prepend an OpenSSH-style debug trace
  // including the host-key algorithm so test harnesses can verify the
  // server's HostKey directive is honoured end-to-end.
  const verbose = flags.some(a => /^-v+$/.test(a));
  const verboseHeader = verbose
    ? `debug1: Connecting to ${host} [${found.ip}] port ${port}.\n` +
      `debug1: Server host key: ssh-ed25519 SHA256:abc123\n` +
      `debug1: Authentication succeeded (${auth.method}).\n`
    : '';

  // If the user provided a remote command, execute it on the remote
  // through the user's login shell and return its output / exit code.
  // This is OpenSSH's "exec mode" — no banner, no Last login. A bare
  // `exit` / `logout` is treated as if no command was given (the user
  // wants a banner-only interactive session that closes immediately).
  let remoteCmd = joinRemoteCommand(positional.slice(1));
  if (/^(exit|logout)\s*$/i.test(remoteCmd)) remoteCmd = '';
  if (remoteCmd) {
    const remoteUidBeforeAfter = swapRemoteUser(machine, remoteUser);
    // `-A` agent forwarding: expose the local agent's identities to the
    // remote command, restoring the remote agent afterwards.
    const restoreAgent = flags.includes('-A')
      ? forwardSshAgent(opts, machine)
      : null;
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
        ? computeForwardedEnv(opts, flags, remoteExec)
        : {};
      // exec-mode without -t carries no PTY; mark it so the remote
      // `tty` builtin reports "not a tty" and SIGINT-relay logic can
      // decide whether to wire a controlling terminal.
      const hasTty = flags.includes('-t') || flags.includes('-tt');
      if (!hasTty) forwarded['SSH_NO_TTY'] = '1';
      // -t / -tt: propagate the client TTY's geometry (COLUMNS / LINES)
      // and TERM to the remote shell — matches SIGWINCH + ENV-passing
      // for an OpenSSH session with a PTY.
      if (hasTty) {
        forwarded['COLUMNS'] = opts.callerEnv?.['COLUMNS'] ?? '80';
        forwarded['LINES']   = opts.callerEnv?.['LINES']   ?? '24';
        if (opts.callerEnv?.['TERM']) forwarded['TERM'] = opts.callerEnv['TERM'];
      }
      // -A: expose the local agent through SSH_AUTH_SOCK on the remote
      // shell so any `ssh` invocation inside the remote command finds
      // the forwarded identities — matches OpenSSH agent forwarding.
      if (flags.includes('-A')) {
        forwarded['SSH_AUTH_SOCK'] = `/tmp/ssh-${remoteUser}/agent.${SSH_CLIENT_FORWARD_PID}`;
      }
      // PermitUserEnvironment yes — overlay ~/.ssh/environment lines
      // (KEY=VAL) into the exec-mode env, matching OpenSSH behaviour.
      if (remoteExec && readRemoteSshdDirective(remoteExec, 'PermitUserEnvironment') === 'yes') {
        const entry = remoteExec.userMgr.getUser(remoteUser);
        const home = entry?.home ?? `/home/${remoteUser}`;
        const envFile = remoteExec.vfs.readFile(`${home}/.ssh/environment`) ?? '';
        for (const rawLine of envFile.split('\n')) {
          const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(rawLine);
          if (m) forwarded[m[1]] = m[2];
        }
      }
      // SSH exec mode runs in a one-shot sub-shell whose env never leaks
      // back to the long-lived shell — snapshot/restore around the call.
      const envSnapshot = (machine as unknown as { executor: { env?: Map<string, string> } }).executor?.env;
      const savedEntries = envSnapshot ? Array.from(envSnapshot.entries()) : null;
      // With -t (PTY), bash sources ~/.bashrc before running the
      // command — that's where aliases and shell functions live.
      // Prepend the rc body and `shopt -s expand_aliases` so alias
      // expansion stays on for non-interactive expansion too.
      let effectiveCmd = remoteCmd;
      if (hasTty) {
        const entry = remoteExec?.userMgr.getUser(remoteUser);
        const home = entry?.home ?? `/home/${remoteUser}`;
        const rc = remoteExec?.vfs.readFile(`${home}/.bashrc`) ?? '';
        if (rc.trim()) effectiveCmd = `${rc}\n${remoteCmd}`;
      }
      try {
        execOut =
          Object.keys(forwarded).length > 0 && execMod?.executeWithEnv
            ? execMod.executeWithEnv(effectiveCmd, forwarded)
            : execMod?.execute?.(effectiveCmd) ?? '';
      } finally {
        if (envSnapshot && savedEntries) {
          envSnapshot.clear();
          for (const [k, v] of savedEntries) envSnapshot.set(k, v);
        }
      }
      execRc = execMod?.lastExitCode ?? 0;
    } finally {
      restoreAgent?.();
      remoteUidBeforeAfter?.();
    }
    // Terminate the remote command's output with a newline (as a real TTY
    // does) so a following local command starts on its own line.
    const normalised = execOut && !execOut.endsWith('\n') ? `${execOut}\n` : execOut;
    return { output: verboseHeader + forwardingError + normalised, exitCode: execRc, connection };
  }

  // Interactive form (no command): the simulator returns the typical
  // login banner composition so downstream scripts see a coherent
  // transcript.
  const remoteVfs = (machine as LinuxMachine & { executor: { vfs: { readFile: (p: string) => string | null } } }).executor.vfs;
  const issueNet = remoteVfs.readFile('/etc/issue.net') ?? '';
  const motd     = remoteVfs.readFile('/etc/motd')      ?? '';

  // -q / -Q (quiet) suppresses banner output (still connects). Match
  // OpenSSH: stay silent on success.
  const quiet = flags.some(a => a === '-q' || a === '-Q');
  if (quiet) {
    return { output: verboseHeader + forwardingError, exitCode: 0, connection };
  }

  const lines: string[] = [];
  if (issueNet.trim()) lines.push(issueNet.replace(/\n*$/, ''));
  lines.push(`Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)`);
  lines.push(`Last login: ${new Date().toUTCString().replace(/^... /, '')} from ${opts.sourceIp}`);
  if (motd.trim()) lines.push(motd.replace(/\n*$/, ''));
  lines.push(`Connection to ${host} closed.`);
  return { output: verboseHeader + forwardingError + lines.join('\n'), exitCode: 0, connection };
}

/**
 * Reconstruct the remote command from the positional argv that followed
 * the host. A single token is the whole command verbatim
 * (`ssh host "uname -a"`); multiple tokens are individual argv words, so
 * any containing whitespace are re-quoted to survive the remote shell's
 * re-parse intact (`ssh host bash -lc 'echo $0'`).
 */
function joinRemoteCommand(tokens: string[]): string {
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0].trim();
  return tokens
    .map((t) => (/\s/.test(t) ? `'${t.replace(/'/g, "'\\''")}'` : t))
    .join(' ')
    .trim();
}

/**
 * `-A` agent forwarding: overlay the local ssh-agent's identities onto
 * the remote machine's agent for the duration of the remote command.
 * Returns a restorer that puts the remote agent back, or null when there
 * is nothing to forward.
 */
function forwardSshAgent(opts: SshClientOpts, machine: LinuxMachine): (() => void) | null {
  const remoteAgent = (machine as unknown as {
    executor?: { sshAgent?: SshAgent };
  }).executor?.sshAgent;
  if (!opts.localAgent || !remoteAgent) return null;
  const saved = remoteAgent.list();
  remoteAgent.adopt(opts.localAgent.list());
  return () => remoteAgent.adopt(saved);
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
  const file = SshKnownHostsFile.parse(existing);

  if (file.hostKeyChanged(ip, keyType, publicKey)) return true;
  if (!file.find(ip, keyType)) {
    const updated = file.add({ hostnames: [ip], keyType, publicKey });
    const sshDir = knownHostsPath.replace(/\/[^/]+$/, '');
    if (opts.localVfs.mkdirp && opts.localVfs.resolveInode && !opts.localVfs.resolveInode(sshDir)) {
      opts.localVfs.mkdirp(sshDir, 0o700, 0, 0);
    }
    opts.localVfs.writeFile(knownHostsPath, updated.serialize(), 0, 0, 0o022);
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

/**
 * Cross-platform SSH exec dispatch for non-Linux targets (Windows,
 * Cisco IOS, Huawei VRP). The target's polymorphic `SshExecTarget`
 * surface handles auth, audit and the synchronous command whitelist.
 *
 * The dispatch returns the same `SshClientResult` shape as the Linux
 * path so callers (LinuxCommandExecutor) don't need to know which
 * platform answered.
 */
function runCrossPlatformExec(
  target: SshExecTarget,
  remoteUser: string,
  positional: string[],
  port: number,
  host: string,
  opts: SshClientOpts,
): SshClientResult {
  const router = target as unknown as {
    getLoginBlocker?: () => { isBlocked: (ip: string) => boolean } | null;
    getSshHost?: () => CrossVendorSshHost;
    getSshSessionRegistry?: () => {
      list: () => ReadonlyArray<{ id: string; user: string; fromIp: string }>;
      close: (id: string, reason?: string) => void;
    };
  };
  const sshHost = router.getSshHost?.();
  const blocker = router.getLoginBlocker?.();
  if (blocker && blocker.isBlocked(opts.sourceIp)) {
    return {
      output: `ssh: connect to host ${host} port ${port}: Connection refused (Quiet-Mode)\n`,
      exitCode: 255,
    };
  }

  const remoteCmd = joinRemoteCommand(positional.slice(1));

  if (sshHost) {
    // VTY ACL gate (Cisco access-class / Huawei acl inbound): consult the
    // router's VtyLineConfigStore for the SSH range, evaluate the named
    // ACL against the synthetic IP packet, refuse before evaluate() if
    // the result is deny. Real IOS / VRP behaviour for transport SSH.
    const vtyStore = (router as unknown as { _getVtyLineConfig?: () => {
      all: () => readonly { transportInput: string | null; accessClassIn: string | null; aclInbound: string | null }[];
    } })._getVtyLineConfig?.();
    const aclResolver = (router as unknown as {
      evaluateACLByName?: (name: string, pkt: unknown) => string;
    }).evaluateACLByName;
    if (vtyStore && aclResolver) {
      try {
        const dstIp = (() => { try { return new IPAddress(host); } catch { return new IPAddress('0.0.0.0'); } })();
        const synthPkt = {
          sourceIP: new IPAddress(opts.sourceIp),
          destinationIP: dstIp,
          protocol: 6, ttl: 64, totalLength: 40, identification: 0,
          flags: 0, fragmentOffset: 0, headerChecksum: 0,
          payload: new Uint8Array(),
        };
        for (const block of vtyStore.all()) {
          const aclName = block.accessClassIn ?? block.aclInbound;
          if (!aclName) continue;
          const verdict = aclResolver.call(router, String(aclName), synthPkt);
          if (verdict === 'deny') {
            return { output: `ssh: connect to host ${host} port ${port}: Connection refused\n`, exitCode: 255 };
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log('[vty-acl]', e);
      }
    }
    const request = SshConnectionRequest.create({
      requestedUser: remoteUser,
      requestedHost: host,
      requestedPort: port,
      sourceIp: opts.sourceIp,
      sourceHostname: opts.sourceHostname,
      command: remoteCmd || null,
      offeredAuthMethods: ['publickey', 'password'],
    });
    const decision = sshHost.evaluate(request);
    if (decision.outcome === 'dropped') {
      target.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, false);
      return { output: `ssh: connect to host ${host} port ${port}: Connection refused\n`, exitCode: 255 };
    }
    if (decision.outcome === 'rejected') {
      target.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, false);
      return { output: `${remoteUser}@${host}: Permission denied (publickey,password).\n`, exitCode: 255 };
    }
    target.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, true, decision.method ?? 'password');
  } else {
    if (!target.isSshActive()) {
      target.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, false);
      return { output: `ssh: connect to host ${host} port ${port}: Connection refused\n`, exitCode: 255 };
    }
    const policy = target.getSshPolicy();
    if (!policy.ports.includes(port)) {
      target.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, false);
      return { output: `ssh: connect to host ${host} port ${port}: Connection refused\n`, exitCode: 255 };
    }
    const login = target.sshdAcceptsLogin(remoteUser);
    if (!login.ok) {
      target.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, false);
      return { output: `${remoteUser}@${host}: Permission denied (publickey,password).\n`, exitCode: 255 };
    }
    target.recordSshLogin(remoteUser, opts.sourceIp, opts.sourceHostname, true, 'password');
  }

  const sessionRegistry = router.getSshSessionRegistry?.();
  const closeSession = () => {
    if (!sessionRegistry) return;
    const open = sessionRegistry.list().find(s => s.user === remoteUser && s.fromIp === opts.sourceIp);
    if (open) sessionRegistry.close(open.id, 'logout');
  };

  if (remoteCmd) {
    const result = target.runSshCommandSync(remoteUser, remoteCmd);
    closeSession();
    if (result) return { output: result.output, exitCode: result.exitCode };
    return {
      output: `ssh: remote shell rejected '${remoteCmd}' (command not yet supported over the sync bridge)\n`,
      exitCode: 1,
    };
  }

  const lines: string[] = [];
  const banner = target.getSshBanner();
  const motd = target.getSshMotd();
  if (banner.trim()) lines.push(banner.replace(/\n*$/, ''));
  if (motd.trim()) lines.push(motd.replace(/\n*$/, ''));
  lines.push(`Connection to ${host} closed.`);
  closeSession();
  return { output: lines.join('\n'), exitCode: 0 };
}
