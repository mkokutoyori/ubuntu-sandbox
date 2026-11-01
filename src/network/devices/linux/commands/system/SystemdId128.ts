import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { getoptDiagnostic, shortOptions, type LongOption } from '../Getopt';
import { GPT_PARTITION_TYPES } from '../../system/GptPartitionTypes';
import { NULL_ID128, appSpecificId, parseId128, prettySample, toUuid } from '../../system/Id128';
import { JOURNALCTL_VERSION, SYSTEMD_FEATURES } from '../../journal/JournalctlTool';
import { resolveVerb, type SystemdVerb } from './SystemdVerbs';

type PrintMode = 'id128' | 'uuid' | 'pretty';

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const PROGRAM = 'systemd-id128';
const MACHINE_ID_PATH = '/etc/machine-id';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const ENOENT = 'No such file or directory';
const EINVAL = 'Invalid argument';
const ENXIO = 'No such device or address';
const MACRO_NAME = 'XYZ';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'version', letter: '', takesArgument: false },
  { name: 'pretty', letter: 'p', takesArgument: false },
  { name: 'value', letter: 'P', takesArgument: false },
  { name: 'app-specific', letter: 'a', takesArgument: true },
  { name: 'uuid', letter: 'u', takesArgument: false },
];

const VERBS: readonly SystemdVerb[] = [
  { name: 'new', maxArguments: 1 },
  { name: 'machine-id', maxArguments: 1 },
  { name: 'boot-id', maxArguments: 1 },
  { name: 'invocation-id', maxArguments: 1 },
  { name: 'show', maxArguments: null },
  { name: 'help', maxArguments: null },
];

const HELP = [
  `${PROGRAM} [OPTIONS...] COMMAND`,
  '',
  'Generate and print 128-bit identifiers.',
  '',
  'Commands:',
  '  new                     Generate a new ID',
  '  machine-id              Print the ID of current machine',
  '  boot-id                 Print the ID of current boot',
  '  invocation-id           Print the ID of current invocation',
  '  show [NAME|UUID]        Print one or more UUIDs',
  '  help                    Show this help',
  '',
  'Options:',
  '  -h --help               Show this help',
  '  -p --pretty             Generate samples of program code',
  '  -P --value              Only print the value',
  '  -a --app-specific=ID    Generate app-specific IDs',
  '  -u --uuid               Output in UUID format',
  '',
  'See the systemd-id128(1) man page for details.',
  '',
].join('\n');

const failure = (message: string): Run => ({ stdout: '', stderr: `${message}\n`, exitCode: 1 });
const success = (stdout: string): Run => ({ stdout, stderr: '', exitCode: 0 });

function render(id: string, mode: PrintMode, macro = MACRO_NAME): string {
  if (mode === 'pretty') return prettySample(macro, id);
  return `${mode === 'uuid' ? toUuid(id) : id}\n`;
}

function readIdentifier(ctx: LinuxCommandContext, path: string): { id: string } | { error: string } {
  const text = ctx.executor.vfs.readFile(path);
  if (text === null) return { error: ENOENT };
  const id = parseId128(text.trim());
  return id === null ? { error: EINVAL } : { id };
}

function tableRows(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, id]) => (id === '' ? name : `${name.padEnd(width)} ${id}`)).join('\n') + '\n';
}

function show(operands: readonly string[], mode: PrintMode, value: boolean, app: string | null): Run {
  const entries: Array<readonly [string, string]> = [];
  let stdout = '';
  const targets = operands.length === 0
    ? GPT_PARTITION_TYPES
    : operands.map((operand): readonly [string, string] | null => {
      const asId = parseId128(operand);
      if (asId !== null) return [GPT_PARTITION_TYPES.find(([, id]) => id === asId)?.[0] ?? MACRO_NAME, asId];
      const named = GPT_PARTITION_TYPES.find(([name]) => name === operand);
      return named === undefined ? null : [operand, named[1]];
    });
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (target === null) return { stdout, stderr: `Unknown identifier "${operands[i]}".\n`, exitCode: 1 };
    const [name, uuid] = target;
    const id = app === null ? uuid : appSpecificId(uuid, app);
    if (mode === 'pretty') {
      stdout += `${i === 0 ? '' : '\n'}${prettySample(name.replace(/-/g, '_').toUpperCase(), id)}`;
    } else if (value) {
      stdout += render(id, mode);
    } else {
      entries.push([name, mode === 'id128' ? id : toUuid(id)]);
    }
  }
  if (entries.length === 0) return success(stdout);
  return success(stdout + tableRows([['NAME', 'ID'], ...entries]));
}

function runSystemdId128(ctx: LinuxCommandContext, args: readonly string[]): Run {
  let mode: PrintMode = 'id128';
  let value = false;
  let app: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'hpa:uP', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return failure(getoptDiagnostic(PROGRAM, item));
    if (item.long === 'version') return success(`${JOURNALCTL_VERSION}\n${SYSTEMD_FEATURES}\n`);
    if (item.letter === 'h') return success(HELP);
    if (item.letter === 'p') { mode = 'pretty'; value = false; }
    else if (item.letter === 'P') { value = true; if (mode === 'pretty') mode = 'id128'; }
    else if (item.letter === 'u') mode = 'uuid';
    else if (item.letter === 'a') {
      const parsed = parseId128(item.argument ?? '');
      if (parsed === null) return failure(`Failed to parse "${item.argument}" as application-ID: ${EINVAL}`);
      if (parsed === NULL_ID128) return failure('Application ID cannot be all zeros.');
      app = parsed;
    }
  }
  const resolved = resolveVerb(operands, VERBS);
  if ('error' in resolved) return failure(resolved.error);
  const label = app === null ? '' : 'app-specific ';
  switch (resolved.verb.name) {
    case 'new':
      return success(render(ctx.executor.randomUuid().replace(/-/g, ''), mode));
    case 'machine-id':
    case 'boot-id': {
      const verb = resolved.verb.name;
      const read = readIdentifier(ctx, verb === 'machine-id' ? MACHINE_ID_PATH : BOOT_ID_PATH);
      if ('error' in read) return failure(`Failed to get ${label}${verb === 'machine-id' ? 'machine' : 'boot'}-ID: ${read.error}`);
      return success(render(app === null ? read.id : appSpecificId(read.id, app), mode));
    }
    case 'invocation-id': {
      if (app !== null) return failure('Verb "invocation-id" cannot be combined with --app-specific=.');
      const id = parseId128(ctx.executor.commandEnvironment().INVOCATION_ID ?? '');
      return id === null ? failure(`Failed to get invocation-ID: ${ENXIO}`) : success(render(id, mode));
    }
    case 'show':
      return show(operands.slice(1), mode, value, app);
    default:
      return success(HELP);
  }
}

function statusOf(ctx: LinuxCommandContext, args: string[]) {
  const result = runSystemdId128(ctx, args);
  return { output: result.stdout, exitCode: result.exitCode, stderr: result.stderr };
}

export const systemdId128Command: LinuxCommand = {
  name: PROGRAM,
  needsNetworkContext: true,
  usage: `${PROGRAM} [OPTIONS...] COMMAND`,
  help: 'Generate and print 128-bit identifiers.',
  ownsHelpOption: true,
  run(ctx: LinuxCommandContext, args: string[]): string {
    const result = statusOf(ctx, args);
    return result.output + result.stderr;
  },
  runWithStatusSync: statusOf,
  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return statusOf(ctx, args);
  },
};
