import { IPAddress } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const DEFAULT_RADDB = '/etc/freeradius/3.0';
const REAL_ROOT_WORDS = new Set(['add', 'debug', 'help', 'hup', 'inject', 'set', 'show', 'stats', 'terminate', 'remove', '?']);
const NOT_MODELLED_OPTIONS = new Set(['D', 'E', 'i', 'n', 's', 'S']);
const WITH_ARGUMENT = new Set(['d', 'D', 'e', 'f', 'i', 'n', 's']);

const USAGE = [
  'Usage: radmin [ args ]',
  '  -d raddb_dir    Configuration files are in "raddbdir/*".',
  '  -e command      Execute \'command\' and then exit.',
  '  -f socket_file  Open socket_file directly, without reading radius.conf',
  '  -h              Print usage help information.',
  '  -q              Quiet mode.',
  '  -v              Print version information.',
].join('\n');

function commandOutput(ctx: LinuxCommandContext, command: string, writable: boolean): { text: string; failed: boolean } {
  const words = command.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return { text: '', failed: false };
  if (words[0] === 'exit' || words[0] === 'quit') return { text: '', failed: false };
  if (words[0] === 'show' && words[1] === 'client' && words[2] === 'list') {
    const rest = words.slice(3);
    if (rest.length === 0) return { text: ctx.radiusd!.clientListing(false).join('\n'), failed: false };
    if (rest.length > 1) return { text: `ERROR: Unknown command ${rest[0]} ${rest[1]} ...`, failed: true };
    if (rest[0] !== 'verbose') return { text: `ERROR: Unknown command ${rest[0]}`, failed: true };
    return { text: ctx.radiusd!.clientListing(true).join('\n'), failed: false };
  }
  if (words[0] === 'show' && words[1] === 'client' && words[2] === 'config') {
    const rest = words.slice(3);
    if (rest.length === 0) return { text: 'ERROR: Must specify <ipaddr>', failed: true };
    if (IPAddress.tryParse(rest[0]) === null) return { text: 'ERROR: Failed parsing IP address', failed: true };
    for (const option of rest.slice(1)) {
      if (option === 'listen') return { text: 'ERROR: The client option listen is not implemented in this simulator: clients of a virtual server are not listed per listener', failed: true };
      if (option !== 'udp' && option !== 'tcp') return { text: `ERROR: Unknown argument ${option}.`, failed: true };
    }
    const lines = ctx.radiusd!.clientConfig(rest[0]);
    return lines === null ? { text: 'ERROR: No such client', failed: true } : { text: lines.join('\n'), failed: false };
  }
  if (words[0] === 'show' && words[1] === 'home_server' && words[2] === 'list') {
    const rest = words.slice(3);
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== 'all')) return { text: `ERROR: Unknown command ${rest[0]}`, failed: true };
    return { text: ctx.radiusd!.homeServerListing(rest.length === 1).join('\n'), failed: false };
  }
  if (words[0] === 'show' && words[1] === 'home_server' && words[2] === 'state') return homeServerState(ctx, words.slice(3), null);
  if (words[0] === 'set' && words[1] === 'home_server' && words[2] === 'state') {
    if (!writable) return { text: "ERROR: You do not have write permission.  See 'mode = rw' in the 'listen' section for this socket.", failed: true };
    return homeServerState(ctx, words.slice(3), 'set');
  }
  if (REAL_ROOT_WORDS.has(words[0])) return { text: `ERROR: The command '${command.trim()}' is not implemented in this simulator`, failed: true };
  return { text: `ERROR: Unknown command '${words[0]}'`, failed: true };
}

