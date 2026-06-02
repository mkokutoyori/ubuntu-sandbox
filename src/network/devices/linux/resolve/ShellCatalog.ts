/**
 * ShellCatalog — an exhaustive, data-rich catalogue of the Bash reserved
 * words (keywords) and shell builtins, used by `type`, `command -V`,
 * `compgen -b/-k`, `help`, and command resolution generally.
 *
 * Each entry is a first-class {@link ShellWord} carrying enough metadata
 * (kind, description, POSIX-special flag, man section) to drive realistic
 * output today and richer introspection later, even where a given field
 * is not yet consumed.
 */

export type ShellWordKind = 'keyword' | 'builtin';

export interface ShellWord {
  /** The word as typed at the prompt. */
  readonly name: string;
  /** Whether it is a reserved word or a builtin command. */
  readonly kind: ShellWordKind;
  /** One-line synopsis, mirroring `help <name>`'s first line. */
  readonly description: string;
  /** True for the 14 POSIX "special builtins" (assignment persistence, etc.). */
  readonly special: boolean;
  /** True when the builtin/keyword is mandated by POSIX (vs a Bash extension). */
  readonly posix: boolean;
  /** Conventional man-page section (1 for most, 7 for `builtins`). */
  readonly manSection: number;
}

function kw(name: string, description: string, posix = true): ShellWord {
  return { name, kind: 'keyword', description, special: false, posix, manSection: 1 };
}
function bi(name: string, description: string, opts: { special?: boolean; posix?: boolean } = {}): ShellWord {
  return { name, kind: 'builtin', description, special: opts.special ?? false, posix: opts.posix ?? true, manSection: 1 };
}

/** Bash reserved words (`compgen -k`). */
export const BASH_KEYWORDS: readonly ShellWord[] = [
  kw('if', 'Execute commands based on conditional.'),
  kw('then', 'Branch taken when an `if`/`elif` test succeeds.'),
  kw('else', 'Branch taken when all `if`/`elif` tests fail.'),
  kw('elif', 'Else-if branch of an `if` construct.'),
  kw('fi', 'Terminate an `if` construct.'),
  kw('case', 'Execute commands based on pattern matching.'),
  kw('esac', 'Terminate a `case` construct.'),
  kw('for', 'Execute commands for each member in a list.'),
  kw('select', 'Select words from a list and execute commands.'),
  kw('while', 'Execute commands as long as a test succeeds.'),
  kw('until', 'Execute commands as long as a test does not succeed.'),
  kw('do', 'Begin the body of a loop.'),
  kw('done', 'Terminate the body of a loop.'),
  kw('in', 'Introduce the word list of a `for`/`case`.'),
  kw('function', 'Define a shell function.', false),
  kw('time', 'Report time consumed by pipeline execution.', false),
  kw('coproc', 'Create a coprocess named NAME.', false),
  kw('{', 'Group commands as a unit in the current shell.'),
  kw('}', 'Terminate a brace group.'),
  kw('!', 'Negate the exit status of a pipeline.'),
  kw('[[', 'Evaluate a conditional expression.', false),
  kw(']]', 'Terminate a `[[` conditional expression.', false),
];

