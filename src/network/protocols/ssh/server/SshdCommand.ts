import { diagnoseSshdConfig } from './SshdConfigValidator';
import { readSshdConfig, type SshdConfigSource } from './SshdConfigText';
import { dumpSshdConfig, type SshdConnectionSpec, type SshdPlatformProfile } from './SshdDump';
import { SSHD_CONFIG_KEYWORDS } from './SshdConfigKeywords';

export interface SshdCommandResult {
  readonly output: string;
  readonly exitCode: number;
}

export interface SshdDaemonRequest {
  readonly ports: readonly number[];
  readonly listenAddresses: readonly string[];
  readonly configPath: string;
  readonly foreground: boolean;
  readonly commandLine: string;
}

export interface SshdCommandHost {
  readonly invokedAs: string;
  readonly platform: 'linux' | 'windows';
  readonly profile: SshdPlatformProfile;
  readonly defaultConfigPath: string;
  readonly includeBase: string;
  readonly version: string;
  readonly source: SshdConfigSource;
  resolvePath(path: string): string;
  isPrivileged(): boolean;
  canReadHostKey(path: string): boolean;
  portTaken(address: string, port: number): boolean;
  separationDirectoryMissing(): string | null;
  logDaemon(level: 'error' | 'fatal', message: string): void;
  startDaemon(request: SshdDaemonRequest): void;
}

const USAGE = [
  'usage: sshd [-46DdeGiqTtV] [-C connection_spec] [-c host_cert_file]',
  '            [-E log_file] [-f config_file] [-g login_grace_time]',
  '            [-h host_key_file] [-o option] [-p port] [-u len]',
].join('\n');

const OPTIONS_WITH_ARGUMENT = new Set(['C', 'E', 'b', 'c', 'f', 'g', 'h', 'k', 'o', 'p', 'u']);
const OPTIONS_WITHOUT_ARGUMENT = new Set(['4', '6', 'D', 'G', 'Q', 'R', 'T', 'd', 'e', 'i', 'q', 'r', 't', 'V']);

interface ParsedOptions {
  readonly flags: ReadonlySet<string>;
  readonly configPath: string | null;
  readonly ports: readonly string[];
  readonly hostKeys: readonly string[];
  readonly lines: readonly string[];
  readonly connection: string | null;
  readonly extra: readonly string[];
}

type Parsed = { readonly ok: true; readonly options: ParsedOptions } | { readonly ok: false; readonly message: string };

function parseArguments(args: readonly string[], program: string): Parsed {
  const flags = new Set<string>();
  const ports: string[] = [];
  const hostKeys: string[] = [];
  const lines: string[] = [];
  let configPath: string | null = null;
  let connection: string | null = null;
  const extra: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === '--') { extra.push(...args.slice(index + 1)); break; }
    if (!word.startsWith('-') || word === '-') { extra.push(word); continue; }
    for (let position = 1; position < word.length; position += 1) {
      const letter = word[position];
      if (OPTIONS_WITHOUT_ARGUMENT.has(letter)) { flags.add(letter); continue; }
      if (!OPTIONS_WITH_ARGUMENT.has(letter)) return { ok: false, message: `${program}: invalid option -- '${letter}'\n${USAGE}` };
      const attached = word.slice(position + 1);
      const value = attached !== '' ? attached : args[++index];
      if (value === undefined) return { ok: false, message: `${program}: option requires an argument -- '${letter}'\n${USAGE}` };
      if (letter === 'f') configPath = value;
      else if (letter === 'p') ports.push(value);
      else if (letter === 'h') hostKeys.push(value);
      else if (letter === 'o') lines.push(value);
      else if (letter === 'C') connection = value;
      break;
    }
  }
  return { ok: true, options: { flags, configPath, ports, hostKeys, lines, connection, extra } };
}

function parseConnection(spec: string): { value: SshdConnectionSpec } | { error: string } {
  const fields: Record<string, string> = {};
  for (const pair of spec.split(',')) {
    const at = pair.indexOf('=');
    if (at < 0) return { error: `Invalid test mode specification ${pair}` };
    const key = pair.slice(0, at);
    if (!['user', 'host', 'addr', 'laddr', 'lport', 'rdomain'].includes(key)) {
      return { error: `Invalid test mode specification ${pair}` };
    }
    fields[key] = pair.slice(at + 1);
  }
  return {
    value: {
      ...(fields.user === undefined ? {} : { user: fields.user }),
      ...(fields.host === undefined ? {} : { host: fields.host }),
      ...(fields.addr === undefined ? {} : { addr: fields.addr }),
      ...(fields.laddr === undefined ? {} : { laddr: fields.laddr }),
      ...(fields.lport === undefined ? {} : { lport: Number(fields.lport) }),
    },
  };
}

