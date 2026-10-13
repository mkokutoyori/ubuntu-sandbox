/**
 * Pure parsing helpers for the in-terminal `ssh` command.
 *
 * Extracted from `LinuxTerminalSession` so the same logic can be
 * exercised in unit tests without spinning up a full session.
 *
 * Supported flags (OpenSSH subset):
 *   -p <port>                  Remote port.
 *   -i <identity_file>         Identity (private key) path. Repeatable.
 *   -o StrictHostKeyChecking=  yes | no | accept-new.
 *   -o HashKnownHosts=         yes | no.
 *   -o ProxyJump=<spec>        Same as `-J <spec>`.
 *   -J <spec>                  Comma-separated jump-host chain.
 *   -L <localPort:host:port>   Local port forwarding (repeatable).
 */

import {
  sshClientAlgorithms,
  parseStrictHostKeyChecking,
  sshClientAuthentication,
  type SshClientAuthentication,
  type StrictHostKeyChecking,
} from '@/network/protocols/ssh/SshConnectOptions';
import { everySshOption, firstSshOption, sshFlag } from '@/network/protocols/ssh/SshClientOptions';
import type { SshAlgorithmPreferences } from '@/network/protocols/ssh/transport/SshTransport';
import { SshPortForward } from '@/network/devices/linux/network/SshPortForward';


export type { StrictHostKeyChecking };

export interface ParsedSshArgs {
  /** `user@host` or just `host`. */
  readonly userAtHost: string;
  readonly port: number;
  readonly identityFiles: readonly string[];
  readonly strict: StrictHostKeyChecking | undefined;
  /** Inline command (`ssh user@host whoami`). `null` for interactive. */
  readonly command: string | null;
  /** When true, persist new entries to known_hosts hashed. */
  readonly hashKnownHosts?: boolean;
  /**
   * ProxyJump chain (`-J h1[,h2,...]` or `-o ProxyJump=`). Each entry
   * keeps the `[user@]host` form for downstream rendering.
   */
  readonly jumpHosts: readonly string[];
  /** Local port forwards from `-L`. */
  readonly localForwards: readonly SshPortForward[];
  /** Remote port forwards from `-R`. */
  readonly remoteForwards: readonly SshPortForward[];
  /** Dynamic (SOCKS) forwards from `-D`. */
  readonly dynamicForwards: readonly SshPortForward[];
  /**
   * OpenSSH `-A` — forward the local ssh-agent connection so commands
   * on the remote machine can authenticate further hops with the
   * client's keys.
   */
  readonly forwardAgent: boolean;
  /**
   * OpenSSH `-t` / `-T` / `-tt`. `'yes'` requests a PTY; `'force'`
   * insists even when stdin is not a TTY (`-tt`); `'no'` disables PTY
   * allocation (`-T`). `undefined` leaves the server's default in
   * effect — request a PTY only for interactive sessions.
   */
  readonly requestTty?: 'yes' | 'no' | 'force';
  readonly authentication: SshClientAuthentication;
  readonly algorithms: SshAlgorithmPreferences;
}

export interface ProxyHop {
  readonly user: string | null;
  readonly host: string;
  readonly port?: number;
}

/**
 * Split a `-J` value into structured hops. Empty input → empty list.
 * Order is preserved (first hop is the first SSH connection opened).
 */
export function parseProxyJumpSpec(spec: string): readonly ProxyHop[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const at = entry.indexOf('@');
      const user = at >= 0 ? entry.slice(0, at) : null;
      const endpoint = at >= 0 ? entry.slice(at + 1) : entry;
      const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(endpoint);
      const hostPort = bracketed ? null : /^([^:]+):(\d+)$/.exec(endpoint);
      const host = bracketed?.[1] ?? hostPort?.[1] ?? endpoint;
      const port = bracketed?.[2] ?? hostPort?.[2];
      return port === undefined ? { user, host } : { user, host, port: Number(port) };
    });
}

/**
 * Parse `ssh [options] [user@]host [command...]`. Returns `null` only
 * when no host argument is present (matches OpenSSH usage-error path).
 */
