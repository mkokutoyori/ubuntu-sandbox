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

import { compareAndRecordHostKey, type KnownHostsVfs } from '../../../protocols/ssh/hostkey/HostKeyChangedWarning';
import { simulationDate, simulationNowMs } from '@/network/core/SystemClock';

import { parseStrictHostKeyChecking, type StrictHostKeyChecking } from '../../../protocols/ssh/SshConnectOptions';
import { findHostByAddress, isPathReachable } from './HostLookup';
import type { ExecChannelOptions } from '../../../protocols/ssh/channels/ISshChannel';
import { sshUnreachableReason, wireReachOutcome } from '@/terminal/ssh/wireSshLogin';
import { OPENSSH_SSH, sshWireFailureLine } from '@/terminal/ssh/sshDialect';
import { sshReplyWithoutSession } from '@/network/protocols/ssh/SshClientCommandLine';
import { unprotectedPrivateKeyWarning } from '@/network/protocols/ssh/PrivateKeyPermissions';
import { OPENSSH_UBUNTU_22_04 } from '@/network/protocols/ssh/OpenSshRelease';
import { IPAddress } from '../../../core/types';
import { parseDialAddress } from '../../../tcp/dial';
import type { TcpWireOutcome } from '../../../tcp/types';
import { type SshHostKeyType } from './SshKnownHostEntry';
import { SshPortForward } from './SshPortForward';
import type { AccountLifecycleVerdict, AuthMethodType } from '@/network/protocols/ssh/auth/ISshAuthMethod';
import {
  OPENSSH_DEFAULT_IDENTITY_FILES,
  OPENSSH_USERAUTH_METHODS,
  sshClientAlgorithms,
  sshClientAuthentication,
  type SshClientAuthentication,
} from '@/network/protocols/ssh/SshConnectOptions';
import { sshOptionValues } from '@/network/protocols/ssh/SshClientCommandLine';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { everySshOption, firstSshOption, sshFlag, sshOptionAssignment } from '@/network/protocols/ssh/SshClientOptions';
import type { SshForwardingTable } from './SshForwardingTable';
import type { TcpStack } from '../../../tcp/TcpStack';
import type { SshSession } from '../../../protocols/ssh/session/SshSession';
import type { SshAgent } from '../../../protocols/ssh/SshAgent';
import { fmtHumanDate } from '../LinuxLogManager';
import type { LinuxMachine } from '../../LinuxMachine';
import { isSshExecTarget, type SshExecTarget } from '../../../protocols/ssh/server/SshExecTarget';
import { SshConfig } from '../../../protocols/ssh/SshConfig';
import type { SshAlgorithmPreferences } from '../../../protocols/ssh/transport/SshTransport';
import { SshKnownHostsFile } from '../../../protocols/ssh/SshKnownHostsFile';
import type { CrossVendorSshHost } from '../../../protocols/ssh/server/CrossVendorSshHost';
import { SshConnectionRequest } from '../../../protocols/ssh/server/SshConnectionRequest';
import { authorizedKeyAdmits, parseAuthorizedKeysLine, sshWildcardMatches, type AuthorizedKey } from '../../../protocols/ssh/SshPureUtils';
import { parseProxyJumpSpec, type ProxyHop } from '@/terminal/sessions/sshArgs';
import { localListenerFailure, NO_LOCAL_FORWARDING, remoteForwardFailure } from '../../../protocols/ssh/ForwardOpening';

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
  /**
   * Set when an outbound SYN was sent toward `peerIp:peerPort` but the
   * handshake never completed because a transit ACL dropped it. Lets the
   * caller log the lone SYN so `tcpdump` shows the same trace a real
   * client gets when a Cisco extended ACL eats the packet.
   */
  droppedSyn?: SshConnectionTuple;
}