function overlayCommandLine(text: string, options: ParsedOptions): { text: string; problems: string[] } {
  const problems: string[] = [];
  const replaced = new Set<string>();
  const front: string[] = [];
  if (options.ports.length > 0) {
    replaced.add('port');
    for (const port of options.ports) front.push(`Port ${port}`);
  }
  if (options.hostKeys.length > 0) {
    replaced.add('hostkey');
    for (const key of options.hostKeys) front.push(`HostKey ${key}`);
  }
  for (const line of options.lines) {
    const keyword = line.trim().split(/[\s=]+/)[0] ?? '';
    if (!SSHD_CONFIG_KEYWORDS.has(keyword.toLowerCase())) {
      problems.push(`command-line line 0: Bad configuration option: ${keyword}`);
      continue;
    }
    replaced.add(keyword.toLowerCase());
    front.push(line.trim().replace(/^(\S+)=/, '$1 '));
  }
  const kept = text.split('\n').filter((line) => {
    const keyword = line.trim().split(/\s+/)[0]?.toLowerCase();
    return !(keyword !== undefined && replaced.has(keyword));
  });
  return { text: `${[...front, ...kept].join('\n')}\n`, problems };
}

export function runSshd(args: readonly string[], host: SshdCommandHost): SshdCommandResult {
  const parsed = parseArguments(args, host.invokedAs);
  if (parsed.ok === false) return { output: parsed.message, exitCode: 1 };
  const options = parsed.options;
  if (options.flags.has('V')) return { output: host.version, exitCode: 0 };
  if (options.extra.length > 0) return { output: `Extra argument ${options.extra[0]}.`, exitCode: 1 };
  const testing = options.flags.has('t') || options.flags.has('T') || options.flags.has('G');
  const absolute = host.platform === 'windows' || host.invokedAs.startsWith('/');
  if (!testing && !absolute) {
    return { output: 'sshd re-exec requires execution with an absolute path', exitCode: 255 };
  }
  const configPath = host.resolvePath(options.configPath ?? host.defaultConfigPath);
  if (host.source.readFile(configPath) === null) {
    return { output: `${options.configPath ?? host.defaultConfigPath}: No such file or directory`, exitCode: 1 };
  }
  const diagnosis = diagnoseSshdConfig(host.source, configPath, host.includeBase);
  if (diagnosis.fatal) return { output: diagnosis.lines.join('\n'), exitCode: 255 };
  const overlay = overlayCommandLine(readSshdConfig(host.source, configPath), options);
  if (overlay.problems.length > 0) {
    return {
      output: [...overlay.problems, `command-line: terminating, ${overlay.problems.length} bad configuration options`].join('\n'),
      exitCode: 255,
    };
  }
  const connection = options.connection === null ? { value: {} } : parseConnection(options.connection);
  if ('error' in connection) return { output: connection.error, exitCode: 255 };

  const hostKeys = overlay.text.split('\n')
    .map((line) => /^hostkey\s+(\S+)/i.exec(line.trim())?.[1])
    .filter((entry): entry is string => entry !== undefined);
  const keyPaths = hostKeys.length > 0 ? hostKeys : host.profile.hostKeyPaths;
  const loaded = keyPaths.filter((path) => host.isPrivileged() && host.canReadHostKey(path));
  if (loaded.length === 0 && !options.flags.has('G')) {
    return { output: 'sshd: no hostkeys available -- exiting.', exitCode: 1 };
  }
  if (options.flags.has('T') || options.flags.has('G')) {
    return { output: dumpSshdConfig(overlay.text, host.profile, connection.value).replace(/\n$/, ''), exitCode: 0 };
  }
  if (options.flags.has('t')) return { output: '', exitCode: 0 };

  const missing = host.separationDirectoryMissing();
  if (missing !== null) return fatalOutput(host, options, `Missing privilege separation directory: ${missing}`);

  const ports = [...overlay.text.matchAll(/^port\s+(\d+)/gim)].map((match) => Number(match[1]));
  const wanted = ports.length > 0 ? ports : [22];
  const listen = [...overlay.text.matchAll(/^listenaddress\s+(\S+)/gim)].map((match) => match[1]);
  const family = /^addressfamily\s+(\S+)/im.exec(overlay.text)?.[1] ?? 'any';
  const addresses = (listen.length > 0 ? listen : ['0.0.0.0', '::']).filter((address) => (
    family === 'any' || (family === 'inet') === !address.includes(':')
  ));
  const failures: string[] = [];
  let bound = 0;
  for (const port of wanted) {
    for (const address of addresses) {
      if (host.portTaken(address, port)) {
        failures.push(`Bind to port ${port} on ${address} failed: Address already in use.`);
      } else {
        bound += 1;
      }
    }
  }
  for (const failure of failures) emit(host, options, 'error', failure);
  if (bound === 0) return fatalOutput(host, options, 'Cannot bind any address.', failures);
  host.startDaemon({
    ports: wanted, listenAddresses: addresses, configPath,
    foreground: options.flags.has('D') || options.flags.has('d'),
    commandLine: [host.invokedAs, ...args].join(' '),
  });
  return { output: options.flags.has('e') || options.flags.has('d') ? failures.join('\n') : '', exitCode: 0 };
}

function emit(host: SshdCommandHost, options: ParsedOptions, level: 'error' | 'fatal', message: string): void {
  if (!options.flags.has('e') && !options.flags.has('d')) host.logDaemon(level, message);
}

function fatalOutput(
  host: SshdCommandHost, options: ParsedOptions, message: string, before: readonly string[] = [],
): SshdCommandResult {
  emit(host, options, 'fatal', message);
  const onTerminal = options.flags.has('e') || options.flags.has('d');
  return { output: onTerminal ? [...before, message].join('\n') : '', exitCode: 255 };
}
