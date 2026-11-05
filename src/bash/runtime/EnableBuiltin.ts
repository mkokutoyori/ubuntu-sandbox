import type { Environment } from './Environment';

export const BASH_BUILTIN_NAMES: readonly string[] = [
  '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'compopt',
  'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts',
  'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read',
  'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type',
  'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
];

const SPECIAL_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  '.', ':', 'break', 'continue', 'eval', 'exec', 'exit', 'export', 'readonly', 'return', 'set', 'shift', 'source', 'times', 'trap', 'unset',
]);

const ENABLE_USAGE = 'enable: usage: enable [-a] [-dnps] [-f filename] [name ...]\n';

interface EnableResult {
  readonly output: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

function usageError(message: string): EnableResult {
  return { output: '', stderr: `bash: enable: ${message}\n${ENABLE_USAGE}`, exitCode: 2 };
}

export function builtinEnable(args: readonly string[], env: Environment): EnableResult {
  const flags = new Set<string>();
  let library: string | null = null;
  let index = 0;
  for (; index < args.length; index++) {
    const word = args[index];
    if (word === '--') { index++; break; }
    if (!word.startsWith('-') || word === '-') break;
    for (let position = 1; position < word.length; position++) {
      const letter = word[position];
      if (letter === 'f') {
        const attached = word.slice(position + 1);
        if (attached !== '') library = attached;
        else if (index + 1 < args.length) library = args[++index];
        else return usageError('-f: option requires an argument');
        flags.add('f');
        break;
      }
      if (!'adnps'.includes(letter)) return usageError(`-${letter}: invalid option`);
      flags.add(letter);
    }
  }
  const names = args.slice(index);
  if (names.length === 0) {
    const disabled = env.listDisabledBuiltins();
    const lines: string[] = [];
    for (const name of BASH_BUILTIN_NAMES) {
      if (flags.has('s') && !SPECIAL_BUILTIN_NAMES.has(name)) continue;
      const off = disabled.includes(name);
      if (flags.has('a')) lines.push(off ? `enable -n ${name}` : `enable ${name}`);
      else if (flags.has('n') ? off : !off) lines.push(off ? `enable -n ${name}` : `enable ${name}`);
    }
    return { output: lines.map((line) => `${line}\n`).join(''), exitCode: 0 };
  }
  if (library !== null) {
    return { output: '', stderr: `bash: enable: cannot open shared object ${library}: ${library}: cannot open shared object file: No such file or directory\n`, exitCode: 1 };
  }
  let errors = '';
  for (const name of names) {
    if (!BASH_BUILTIN_NAMES.includes(name)) { errors += `bash: enable: ${name}: not a shell builtin\n`; continue; }
    if (flags.has('d')) { errors += `bash: enable: ${name}: not dynamically loaded\n`; continue; }
    env.setBuiltinDisabled(name, flags.has('n'));
  }
  return { output: '', ...(errors === '' ? {} : { stderr: errors }), exitCode: errors === '' ? 0 : 1 };
}