export function parseSshArgs(args: readonly string[]): ParsedSshArgs | null {
  let port = 22;
  const identityFiles: string[] = [];
  const jumpHostsRaw: string[] = [];
  const localForwards: SshPortForward[] = [];
  const remoteForwards: SshPortForward[] = [];
  const dynamicForwards: SshPortForward[] = [];
  let forwardAgent = false;
  let requestTty: 'yes' | 'no' | 'force' | undefined;
  let host: string | null = null;
  const commandTokens: string[] = [];
  const optionValues: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (host) {
      commandTokens.push(arg);
      continue;
    }
    if (arg === '-p' && i + 1 < args.length) {
      port = Number.parseInt(args[++i], 10) || 22;
    } else if (arg === '-i' && i + 1 < args.length) {
      identityFiles.push(args[++i]);
    } else if (arg === '-J' && i + 1 < args.length) {
      const spec = args[++i];
      for (const hop of parseProxyJumpSpec(spec)) {
        jumpHostsRaw.push(hop.user ? `${hop.user}@${hop.host}` : hop.host);
      }
    } else if (arg === '-L' && i + 1 < args.length) {
      const fwd = SshPortForward.parse('local', args[++i].trim());
      if (fwd) localForwards.push(fwd);
    } else if (arg === '-R' && i + 1 < args.length) {
      const fwd = SshPortForward.parse('remote', args[++i].trim());
      if (fwd) remoteForwards.push(fwd);
    } else if (arg === '-D' && i + 1 < args.length) {
      const fwd = SshPortForward.parse('dynamic', args[++i].trim());
      if (fwd) dynamicForwards.push(fwd);
    } else if (arg === '-A') {
      forwardAgent = true;
    } else if (arg === '-t') {
      // -tt forces a TTY (real OpenSSH); a single -t is plain "yes".
      requestTty = requestTty === 'yes' ? 'force' : 'yes';
    } else if (arg === '-tt') {
      requestTty = 'force';
    } else if (arg === '-T') {
      requestTty = 'no';
    } else if (arg === '-o' && i + 1 < args.length) {
      optionValues.push(args[++i]);
    } else if (arg.startsWith('-o') && arg.length > 2) {
      optionValues.push(arg.slice(2));
    } else if (!arg.startsWith('-')) {
      host = arg;
    }
  }
  if (!host) return null;
  const strict = parseStrictHostKeyChecking(firstSshOption(optionValues, 'stricthostkeychecking'));
  const hashValue = firstSshOption(optionValues, 'hashknownhosts');
  const hashKnownHosts = hashValue === undefined ? undefined : sshFlag(hashValue) ?? undefined;
  const proxyJump = firstSshOption(optionValues, 'proxyjump');
  if (jumpHostsRaw.length === 0 && proxyJump !== undefined) {
    for (const hop of parseProxyJumpSpec(proxyJump)) {
      jumpHostsRaw.push(hop.user ? `${hop.user}@${hop.host}` : hop.host);
    }
  }
  for (const spec of everySshOption(optionValues, 'localforward')) {
    const forward = SshPortForward.parse('local', spec.trim());
    if (forward) localForwards.push(forward);
  }
  for (const spec of everySshOption(optionValues, 'remoteforward')) {
    const forward = SshPortForward.parse('remote', spec.trim());
    if (forward) remoteForwards.push(forward);
  }
  for (const spec of everySshOption(optionValues, 'dynamicforward')) {
    const forward = SshPortForward.parse('dynamic', spec.trim());
    if (forward) dynamicForwards.push(forward);
  }
  const agentValue = firstSshOption(optionValues, 'forwardagent');
  const forwardAgentRequested = forwardAgent || (agentValue !== undefined && sshFlag(agentValue) === true);
  const ttyValue = firstSshOption(optionValues, 'requesttty')?.toLowerCase();
  const ttyFromOption = ttyValue === 'yes' || ttyValue === 'true' ? 'yes' : ttyValue === 'no' || ttyValue === 'false' ? 'no' : ttyValue === 'force' ? 'force' : undefined;
  return {
    userAtHost: host,
    port,
    identityFiles: Object.freeze([...identityFiles]),
    strict,
    command: commandTokens.length > 0 ? commandTokens.join(' ') : null,
    hashKnownHosts,
    jumpHosts: Object.freeze([...jumpHostsRaw]),
    localForwards: Object.freeze([...localForwards]),
    remoteForwards: Object.freeze([...remoteForwards]),
    dynamicForwards: Object.freeze([...dynamicForwards]),
    forwardAgent: forwardAgentRequested,
    requestTty: requestTty ?? ttyFromOption,
    authentication: sshClientAuthentication(optionValues),
    algorithms: sshClientAlgorithms(optionValues),
  };
}

export interface ParsedSshLine {
  readonly user: string | null;
  readonly host: string;
  readonly port: number;
  readonly command: string | null;
  readonly quiet: boolean;
  readonly algorithms: SshAlgorithmPreferences;
  readonly strict: StrictHostKeyChecking | undefined;
}

export function parseSshCommandLine(
  line: string, commandWord: RegExp = /^ssh(\s|$)/,
): ParsedSshLine | null {
  const trimmed = line.trim();
  if (!commandWord.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/).slice(1);

  const login = tokens.indexOf('-l');
  const loginName = login >= 0 ? tokens[login + 1] ?? null : null;
  const args = login >= 0 ? [...tokens.slice(0, login), ...tokens.slice(login + 2)] : tokens;

  const parsed = parseSshArgs(args);
  if (parsed === null) return { user: null, host: '', port: 22, command: null, quiet: false, algorithms: {}, strict: undefined };
  const at = parsed.userAtHost.indexOf('@');
  const host = at >= 0 ? parsed.userAtHost.slice(at + 1) : parsed.userAtHost;
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;
  return {
    user: at >= 0 ? parsed.userAtHost.slice(0, at) : loginName,
    host,
    port: parsed.port,
    command: parsed.command,
    quiet: args.slice(0, args.indexOf(parsed.userAtHost)).includes('-q'),
    algorithms: parsed.algorithms,
    strict: parsed.strict,
  };
}

export const WINDOWS_SSH_COMMAND_WORD = /^ssh(\.exe)?(\s|$)/i;