export interface SshClientOpts {
  /** argv passed to `ssh` (excluding the verb itself). */
  args: string[];
  /**
   * The machine running `ssh`. The target is resolved by walking the
   * cable plant from here (docs/PRD-Frame-Only-Refactor.md P6).
   */
  sourceDevice?: object | null;
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
  sourceUid?: number;
  sourceGid?: number;
  resolveName?: (name: string) => string | null;
  /**
   * Shell environment of the `ssh` invocation (exported variables plus
   * `VAR=val` prefix assignments). Drives SendEnv/AcceptEnv forwarding.
   */
  callerEnv?: Record<string, string>;
  execRelay?: (
    command: string, env: Record<string, string>,
  ) => { output: string; exitCode: number } | null;
  wireAuthenticated?: boolean;
  wireMethod?: string;
  wireAuthRefused?: boolean;
  wireDenial?: string;
  wireOutcome?: TcpWireOutcome;
  shellRelay?: () => { output: string; exitCode: number } | null;
  /**
   * Client-side messages produced BEFORE authentication — the
   * known-hosts notice above all. OpenSSH writes them first, ahead of
   * the server's login banner, so they cannot travel inside the relayed
   * session's output.
   */
  wireNotices?: readonly string[];
  /**
   * The local machine's port-forwarding table — `-L` / `-D` listeners are
   * bound here so the tunnel surfaces through `ss` / `netstat`.
   */
  localForwarding?: SshForwardingTable;
  forwardingSession?: ForwardingSession;
  clientProcess?: () => number;
  wirePeerIp?: string;
  /**
   * The local machine's ssh-agent — when `-A` (agent forwarding) is used,
   * its identities are exposed to the remote command for its duration.
   */
  localAgent?: SshAgent;
  /**
   * Password offered to the remote (heredoc / piped stdin or `sshpass -p`).
   * When set, the simulator's password-auth path validates it against the
   * remote userMgr's checkPassword and emits an `auth_failure` event on
   * mismatch — that's what wires the brute-force detection chain
   * end-to-end.
   */
  offeredPassword?: string;
}

const RE_USERHOST = /^(?:([\w.-]+)@)?([\w.:-]+)$/;

/**
 * Short `ssh` options that consume a value — the character right after
 * the dash (`-p 22`, `-L spec`, `-o Name=val`, …). `-q` / `-Q` are
 * deliberately excluded: the simulator treats them as the quiet switch.
 */
const SSH_VALUE_FLAGS = new Set(
  ['b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'p', 'R', 's', 'S', 'W', 'w'],
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

function deniedLine(user: string, host: string, methods: readonly string[] | string | null): string {
  const list = methods === null ? 'publickey,password' : typeof methods === 'string' ? methods : methods.join(',');
  return `${user}@${host}: Permission denied (${list}).`;
}



function clientOption(args: string[], name: string): string | null {
  const value = firstSshOption(sshOptionValues(args), name.toLowerCase());
  return value === undefined ? null : (value.split(/\s+/)[0] ?? '').toLowerCase();
}










// ─── SendEnv / AcceptEnv environment forwarding ─────────────────────

/** OpenSSH ships these in the stock ssh_config / sshd_config. */
const DEFAULT_ENV_PATTERNS: readonly string[] = ['LANG', 'LC_*'];

/** Match an environment variable name against a glob pattern set. */
function envNameMatches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => sshWildcardMatches(p, name));
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

function clientSendEnvPatterns(opts: SshClientOpts, flags: string[]): string[] {
  const requested = everySshOption(sshOptionValues(flags), 'sendenv')
    .flatMap((value) => value.split(/\s+/).filter(Boolean));
  const configured = opts.localVfs
    ? collectDirective(opts.localVfs.readFile(`${opts.sourceHome ?? '/root'}/.ssh/config`) ?? '', 'SendEnv')
    : [];
  const patterns: string[] = [];
  for (const entry of [...requested, ...configured, ...DEFAULT_ENV_PATTERNS]) {
    if (!entry.startsWith('-')) {
      patterns.push(entry);
      continue;
    }
    for (let i = patterns.length - 1; i >= 0; i--) {
      if (envNameMatches(patterns[i], [entry.slice(1)])) patterns.splice(i, 1);
    }
  }
  return patterns;
}



export function execChannelOptionsFor(opts: SshClientOpts, args: string[]): ExecChannelOptions {
  const { flags } = splitSshArgs(args);
  const callerEnv = opts.callerEnv ?? {};
  const send = clientSendEnvPatterns(opts, flags);
  const environment = new Map<string, string>();
  for (const [name, value] of Object.entries(callerEnv)) {
    if (envNameMatches(name, send)) environment.set(name, value);
  }
  const wantsTty = (flags.includes('-t') || flags.includes('-tt')) && !flags.includes('-T');
  return {
    environment,
    ...(wantsAgentForwarding(flags) ? { forwardAgent: true } : {}),
    ...(wantsTty
      ? {
        pty: {
          term: callerEnv['TERM'] ?? 'xterm',
          columns: Number(callerEnv['COLUMNS'] ?? 80) || 80,
          rows: Number(callerEnv['LINES'] ?? 24) || 24,
        },
      }
      : {}),
  };
}

/** Extract -p <port> from argv (default 22). */
export interface WireExecTarget {
  host: string;
  user: string;
  port: number;
  identities: string[];
  command: string;
  commandWords: string[];
  holdOnly: boolean;
  forksToBackground: boolean;
  forwardAgent: boolean;
  stdioForward: StdioForwardSpec | null;
  proxyCommand: string | null;
  strict: StrictHostKeyChecking;
  authentication: SshClientAuthentication;
  algorithms: SshAlgorithmPreferences;
}

export type StdioForwardSpec =
  | { readonly kind: 'target'; readonly host: string; readonly port: number }
  | { readonly kind: 'invalid'; readonly spec: string };

function stdioForwardOf(flags: string[]): StdioForwardSpec | null {
  const at = flags.indexOf('-W');
  if (at < 0) return null;
  const spec = flags[at + 1] ?? '';
  const match = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d+)$/.exec(spec);
  const port = match === null ? NaN : Number(match[3]);
  if (match === null || !PortNumber.isValid(port)) return { kind: 'invalid', spec };
  return { kind: 'target', host: match[1] ?? match[2], port };
}

