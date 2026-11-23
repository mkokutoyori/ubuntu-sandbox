import { describeListener } from '../../freeradius/RadiusdSiteConfig';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { formatCtime } from '../../time/ctime';
import { simulationNowMs } from '@/network/core/SystemClock';
import { IPAddress } from '@/network/core/types';

const NAME = 'freeradius';
const VERSION = '3.2.11';
const HOST_INFO = 'x86_64-pc-linux-gnu';

export const RADIUSD_VERSION_LINE = `FreeRADIUS Version ${VERSION}, for host ${HOST_INFO}`;
const DEFAULT_RADDB = '/etc/freeradius/3.0';
const DEFAULT_NAME = 'radiusd';

const USAGE_LINES = [
  `Usage: ${NAME} [options]`,
  'Options:',
  '  -C            Check configuration and exit.',
  `  -d <raddb>    Set configuration directory (defaults to ${DEFAULT_RADDB}).`,
  '  -D <dictdir>  Set main dictionary directory (defaults to /usr/share/freeradius).',
  '  -f            Run as a foreground process, not a daemon.',
  '  -h            Print this help message.',
  '  -i <ipaddr>   Listen on ipaddr ONLY.',
  '  -l <log_file> Logging output will be written to this file.',
  '  -m            On SIGINT or SIGQUIT clean up all used memory instead of just exiting.',
  '  -n <name>     Read raddb/name.conf instead of raddb/radiusd.conf.',
  '  -p <port>     Listen on port ONLY.',
  '  -P            Always write out PID, even with -f.',
  '  -s            Do not spawn child processes to handle requests (same as -ft).',
  '  -t            Disable threads.',
  '  -v            Print server version information.',
  '  -X            Turn on full debugging (similar to -tfxxl stdout).',
  '  -x            Turn on additional debugging (-xx gives more debugging).',
];

const BANNER_LINES = [
  `FreeRADIUS Version ${VERSION}`,
  'Copyright (C) 1999-2026 The FreeRADIUS server project and contributors',
  'There is NO warranty; not even for MERCHANTABILITY or FITNESS FOR A',
  'PARTICULAR PURPOSE',
  'You may redistribute copies of FreeRADIUS under the terms of the',
  'GNU General Public License',
  'For more information about these matters, see the file named COPYRIGHT',
  ' ',
  'FreeRADIUS is developed, maintained, and supported by InkBridge Networks.',
  'For commercial support, please email sales@inkbridgenetworks.com',
  'https://inkbridgenetworks.com/',
];

const OPTIONS_WITH_ARGUMENT = new Set(['d', 'D', 'i', 'l', 'n', 'p']);
const KNOWN_FLAGS = new Set(['C', 'f', 'h', 'm', 'M', 'P', 's', 't', 'v', 'x', 'X']);

interface Parsed {
  flags: Set<string>;
  values: Map<string, string>;
  debugLevel: number;
  toStdout: boolean;
  logFile: string | null;
  invalid: string | null;
  missingArgument: string | null;
}

function parseOptions(args: string[]): Parsed {
  const parsed: Parsed = {
    flags: new Set(), values: new Map(), debugLevel: 0, toStdout: false, logFile: null, invalid: null, missingArgument: null,
  };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('-') || token === '-' || token === '--') break;
    for (let position = 1; position < token.length; position++) {
      const letter = token[position];
      if (OPTIONS_WITH_ARGUMENT.has(letter)) {
        const rest = token.slice(position + 1);
        const value = rest !== '' ? rest : args[++index];
        if (value === undefined) { parsed.missingArgument = letter; return parsed; }
        parsed.values.set(letter, value);
        if (letter === 'l') {
          if (value === 'stdout') parsed.toStdout = true;
          else { parsed.logFile = value; }
        }
        break;
      }
      if (!KNOWN_FLAGS.has(letter)) { parsed.invalid = letter; return parsed; }
      parsed.flags.add(letter);
      if (letter === 'x') parsed.debugLevel += 1;
      if (letter === 'X') { parsed.debugLevel += 2; parsed.toStdout = true; }
    }
  }
  return parsed;
}

const REFUSED_VALUES: Record<string, string> = {
  D: 'only the built-in dictionaries are modelled',
};

interface Sink {
  line(text: string, kind: 'info' | 'error'): void;
  debug(text: string, level: number): void;
  flush(): { output: string };
}

function makeSink(ctx: LinuxCommandContext, parsed: Parsed, report: { logFile: string | null }): Sink {
  const stamped = parsed.debugLevel !== 1 && parsed.debugLevel !== 2;
  const lines: string[] = [];
  const stamp = (): string => formatCtime(new Date(simulationNowMs()));
  const emit = (text: string, label: string): void => {
    lines.push(stamped ? `${stamp()} : ${label}: ${text}` : text);
  };
  const toFile = !parsed.toStdout && (parsed.logFile ?? report.logFile) !== null;
  const fileTarget = parsed.logFile ?? report.logFile;
  const fileLines: string[] = [];
  return {
    line(text, kind) {
      const label = kind === 'error' ? 'Error' : 'Info';
      if (parsed.toStdout) emit(text, label);
      else if (toFile) fileLines.push(`${stamp()} : ${label}: ${text}`);
    },
    debug(text, level) {
      if (parsed.debugLevel >= level && parsed.toStdout) emit(text, 'Debug');
    },
    flush() {
      if (fileTarget !== null && fileLines.length > 0) ctx.radiusd!.appendLog(fileTarget, `${fileLines.join('\n')}\n`);
      return { output: lines.join('\n') };
    },
  };
}