/** Bash builtin commands (`compgen -b`). */
export const BASH_BUILTINS: readonly ShellWord[] = [
  bi(':', 'Null command; expand arguments and return success.', { special: true }),
  bi('.', 'Execute commands from a file in the current shell.', { special: true }),
  bi('source', 'Execute commands from a file in the current shell.', { posix: false }),
  bi('alias', 'Define or display aliases.', { posix: false }),
  bi('bg', 'Move jobs to the background.'),
  bi('bind', 'Set Readline key bindings and variables.', { posix: false }),
  bi('break', 'Exit from within a for/while/until loop.', { special: true }),
  bi('builtin', 'Execute a shell builtin.', { posix: false }),
  bi('caller', 'Return the context of the current subroutine call.', { posix: false }),
  bi('cd', 'Change the shell working directory.'),
  bi('command', 'Execute a simple command or display information about commands.'),
  bi('compgen', 'Display possible completions depending on the options.', { posix: false }),
  bi('complete', 'Specify how arguments are to be completed by Readline.', { posix: false }),
  bi('compopt', 'Modify or display completion options.', { posix: false }),
  bi('continue', 'Resume the next iteration of a loop.', { special: true }),
  bi('declare', 'Set variable values and attributes.', { posix: false }),
  bi('dirs', 'Display the list of currently remembered directories.', { posix: false }),
  bi('disown', 'Remove jobs from the current shell.', { posix: false }),
  bi('echo', 'Write arguments to the standard output.', { posix: false }),
  bi('enable', 'Enable and disable shell builtins.', { posix: false }),
  bi('eval', 'Execute arguments as a shell command.', { special: true }),
  bi('exec', 'Replace the shell with the given command.', { special: true }),
  bi('exit', 'Exit the shell.', { special: true }),
  bi('export', 'Set export attribute for shell variables.', { special: true }),
  bi('false', 'Return an unsuccessful result.'),
  bi('fc', 'Display or execute commands from the history list.'),
  bi('fg', 'Move job to the foreground.'),
  bi('getopts', 'Parse option arguments.'),
  bi('hash', 'Remember or display program locations.'),
  bi('help', 'Display information about builtin commands.', { posix: false }),
  bi('history', 'Display or manipulate the history list.', { posix: false }),
  bi('jobs', 'Display status of jobs.'),
  bi('kill', 'Send a signal to a job or process.'),
  bi('let', 'Evaluate arithmetic expressions.', { posix: false }),
  bi('local', 'Define local variables.', { posix: false }),
  bi('logout', 'Exit a login shell.', { posix: false }),
  bi('mapfile', 'Read lines from the standard input into an array variable.', { posix: false }),
  bi('popd', 'Remove directories from the stack.', { posix: false }),
  bi('printf', 'Format and print arguments.'),
  bi('pushd', 'Add directories to the stack.', { posix: false }),
  bi('pwd', 'Print the name of the current working directory.'),
  bi('read', 'Read a line from the standard input and split it into fields.'),
  bi('readarray', 'Read lines from a file into an array variable.', { posix: false }),
  bi('readonly', 'Mark shell variables as unchangeable.', { special: true }),
  bi('return', 'Return from a shell function.', { special: true }),
  bi('set', 'Set or unset values of shell options and positional parameters.', { special: true }),
  bi('shift', 'Shift positional parameters.', { special: true }),
  bi('shopt', 'Set and unset shell options.', { posix: false }),
  bi('suspend', 'Suspend shell execution.', { posix: false }),
  bi('test', 'Evaluate conditional expression.'),
  bi('[', 'Evaluate conditional expression (bracketed `test`).'),
  bi('times', 'Display process times.', { special: true }),
  bi('trap', 'Trap signals and other events.', { special: true }),
  bi('true', 'Return a successful result.'),
  bi('type', 'Display information about command type.', { posix: false }),
  bi('typeset', 'Set variable values and attributes (obsolete `declare`).', { posix: false }),
  bi('ulimit', 'Modify shell resource limits.', { posix: false }),
  bi('umask', 'Display or set file mode mask.'),
  bi('unalias', 'Remove each NAME from the list of defined aliases.', { posix: false }),
  bi('unset', 'Unset values and attributes of shell variables and functions.', { special: true }),
  bi('wait', 'Wait for jobs to complete and return exit status.'),
];

/** Indexed lookup over the keyword + builtin catalogue. */
export class ShellWordCatalog {
  private readonly byName = new Map<string, ShellWord>();

  constructor(words: readonly ShellWord[]) {
    for (const w of words) this.byName.set(w.name, w);
  }

  get(name: string): ShellWord | undefined { return this.byName.get(name); }
  keyword(name: string): ShellWord | undefined { const w = this.byName.get(name); return w?.kind === 'keyword' ? w : undefined; }
  builtin(name: string): ShellWord | undefined { const w = this.byName.get(name); return w?.kind === 'builtin' ? w : undefined; }
  isKeyword(name: string): boolean { return this.keyword(name) !== undefined; }
  isBuiltin(name: string): boolean { return this.builtin(name) !== undefined; }
  keywords(): ShellWord[] { return [...this.byName.values()].filter(w => w.kind === 'keyword'); }
  builtins(): ShellWord[] { return [...this.byName.values()].filter(w => w.kind === 'builtin'); }
}

/** The canonical Bash catalogue shared across the simulator. */
export const SHELL_CATALOG = new ShellWordCatalog([...BASH_KEYWORDS, ...BASH_BUILTINS]);
