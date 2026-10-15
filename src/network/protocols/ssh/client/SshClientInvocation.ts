import type { ISshLocalFs } from '../ISshLocalFs';
import { loadClientConfigOptions, SshClientSettings, type ClientConfigLocations } from './SshClientSettings';

export interface ClientPlatformLayout {
  readonly home: string;
  readonly userConfig: string;
  readonly systemConfig: string;
  readonly systemKnownHosts: readonly string[];
}

export interface ClientInvocation {
  readonly flags: readonly string[];
  readonly target: string;
  readonly fs: ISshLocalFs;
  readonly localUser: string;
  readonly localHostName: string;
  readonly uid: number;
  readonly layout: ClientPlatformLayout;
}

export function linuxClientLayout(home: string): ClientPlatformLayout {
  return {
    home,
    userConfig: `${home}/.ssh/config`,
    systemConfig: '/etc/ssh/ssh_config',
    systemKnownHosts: ['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2'],
  };
}

export function windowsClientLayout(home: string): ClientPlatformLayout {
  return {
    home,
    userConfig: `${home}/.ssh/config`,
    systemConfig: '/ProgramData/ssh/ssh_config',
    systemKnownHosts: ['/ProgramData/ssh/ssh_known_hosts', '/ProgramData/ssh/ssh_known_hosts2'],
  };
}

const COMMAND_LINE_OPTIONS: Readonly<Record<string, (value: string) => string | null>> = {
  l: (value) => `user ${value}`,
  p: (value) => `port ${value}`,
  i: (value) => `identityfile ${value}`,
  o: (value) => value,
  J: (value) => `proxyjump ${value}`,
};

const COMMAND_LINE_SWITCHES: Readonly<Record<string, string>> = {
  A: 'forwardagent yes',
  a: 'forwardagent no',
  q: 'loglevel quiet',
  v: 'loglevel debug1',
  '4': 'addressfamily inet',
  '6': 'addressfamily inet6',
  C: 'compression yes',
  T: 'requesttty no',
  t: 'requesttty yes',
  X: 'forwardx11 yes',
  Y: 'forwardx11trusted yes',
  x: 'forwardx11 no',
};

function commandLineOptions(flags: readonly string[]): { options: string[]; configFile: string | null } {
  const options: string[] = [];
  let configFile: string | null = null;
  for (let at = 0; at < flags.length; at += 1) {
    const flag = flags[at];
    if (!flag.startsWith('-') || flag.length !== 2) continue;
    const letter = flag[1];
    if (letter === 'F') { configFile ??= flags[at + 1] ?? null; at += 1; continue; }
    const withValue = COMMAND_LINE_OPTIONS[letter];
    if (withValue !== undefined) {
      const value = flags[at + 1];
      at += 1;
      if (value === undefined) continue;
      const option = withValue(value);
      if (option !== null) options.push(option);
      continue;
    }
    const switchOption = COMMAND_LINE_SWITCHES[letter];
    if (switchOption !== undefined) options.push(switchOption);
  }
  return { options, configFile };
}

/**
 * Short `ssh` options that consume a value — the character right after
 * the dash (`-p 22`, `-L spec`, `-o Name=val`, …). `-q` / `-Q` are
 * deliberately excluded: the simulator treats them as the quiet switch.
 */
export const SSH_VALUE_FLAGS = new Set(
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
export function splitSshCommandLine(args: string[]): { positional: string[]; flags: string[] } {
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

export function resolveClientInvocation(invocation: ClientInvocation): SshClientSettings {
  const at = invocation.target.lastIndexOf('@');
  const typedHost = at >= 0 ? invocation.target.slice(at + 1) : invocation.target;
  const typedUser = at >= 0 ? invocation.target.slice(0, at) : null;
  const { options, configFile } = commandLineOptions(invocation.flags);
  const commandLine = typedUser === null ? options : [`user ${typedUser}`, ...options];
  const cliUser = commandLine.find((line) => line.startsWith('user '))?.slice('user '.length).trim();
  const locations: ClientConfigLocations = {
    userConfig: invocation.layout.userConfig,
    systemConfig: invocation.layout.systemConfig,
    explicitConfig: configFile === null ? null : invocation.fs.normalizePath(configFile, invocation.layout.home),
  };
  const fromFiles = loadClientConfigOptions(
    invocation.fs,
    locations,
    { originalHost: typedHost, user: cliUser ?? invocation.localUser, localUser: invocation.localUser },
    invocation.layout.home,
  );
  return SshClientSettings.resolve([...commandLine, ...fromFiles], {
    home: invocation.layout.home,
    localUser: invocation.localUser,
    localHostName: invocation.localHostName,
    typedHost,
    defaultUser: invocation.localUser,
    uid: invocation.uid,
    systemKnownHosts: invocation.layout.systemKnownHosts,
  });
}
