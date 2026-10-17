import { everySshOption, firstSshOption, sshFlag } from '../SshClientOptions';
import { sshPathOfWindowsPath } from '../localFs/WindowsSshLocalFs';
import { parseStrictHostKeyChecking, type StrictHostKeyChecking } from '../SshConnectOptions';
import type { ISshLocalFs } from '../ISshLocalFs';
import { SshClientConfigFile, type ClientConfigInclude, type ClientConfigSource } from './SshClientConfigFile';

export interface ClientSettingsEnvironment {
  readonly home: string;
  readonly localUser: string;
  readonly localHostName: string;
  readonly typedHost: string;
  readonly defaultUser: string;
  readonly uid: number;
  readonly systemKnownHosts: readonly string[];
}

const DEFAULT_USER_KNOWN_HOSTS = ['~/.ssh/known_hosts', '~/.ssh/known_hosts2'];

function splitValueList(raw: string): string[] {
  return (raw.match(/"[^"]*"|\S+/g) ?? []).map((word) => (word.startsWith('"') && word.endsWith('"') ? word.slice(1, -1) : word));
}

export class SshClientSettings {
  private constructor(
    private readonly options: readonly string[],
    private readonly environment: ClientSettingsEnvironment,
  ) {}

  static resolve(options: readonly string[], environment: ClientSettingsEnvironment): SshClientSettings {
    return new SshClientSettings(options, environment);
  }

  get optionValues(): readonly string[] {
    return this.options;
  }

  get hostName(): string {
    const configured = firstSshOption(this.options, 'hostname');
    return configured === undefined ? this.environment.typedHost : configured.replace(/%h/g, this.environment.typedHost);
  }

  get user(): string {
    return firstSshOption(this.options, 'user') ?? this.environment.defaultUser;
  }

  get port(): number {
    const parsed = Number.parseInt(firstSshOption(this.options, 'port') ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 22;
  }

  get identityFiles(): string[] {
    return everySshOption(this.options, 'identityfile').map((value) => this.expand(value));
  }

  get certificateFiles(): string[] {
    return everySshOption(this.options, 'certificatefile').map((value) => this.expand(value));
  }

  get revokedHostKeys(): string | undefined {
    const value = firstSshOption(this.options, 'revokedhostkeys');
    return value === undefined || value.toLowerCase() === 'none' ? undefined : this.expand(value);
  }

  get identitiesOnly(): boolean {
    return sshFlag(firstSshOption(this.options, 'identitiesonly') ?? '') === true;
  }

  get strictHostKeyChecking(): StrictHostKeyChecking | undefined {
    return parseStrictHostKeyChecking(firstSshOption(this.options, 'stricthostkeychecking'));
  }

  get hashKnownHosts(): boolean {
    return sshFlag(firstSshOption(this.options, 'hashknownhosts') ?? '') === true;
  }

  get userKnownHostsFiles(): string[] {
    const configured = everySshOption(this.options, 'userknownhostsfile').flatMap(splitValueList);
    const files = configured.length > 0 ? configured : DEFAULT_USER_KNOWN_HOSTS;
    return files.filter((file) => file.toLowerCase() !== 'none').map((file) => this.expand(file));
  }

  get globalKnownHostsFiles(): string[] {
    const configured = everySshOption(this.options, 'globalknownhostsfile').flatMap(splitValueList);
    return (configured.length > 0 ? configured : [...this.environment.systemKnownHosts]).map((file) => this.expand(file));
  }

  get forwardAgent(): boolean {
    const value = firstSshOption(this.options, 'forwardagent');
    return value !== undefined && sshFlag(value) === true;
  }

  expand(value: string): string {
    const env = this.environment;
    const withHome = value === '~' ? env.home : value.startsWith('~/') ? `${env.home}${value.slice(1)}` : value;
    const posix = /^[A-Za-z]:[\\/]/.test(withHome) ? sshPathOfWindowsPath(withHome) : withHome;
    return posix.replace(/%([%dhnpruLli])/g, (_, token: string) => {
      switch (token) {
        case '%': return '%';
        case 'd': return env.home;
        case 'h': return this.hostName;
        case 'n': return env.typedHost;
        case 'p': return String(this.port);
        case 'r': return this.user;
        case 'u': return env.localUser;
        case 'i': return String(env.uid);
        default: return env.localHostName;
      }
    });
  }
}

export interface ClientConfigLocations {
  readonly userConfig: string;
  readonly systemConfig: string;
  readonly explicitConfig: string | null;
}

function globToExpression(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
}

function sourceFor(fs: ISshLocalFs, baseDirectory: string, home: string): ClientConfigSource {
  return {
    readFile: (path) => fs.readFile(path),
    expandInclude: (pattern): readonly ClientConfigInclude[] => {
      const absolute = pattern.startsWith('~/') ? `${home}${pattern.slice(1)}` : pattern.startsWith('/') ? pattern : `${baseDirectory}/${pattern}`;
      const slash = absolute.lastIndexOf('/');
      const directory = absolute.slice(0, slash) || '/';
      const base = absolute.slice(slash + 1);
      if (!/[*?]/.test(base)) {
        const text = fs.readFile(absolute);
        return text === null ? [] : [{ path: absolute, text }];
      }
      const expression = globToExpression(base);
      return (fs.listDirectory(directory) ?? [])
        .filter((entry) => expression.test(entry.name) && entry.inode.type !== 'directory')
        .map((entry) => entry.name)
        .sort()
        .flatMap((name) => {
          const path = `${directory}/${name}`;
          const text = fs.readFile(path);
          return text === null ? [] : [{ path, text }];
        });
    },
  };
}

export function loadClientConfigOptions(
  fs: ISshLocalFs,
  locations: ClientConfigLocations,
  context: { readonly originalHost: string; readonly user: string; readonly localUser: string },
  home: string,
): string[] {
  const matchContext = { originalHost: context.originalHost, hostName: context.originalHost, user: context.user, localUser: context.localUser };
  const lines: string[] = [];
  const files = locations.explicitConfig !== null ? [locations.explicitConfig] : [locations.userConfig, locations.systemConfig];
  for (const path of files) {
    const text = fs.readFile(path);
    if (text === null) continue;
    const directory = path.slice(0, path.lastIndexOf('/')) || '/';
    const source = sourceFor(fs, path === locations.systemConfig ? directory : `${home}/.ssh`, home);
    lines.push(...SshClientConfigFile.parse(text, source).optionValues(matchContext));
  }
  return lines;
}