function run(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const parsed = parseOptions(args);
  if (parsed.invalid !== null) {
    return { output: [`${NAME}: invalid option -- '${parsed.invalid}'`, ...USAGE_LINES].join('\n'), exitCode: 1 };
  }
  if (parsed.missingArgument !== null) {
    return { output: [`${NAME}: option requires an argument -- '${parsed.missingArgument}'`, ...USAGE_LINES].join('\n'), exitCode: 1 };
  }
  if (parsed.flags.has('h')) return { output: USAGE_LINES.join('\n'), exitCode: 0 };
  if (parsed.flags.has('v')) {
    return { output: [`${NAME}: ${RADIUSD_VERSION_LINE}`, ...BANNER_LINES].join('\n'), exitCode: 0 };
  }
  for (const [flag, reason] of Object.entries(REFUSED_VALUES)) {
    if (parsed.values.has(flag)) return { output: `${NAME}: -${flag} is not implemented in this simulator: ${reason}.`, exitCode: 1 };
  }
  if (ctx.radiusd === undefined) return { output: `${NAME}: command not found`, exitCode: 127 };

  let authPort: number | undefined;
  let address: string | undefined;
  const portText = parsed.values.get('p');
  if (portText !== undefined) {
    const port = /^\d+$/.test(portText) ? Number(portText) : 0;
    if (port === 0 || port > 65535) return { output: `${NAME}: Invalid port number "${portText}"`, exitCode: 1 };
    authPort = port;
  }
  const addressText = parsed.values.get('i');
  if (addressText !== undefined) {
    const resolved = IPAddress.tryParse(addressText) ?? ctx.net.resolveHostnameSync(addressText);
    if (resolved === null) return { output: `${NAME}: Invalid IP Address or hostname "${addressText}"`, exitCode: 1 };
    address = resolved.toString();
  }
  if ((authPort === undefined) !== (address === undefined)) {
    return { output: `${NAME}: The options -i and -p cannot be used individually.`, exitCode: 1 };
  }

  const raddb = (parsed.values.get('d') ?? DEFAULT_RADDB).replace(/\/+$/, '');
  const confName = parsed.values.get('n') ?? DEFAULT_NAME;
  const mainFile = `${raddb}/${confName}.conf`;
  const paths = { main: mainFile, clients: `${raddb}/clients.conf`, users: `${raddb}/users` };
  const report = ctx.radiusd.checkConfigReport(paths);
  const sink = makeSink(ctx, parsed, report);
  if (parsed.debugLevel > 0) for (const text of BANNER_LINES) sink.line(text, 'info');
  for (const file of report.files) sink.debug(`including configuration file ${file}`, 2);

  if (!report.ok) {
    for (const message of report.errors) sink.line(message, 'error');
    return { ...sink.flush(), exitCode: 1 };
  }
  if (parsed.flags.has('C')) {
    sink.debug('Configuration appears to be OK', 1);
    return { ...sink.flush(), exitCode: 0 };
  }

  const started = ctx.radiusd.startFromCommandLine({ ...(authPort === undefined ? {} : { authPort, address }), debug: parsed.debugLevel > 0 });
  if ('errors' in started) {
    for (const message of started.errors) sink.line(message, 'error');
    return { ...sink.flush(), exitCode: 1 };
  }
  for (const spec of ctx.radiusd.listeners()) sink.debug(`Listening on ${describeListener(spec)}`, 1);
  sink.line('Ready to process requests', 'info');
  return { ...sink.flush(), exitCode: 0 };
}

export const freeradiusCommand: LinuxCommand = {
  name: NAME,
  package: 'freeradius',
  needsNetworkContext: true,
  manSection: 8,
  usage: '[options]',
  help: 'FreeRADIUS server: start the daemon, check the configuration with -C, print the version with -v.',
  options: [
    { flag: '-C', description: 'Check configuration and exit.' },
    { flag: '-d', description: 'Set configuration directory.', takesArg: true, argName: 'raddb' },
    { flag: '-f', description: 'Run as a foreground process, not a daemon.' },
    { flag: '-h', description: 'Print this help message.' },
    { flag: '-l', description: 'Logging output will be written to this file (stdout for the terminal).', takesArg: true, argName: 'log_file' },
    { flag: '-m', description: 'Clean up all used memory on exit.' },
    { flag: '-n', description: 'Read raddb/name.conf instead of raddb/radiusd.conf.', takesArg: true, argName: 'name' },
    { flag: '-v', description: 'Print server version information.' },
    { flag: '-X', description: 'Turn on full debugging (similar to -tfxxl stdout).' },
    { flag: '-x', description: 'Turn on additional debugging.' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return run(ctx, args).output;
  },

  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return Promise.resolve(run(ctx, args));
  },
};
