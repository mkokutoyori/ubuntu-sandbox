import { sshClientAlgorithms } from '../../../protocols/ssh/SshConnectOptions';
import type { SshAlgorithmPreferences } from '../../../protocols/ssh/transport/SshTransport';
import { sshOptionValues } from '../../../protocols/ssh/SshClientCommandLine';

export interface WinWireTarget {
  host: string;
  user: string;
  port: number;
  command: string;
  identities: string[];
  algorithms: SshAlgorithmPreferences;
}

export function winWireExecTarget(args: string[], defaultUser: string): WinWireTarget | null {
  const { positional, flags } = splitSshArgs(args);
  const first = positional[0];
  if (first === undefined) return null;
  for (const blocking of ['-N', '-W', '-J', '-A', '-D', '-L', '-R']) {
    if (flags.includes(blocking)) return null;
  }
  const parsed = RE_USERHOST.exec(first);
  if (!parsed) return null;
  const identity = flags.indexOf('-i');
  return {
    host: parsed[2],
    user: parsed[1] ?? clientLoginUser(flags) ?? defaultUser,
    port: clientPort(flags),
    command: positional.slice(1).join(' ').trim(),
    identities: identity >= 0 && flags[identity + 1] ? [flags[identity + 1]] : [],
    algorithms: sshClientAlgorithms(sshOptionValues(args)),
  };
}

const RE_USERHOST = /^(?:([\w.\-\\]+)@)?([\w.:-]+)$/;

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