function homeServerState(ctx: LinuxCommandContext, args: string[], mode: 'set' | null): { text: string; failed: boolean } {
  const need = mode === 'set' ? 3 : 2;
  if (args.length < need) return { text: mode === 'set' ? 'ERROR: Must specify <ipaddr> <port> [udp|tcp] <state>' : 'ERROR: Must specify <ipaddr> <port> [udp|tcp] OR <name> <type>', failed: true };
  const address = IPAddress.tryParse(args[0]);
  if (address === null || !/^\d/.test(args[1])) return { text: `ERROR: No such home server - ${args[0]} ${args[1]}`, failed: true };
  let index = 2;
  while (index < args.length && (args[index] === 'udp' || args[index] === 'tcp')) {
    if (args[index] === 'tcp') return { text: `ERROR: No such home server - ${args[0]} ${args[1]}`, failed: true };
    index++;
  }
  if (args[index] === 'src') return { text: 'ERROR: The home server option src is not implemented in this simulator', failed: true };
  const port = Number(args[1]);
  const current = ctx.radiusd!.homeServerStateText(address.toString(), port);
  if (current === null) return { text: `ERROR: No such home server - ${args[0]} ${args[1]}`, failed: true };
  if (mode === null) return { text: current, failed: false };
  const state = args[index];
  if (state !== 'alive' && state !== 'dead' && state !== 'down') return { text: `ERROR: Unknown state '${state}'`, failed: true };
  ctx.radiusd!.setHomeServerState(address.toString(), port, state);
  return { text: '', failed: false };
}

async function runRadmin(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
  if (!ctx.radiusd) return { output: 'radmin: command not found', exitCode: 127 };
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('-') || token === '-') return { output: USAGE, exitCode: 1 };
    for (let position = 1; position < token.length; position++) {
      const letter = token[position];
      if (WITH_ARGUMENT.has(letter)) {
        const rest = token.slice(position + 1);
        const value = rest !== '' ? rest : args[++index];
        if (value === undefined) return { output: USAGE, exitCode: 1 };
        values.set(letter, value);
        break;
      }
      if (letter !== 'h' && letter !== 'q' && letter !== 'v') return { output: USAGE, exitCode: 1 };
      flags.add(letter);
    }
  }
  if (flags.has('h')) return { output: USAGE, exitCode: 0 };
  if (flags.has('v')) return { output: 'radmin version 3.2.11', exitCode: 0 };
  for (const letter of NOT_MODELLED_OPTIONS) {
    if (values.has(letter)) return { output: `radmin: -${letter} is not implemented in this simulator`, exitCode: 1 };
  }
  if (values.has('d') && values.has('f')) return { output: 'radmin: -d and -f cannot be used together.', exitCode: 1 };
  let socket = values.get('f');
  if (socket === undefined) {
    const directory = values.get('d') ?? DEFAULT_RADDB;
    if (directory !== DEFAULT_RADDB) return { output: `radmin: -d ${directory} is not implemented in this simulator: only ${DEFAULT_RADDB} is read`, exitCode: 1 };
    const configured = ctx.radiusd.configuredControlSockets();
    if (configured.length === 0) return { output: `radmin: Could not find control socket in ${DEFAULT_RADDB}/radiusd.conf`, exitCode: 1 };
    socket = configured[0];
  }
  const command = values.get('e');
  if (command === undefined) return { output: 'radmin: interactive mode is not implemented in this simulator; use -e command', exitCode: 1 };
  const control = ctx.radiusd.controlSocketPaths().find((candidate) => candidate.path === socket);
  if (control === undefined) {
    return {
      output: [`radmin: Failed connecting to ${socket}: No such file or directory`, 'Perhaps you need to run the commands:\tcd /etc/raddb', '\tln -s sites-available/control-socket sites-enabled/control-socket', 'and then re-start the server?', 'Failed to connect to server'].join('\n'),
      exitCode: 1,
    };
  }
  const result = commandOutput(ctx, command, control.writable);
  return { output: result.text, exitCode: result.failed ? 1 : 0 };
}

export const radminCommand: LinuxCommand = {
  name: 'radmin',
  package: 'freeradius',
  needsNetworkContext: true,
  manSection: 8,
  usage: '[ args ]',
  help: 'FreeRADIUS server administration tool, over the control socket.',
  options: [
    { flag: '-d', description: 'Configuration files are in "raddbdir/*".', takesArg: true, argName: 'raddb_dir' },
    { flag: '-e', description: "Execute 'command' and then exit.", takesArg: true, argName: 'command' },
    { flag: '-f', description: 'Open socket_file directly, without reading radius.conf', takesArg: true, argName: 'socket_file' },
    { flag: '-q', description: 'Quiet mode.' },
    { flag: '-v', description: 'Print version information.' },
  ],
  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await runRadmin(ctx, args)).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return runRadmin(ctx, args);
  },
};