function proxyCommandOf(flags: string[]): string | null {
  const value = firstSshOption(sshOptionValues(flags), 'proxycommand');
  return value === undefined || value.toLowerCase() === 'none' ? null : value;
}

export function wantsAgentForwarding(flags: string[]): boolean {
  if (flags.includes('-a')) return false;
  return flags.includes('-A') || sshFlag(clientOption(flags, 'ForwardAgent') ?? '') === true;
}

export function wireExecTarget(
  args: string[],
  vfs: { normalizePath(path: string, cwd: string): string; readFile(path: string): string | null },
  cwd: string,
  defaultUser: string,
  home = '/root',
): WireExecTarget | null {
  const { positional, flags } = splitSshArgs(args);
  const target = positional[0];
  if (target === undefined) return null;
  for (const blocking of ['-J']) {
    if (flags.includes(blocking)) return null;
  }
  const at = target.indexOf('@');
  const typedHost = at >= 0 ? target.slice(at + 1) : target;
  if (typedHost === '') return null;
  const configText = vfs.readFile(`${home}/.ssh/config`);
  const entry = configText ? SshConfig.parse(configText).resolve(typedHost) : null;
  const host = entry?.hostName ?? typedHost;
  const user = at >= 0 ? target.slice(0, at) : entry?.user ?? defaultUser;
  const identities: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '-i' && flags[i + 1]) identities.push(vfs.normalizePath(flags[i + 1], cwd));
  }
  if (identities.length === 0 && entry?.identityFile) {
    identities.push(vfs.normalizePath(
      entry.identityFile.startsWith('~/') ? `${home}/${entry.identityFile.slice(2)}` : entry.identityFile, cwd));
  }
  const asked = clientOption(flags, 'StrictHostKeyChecking');
  return {
    host, user,
    port: flags.includes('-p') ? clientPort(flags) : entry?.port ?? 22,
    identities,
    command: joinRemoteCommand(positional.slice(1)),
    commandWords: positional.slice(1),
    holdOnly: flags.includes('-N'),
    forksToBackground: flags.includes('-f'),
    forwardAgent: wantsAgentForwarding(flags),
    stdioForward: stdioForwardOf(flags),
    proxyCommand: proxyCommandOf(flags),
    strict: parseStrictHostKeyChecking(asked) ?? entry?.strictHostKeyChecking ?? 'accept-new',
    authentication: sshClientAuthentication(sshOptionValues(flags)),
    algorithms: sshClientAlgorithms(sshOptionValues(flags)),
  };
}

export interface ProxyJumpRequest {
  readonly hops: readonly ProxyHop[];
  readonly remaining: string[];
}

