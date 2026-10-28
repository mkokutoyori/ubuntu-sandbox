import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';

const RANDOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_TEMPLATE = 'tmp.XXXXXXXXXX';
const MINIMUM_PLACEHOLDERS = 3;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

interface MktempRequest {
  directory: boolean;
  dryRun: boolean;
  quiet: boolean;
  tmpdir: string | null;
  deprecatedTmpdir: boolean;
  suffix: string;
  template: string | null;
}

export interface MktempResult {
  readonly output: string;
  readonly exitCode: number;
  readonly stderr?: string;
  readonly interleaved?: string;
}

function failure(message: string): MktempResult {
  return { output: '', exitCode: 1, stderr: `${message}\n`, interleaved: `${message}\n` };
}

function usageFailure(message: string): MktempResult {
  return failure(`${message}\nTry 'mktemp --help' for more information.`);
}

function parseArguments(args: readonly string[], defaultDirectory: string): MktempRequest | MktempResult {
  const request: MktempRequest = {
    directory: false, dryRun: false, quiet: false, tmpdir: null, deprecatedTmpdir: false, suffix: '', template: null,
  };
  const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (argument === '--directory') request.directory = true;
    else if (argument === '--dry-run') request.dryRun = true;
    else if (argument === '--quiet') request.quiet = true;
    else if (argument === '--tmpdir') request.tmpdir = defaultDirectory;
    else if (argument.startsWith('--tmpdir=')) request.tmpdir = argument.slice('--tmpdir='.length);
    else if (argument.startsWith('--suffix=')) request.suffix = argument.slice('--suffix='.length);
    else if (argument.startsWith('--') && argument.length > 2) return usageFailure(`mktemp: unrecognized option '${argument}'`);
    else if (argument.startsWith('-') && argument.length > 1) {
      for (let letter = 1; letter < argument.length; letter++) {
        const flag = argument[letter];
        if (flag === 'd') request.directory = true;
        else if (flag === 'u') request.dryRun = true;
        else if (flag === 'q') request.quiet = true;
        else if (flag === 't') request.deprecatedTmpdir = true;
        else if (flag === 'p') {
          const attached = argument.slice(letter + 1);
          if (attached !== '') request.tmpdir = attached;
          else if (index + 1 < args.length) request.tmpdir = args[++index];
          else return usageFailure("mktemp: option requires an argument -- 'p'");
          break;
        } else return usageFailure(`mktemp: invalid option -- '${flag}'`);
      }
    } else operands.push(argument);
  }
  if (operands.length > 1) return usageFailure('mktemp: too many templates');
  request.template = operands[0] ?? null;
  return request;
}

function randomName(length: number): string {
  let name = '';
  for (let index = 0; index < length; index++) name += RANDOM_ALPHABET[Math.floor(Math.random() * RANDOM_ALPHABET.length)];
  return name;
}

export function runMktemp(exec: LinuxCommandExecutor, args: readonly string[], environment: (name: string) => string | undefined): MktempResult {
  const defaultDirectory = environment('TMPDIR') ?? '/tmp';
  const parsed = parseArguments(args, defaultDirectory);
  if ('exitCode' in parsed) return parsed;
  const request = parsed;
  const template = request.template ?? DEFAULT_TEMPLATE;
  const directory = request.tmpdir ?? (request.deprecatedTmpdir || request.template === null ? defaultDirectory : null);
  const named = directory === null ? template : `${directory.replace(/\/+$/, '')}/${template}`;
  const quietly = (result: MktempResult): MktempResult => (request.quiet ? { output: '', exitCode: result.exitCode } : result);
  const lastPlaceholder = named.lastIndexOf('X');
  const implicitSuffix = request.suffix === '' && lastPlaceholder >= 0 ? named.slice(lastPlaceholder + 1) : '';
  if (implicitSuffix.includes('/')) return quietly(failure(`mktemp: invalid suffix '${implicitSuffix}', contains directory separator`));
  const stem = implicitSuffix === '' ? named : named.slice(0, lastPlaceholder + 1);
  const placeholders = /X*$/.exec(stem)?.[0].length ?? 0;
  if (placeholders < MINIMUM_PLACEHOLDERS) return quietly(failure(`mktemp: too few X's in template '${template}'`));
  const path = `${stem.replace(/X+$/, (run) => randomName(run.length))}${implicitSuffix}${request.suffix}`;
  if (request.dryRun) return { output: path, exitCode: 0 };
  const { currentUid, currentGid } = exec.userMgr;
  const absolute = exec.vfs.normalizePath(path, exec.getCwd());
  const created = request.directory
    ? exec.vfs.mkdir(absolute, DIRECTORY_MODE, currentUid, currentGid)
    : exec.vfs.createFileAt(absolute, '', FILE_MODE, currentUid, currentGid) !== null;
  if (!created) {
    return quietly(failure(`mktemp: failed to create ${request.directory ? 'directory' : 'file'} via template '${named}${request.suffix}': No such file or directory`));
  }
  return { output: path, exitCode: 0 };
}