export function proxyJumpRequest(args: readonly string[]): ProxyJumpRequest | null {
  const remaining: string[] = [];
  let spec: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') {
      remaining.push(...args.slice(i));
      break;
    }
    if (arg === '-J' && i + 1 < args.length) {
      const jump = args[++i];
      spec ??= jump;
      continue;
    }
    if (arg.startsWith('-J') && arg.length > 2) {
      spec ??= arg.slice(2);
      continue;
    }
    const option = arg === '-o' ? args[i + 1] : arg.startsWith('-o') ? arg.slice(2) : null;
    const proxyJump = option === null || option === undefined ? null : sshOptionAssignment(option);
    if (proxyJump?.name === 'proxyjump') {
      spec ??= proxyJump.value;
      if (arg === '-o') i++;
      continue;
    }
    remaining.push(arg);
    if (SSH_VALUE_FLAGS.has(arg.slice(1)) && arg.length === 2 && i + 1 < args.length) remaining.push(args[++i]);
  }
  if (spec === null || spec.toLowerCase() === 'none') return null;
  const hops = parseProxyJumpSpec(spec);
  return hops.length > 0 ? { hops, remaining } : null;
}

function clientPort(args: string[]): number {
  const i = args.indexOf('-p');
  if (i >= 0 && args[i + 1]) {
    const n = Number.parseInt(args[i + 1], 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return 22;
}


export interface ForwardingSession {
  readonly session: SshSession;
  readonly clientHost: { getTcpStack(): TcpStack };
  readonly resolveHost: (name: string) => string | null;
}

function setupPortForwards(opts: SshClientOpts, flags: string[]): string {
  const forwards = SshPortForward.collect(flags);
  if (forwards.length === 0) return '';
  const table = opts.localForwarding;
  const carrier = opts.forwardingSession;
  const clientProcess = opts.clientProcess;
  let diagnostics = '';
  let localRequested = 0;
  let localOpened = 0;
  for (const fwd of forwards) {
    if (fwd.listensOnServer) {
      const accepted = table !== undefined && carrier !== undefined
        && table.openRemote(fwd, carrier.session, carrier.clientHost, carrier.resolveHost);
      if (!accepted) diagnostics += `${remoteForwardFailure(fwd.listenPort)}\n`;
      continue;
    }
    localRequested++;
    if (table === undefined || carrier === undefined || clientProcess === undefined) continue;
    const opening = table.openLocal(fwd, carrier.session, clientProcess(), opts.sourceUid);
    if (opening !== 'opened') {
      diagnostics += localListenerFailure(fwd.bindAddress, fwd.listenPort, opening).map((l) => `${l}\n`).join('');
      continue;
    }
    localOpened++;
  }
  if (localRequested > 0 && localOpened === 0) diagnostics += `${NO_LOCAL_FORWARDING}\n`;
  return diagnostics;
}

function wireFailure(
  opts: SshClientOpts, host: string, destIp: string, port: number,
  outcome: Exclude<TcpWireOutcome, 'open'>,
): SshClientResult {
  return {
    output: `${sshWireFailureLine(OPENSSH_SSH, outcome, host, port)}\n`,
    exitCode: 255,
    droppedSyn: { localIp: opts.sourceIp, peerIp: destIp, peerPort: port },
  };
}


export function splitSshFlags(args: string[]): string[] {
  return splitSshArgs(args).flags;
}

export function sshClientRefusal(opts: SshClientOpts): SshClientResult | null {
  const withoutSession = sshReplyWithoutSession(opts.args, OPENSSH_UBUNTU_22_04);
  if (withoutSession) return withoutSession;
  const { positional, flags } = splitSshArgs(opts.args);
  const target = positional[0];
  const port = clientPort(flags);
  const iIdx = flags.indexOf('-i');
  const iVal = iIdx >= 0 ? flags[iIdx + 1] : undefined;
  if (iVal && opts.localVfs?.resolveInode) {
    const inode = opts.localVfs.resolveInode(iVal, true);
    const warning = inode ? unprotectedPrivateKeyWarning(iVal, inode.permissions) : null;
    if (warning) {
      return {
        output: [
          ...warning,
          `Load key "${iVal}": bad permissions`,
          `${opts.sourceUser}@${target ?? ''}: Permission denied (publickey,password).`,
        ].join('\n'),
        exitCode: 255,
      };
    }
  }
  if (opts.sourceIp === '127.0.0.1' || !opts.sourceIp) {
    return {
      output: `ssh: connect to host ${target ?? ''} port ${port}: Network is unreachable\n`,
      exitCode: 255,
    };
  }
  if (!target) return { output: OPENSSH_UBUNTU_22_04.sshUsage, exitCode: 255 };
  if (!RE_USERHOST.test(target)) {
    return {
      output: `ssh: Could not resolve hostname ${target}: Name or service not known\n`,
      exitCode: 255,
    };
  }
  return null;
}

export interface WireSshFailure {
  readonly host: string;
  readonly user: string;
  readonly address: string | null;
  readonly port: number;
  readonly unreachableLine?: string;
  readonly reach?: Exclude<TcpWireOutcome, 'open'>;
  readonly keyExchange?: string;
  readonly hostKey?: string;
  readonly denial?: string;
  readonly authRefused?: boolean;
  readonly connectionLine?: string;
}

export function sshWireFailureResult(opts: SshClientOpts, failure: WireSshFailure): SshClientResult {
  if (failure.unreachableLine !== undefined) return { output: `${failure.unreachableLine}\n`, exitCode: 255 };
  if (failure.reach !== undefined && failure.address !== null) {
    return wireFailure(opts, failure.host, failure.address, failure.port, failure.reach);
  }
  if (failure.keyExchange !== undefined) return { output: failure.keyExchange, exitCode: 255 };
  if (failure.hostKey !== undefined) return { output: failure.hostKey, exitCode: 255 };
  if (failure.authRefused === true) {
    return { output: `${failure.denial ?? deniedLine(failure.user, failure.host, null)}\n`, exitCode: 255 };
  }
  return {
    output: `${failure.connectionLine ?? `ssh: connect to host ${failure.host} port ${failure.port}: Network is unreachable`}\n`,
    exitCode: 255,
  };
}

export interface WireSshSuccess {
  readonly host: string;
  readonly address: string;
  readonly port: number;
  readonly method: string | undefined;
  readonly serverHostKey: { readonly algorithm: string; readonly fingerprint: string } | null;
  readonly command: string;
  readonly settled: { readonly output: string; readonly exitCode: number } | null;
  readonly shell: { readonly output: string; readonly exitCode: number } | null;
  readonly notices: readonly string[];
}

export function sshWireSuccessResult(opts: SshClientOpts, flags: string[], success: WireSshSuccess): SshClientResult {
  const notices = success.notices.map((n) => (n.endsWith('\n') ? n : `${n}\n`)).join('');
  const forwardingError = setupPortForwards(opts, flags);
  if (flags.includes('-N')) return { output: forwardingError, exitCode: 0 };
  const verbose = flags.some((a) => /^-v+$/.test(a));
  const verboseHeader = verbose
    ? `debug1: Connecting to ${success.host} [${success.address}] port ${success.port}.\n`
      + (success.serverHostKey === null
        ? ''
        : `debug1: Server host key: ${success.serverHostKey.algorithm} ${success.serverHostKey.fingerprint}\n`)
      + `debug1: Authentication succeeded (${success.method ?? 'password'}).\n`
    : '';
  const header = notices + verboseHeader + forwardingError;
  if (success.settled !== null) {
    const output = success.settled.output;
    return {
      output: header + (output && !output.endsWith('\n') ? `${output}\n` : output),
      exitCode: success.settled.exitCode,
    };
  }
  if (flags.some((a) => a === '-q' || a === '-Q')) return { output: header, exitCode: 0 };
  const lines: string[] = [];
  if (success.shell !== null && success.shell.output.length > 0) lines.push(success.shell.output);
  lines.push(connectionClosed(success.host));
  return { output: header + lines.join('\n'), exitCode: 0 };
}

function connectionClosed(host: string): string {
  return `Connection to ${host} closed.`;
}


export type RemoteQuoting = 'posix' | 'cmd';


/**
 * Reconstruct the remote command from the positional argv that followed
 * the host. A single token is the whole command verbatim
 * (`ssh host "uname -a"`); multiple tokens are individual argv words, so
 * any containing whitespace are re-quoted to survive the remote shell's
 * re-parse intact (`ssh host bash -lc 'echo $0'`).
 */
export function joinRemoteCommand(tokens: string[], quoting: RemoteQuoting = 'posix'): string {
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0].trim();
  const quote = quoting === 'cmd'
    ? (t: string) => `"${t.replace(/"/g, '\\"')}"`
    : (t: string) => `'${t.replace(/'/g, "'\\''")}'`;
  return tokens
    .map((t) => (/\s/.test(t) ? quote(t) : t))
    .join(' ')
    .trim();
}





export function remoteQuotingOf(serverIdentification: string | null): RemoteQuoting {
  return serverIdentification !== null && /windows/i.test(serverIdentification) ? 'cmd' : 'posix';
}
