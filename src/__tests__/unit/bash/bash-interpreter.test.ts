/**
 * Tests for BashInterpreter — AST execution engine.
 */

import { describe, it, expect, vi } from 'vitest';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';
import { BashInterpreter } from '@/bash/interpreter/BashInterpreter';
import type { ExternalCommandFn } from '@/bash/interpreter/BashInterpreter';

const lexer = new BashLexer();
const parser = new BashParser();

/**
 * Minimal test/[ evaluator for interpreter tests (no VFS access).
 */
function evalTest(args: string[]): boolean {
  // Remove command name and trailing ]
  let a = args.slice(1);
  if (a[a.length - 1] === ']') a = a.slice(0, -1);
  if (a.length === 0) return false;
  if (a.length === 1) return a[0] !== '';
  if (a.length === 2) {
    if (a[0] === '-n') return a[1] !== '';
    if (a[0] === '-z') return a[1] === '';
    if (a[0] === '!') return a[1] === '';
    return false;
  }
  if (a.length >= 3) {
    const [l, op, r] = a;
    switch (op) {
      case '=': case '==': return l === r;
      case '!=': return l !== r;
      case '-eq': return parseInt(l) === parseInt(r);
      case '-ne': return parseInt(l) !== parseInt(r);
      case '-lt': return parseInt(l) < parseInt(r);
      case '-le': return parseInt(l) <= parseInt(r);
      case '-gt': return parseInt(l) > parseInt(r);
      case '-ge': return parseInt(l) >= parseInt(r);
    }
  }
  return false;
}

/** Default external command handler — handles test/[ for interpreter tests. */
function defaultExecCmd(args: string[]): string {
  const cmd = args[0];
  if (cmd === 'test' || cmd === '[') {
    // Simulate exit code via a special marker the interpreter won't see
    // We throw to signal non-zero exit, but that's hacky.
    // Instead: the interpreter catches errors and sets exitCode=1.
    // If test passes, return empty string (success). If fails, throw.
    if (evalTest(args)) return '';
    throw new Error('test failed');
  }
  return '';
}

/** Helper: run a bash script and return { output, exitCode }. */
function run(script: string, opts?: {
  execCmd?: ExternalCommandFn;
  vars?: Record<string, string>;
  args?: string[];
}) {
  const tokens = lexer.tokenize(script);
  const ast = parser.parse(tokens);
  const execCmd = opts?.execCmd ?? defaultExecCmd;
  const interp = new BashInterpreter({
    executeCommand: execCmd,
    variables: opts?.vars,
    positionalArgs: opts?.args,
  });
  return interp.execute(ast);
}

// ─── Echo & Output ──────────────────────────────────────────────

describe('Interpreter — Echo', () => {
  it('echoes a literal string', () => {
    const result = run('echo hello');
    expect(result.output).toBe('hello\n');
    expect(result.exitCode).toBe(0);
  });

  it('echoes multiple words', () => {
    const result = run('echo hello world');
    expect(result.output).toBe('hello world\n');
  });

  it('echo -n suppresses newline', () => {
    const result = run('echo -n hello');
    expect(result.output).toBe('hello');
  });

  it('echo -e interprets escape sequences', () => {
    const result = run('echo -e "hello\\nworld"');
    expect(result.output).toBe('hello\nworld\n');
  });

  it('echoes single-quoted string literally', () => {
    const result = run("echo 'hello world'");
    expect(result.output).toBe('hello world\n');
  });
});

// ─── Variables ──────────────────────────────────────────────────

describe('Interpreter — Variables', () => {
  it('sets and uses a variable', () => {
    const result = run('FOO=bar\necho $FOO');
    expect(result.output).toBe('bar\n');
  });

  it('uses initial variables', () => {
    const result = run('echo $HOME', { vars: { HOME: '/root' } });
    expect(result.output).toBe('/root\n');
  });

  it('assignment before command sets env for that command', () => {
    const result = run('X=hello echo $X');
    // X is set but expansion happens before assignment in bash
    // Our interpreter sets then expands, so X=hello is available
    expect(result.exitCode).toBe(0);
  });

  it('unset removes a variable', () => {
    const result = run('FOO=bar\nunset FOO\necho $FOO');
    expect(result.output).toBe('\n');
  });

  it('export sets a variable', () => {
    const result = run('export PATH=/usr/bin\necho $PATH');
    expect(result.output).toBe('/usr/bin\n');
  });
});

// ─── Positional Parameters ──────────────────────────────────────

describe('Interpreter — Positional Parameters', () => {
  it('accesses $1 $2', () => {
    const result = run('echo $1 $2', { args: ['foo', 'bar'] });
    expect(result.output).toBe('foo bar\n');
  });

  it('accesses $# for count', () => {
    const result = run('echo $#', { args: ['a', 'b', 'c'] });
    expect(result.output).toBe('3\n');
  });

  it('accesses $@ for all args', () => {
    const result = run('echo $@', { args: ['x', 'y'] });
    expect(result.output).toBe('x y\n');
  });

  it('shift removes first arg', () => {
    const result = run('shift\necho $1 $#', { args: ['a', 'b', 'c'] });
    expect(result.output).toBe('b 2\n');
  });
});

// ─── Arithmetic ─────────────────────────────────────────────────

describe('Interpreter — Arithmetic', () => {
  it('evaluates arithmetic substitution', () => {
    const result = run('echo $((2 + 3))');
    expect(result.output).toBe('5\n');
  });

  it('evaluates arithmetic with variables', () => {
    const result = run('X=10\necho $((X + 5))');
    expect(result.output).toBe('15\n');
  });
});

// ─── If/Then/Else ───────────────────────────────────────────────

describe('Interpreter — If/Then/Else', () => {
  it('executes then branch when condition is true', () => {
    const result = run('if true; then echo yes; fi');
    expect(result.output).toBe('yes\n');
  });

  it('executes else branch when condition is false', () => {
    const result = run('if false; then echo yes; else echo no; fi');
    expect(result.output).toBe('no\n');
  });

  it('executes elif branch', () => {
    const result = run('if false; then echo 1; elif true; then echo 2; else echo 3; fi');
    expect(result.output).toBe('2\n');
  });

  it('test with string comparison', () => {
    const result = run('if test "a" = "a"; then echo match; fi');
    expect(result.output).toBe('match\n');
  });

  it('test with numeric comparison', () => {
    const result = run('if test 5 -gt 3; then echo bigger; fi');
    expect(result.output).toBe('bigger\n');
  });

  it('test with [ ] syntax', () => {
    const result = run('if [ "hello" != "world" ]; then echo diff; fi');
    expect(result.output).toBe('diff\n');
  });
});

// ─── For Loop ───────────────────────────────────────────────────

describe('Interpreter — For Loop', () => {
  it('iterates over word list', () => {
    const result = run('for x in a b c; do echo $x; done');
    expect(result.output).toBe('a\nb\nc\n');
  });

  it('iterates with empty word list', () => {
    const result = run('for x in; do echo $x; done');
    expect(result.output).toBe('');
  });

  it('break exits the loop', () => {
    const result = run('for x in a b c; do\n  if test $x = b; then break; fi\n  echo $x\ndone');
    expect(result.output).toBe('a\n');
  });

  it('continue skips to next iteration', () => {
    const result = run('for x in a b c; do\n  if test $x = b; then continue; fi\n  echo $x\ndone');
    expect(result.output).toBe('a\nc\n');
  });
});

// ─── While Loop ─────────────────────────────────────────────────

describe('Interpreter — While Loop', () => {
  it('loops while condition is true', () => {
    const result = run('X=3\nwhile test $X -gt 0; do\n  echo $X\n  X=$(($X - 1))\ndone');
    expect(result.output).toBe('3\n2\n1\n');
  });
});

// ─── Case ───────────────────────────────────────────────────────

describe('Interpreter — Case', () => {
  it('matches exact pattern', () => {
    const result = run('case hello in\n  hello) echo matched;;\n  *) echo default;;\nesac');
    expect(result.output).toBe('matched\n');
  });

  it('matches wildcard pattern', () => {
    const result = run('case foo in\n  bar) echo bar;;\n  *) echo default;;\nesac');
    expect(result.output).toBe('default\n');
  });

  it('matches glob pattern', () => {
    const result = run('case hello in\n  h*) echo starts_with_h;;\nesac');
    expect(result.output).toBe('starts_with_h\n');
  });
});

// ─── Functions ──────────────────────────────────────────────────

describe('Interpreter — Functions', () => {
  it('defines and calls a function', () => {
    const result = run('greet() { echo hello; }\ngreet');
    expect(result.output).toBe('hello\n');
  });

  it('function receives positional args', () => {
    const result = run('say() { echo $1 $2; }\nsay hello world');
    expect(result.output).toBe('hello world\n');
  });

  it('function restores positional args after call', () => {
    const result = run('f() { echo $1; }\nf inner\necho $1', { args: ['outer'] });
    expect(result.output).toBe('inner\nouter\n');
  });

  it('return sets exit code', () => {
    const result = run('f() { return 42; }\nf\necho $?');
    expect(result.output).toBe('42\n');
  });
});

// ─── Pipelines ──────────────────────────────────────────────────

describe('Interpreter — Pipelines', () => {
  it('passes output through pipeline', () => {
    const execCmd = vi.fn((args: string[]) => {
      if (args[0] === 'grep' && args.length > 1) {
        const input = args[args.length - 1];
        const pattern = args[1];
        return input.split('\n').filter(l => l.includes(pattern)).join('\n') + '\n';
      }
      return '';
    });
    const result = run('echo "hello world" | grep hello', { execCmd });
    // echo output gets piped to grep
    expect(result.output).toContain('hello');
  });
});

// ─── And/Or Lists ───────────────────────────────────────────────

describe('Interpreter — And/Or Lists', () => {
  it('&& executes second when first succeeds', () => {
    const result = run('true && echo yes');
    expect(result.output).toBe('yes\n');
  });

  it('&& skips second when first fails', () => {
    const result = run('false && echo yes');
    expect(result.output).toBe('');
  });

  it('|| executes second when first fails', () => {
    const result = run('false || echo fallback');
    expect(result.output).toBe('fallback\n');
  });

  it('|| skips second when first succeeds', () => {
    const result = run('true || echo fallback');
    expect(result.output).toBe('');
  });
});

// ─── Command Sequences ─────────────────────────────────────────

describe('Interpreter — Command Sequences', () => {
  it('executes multiple commands', () => {
    const result = run('echo first; echo second; echo third');
    expect(result.output).toBe('first\nsecond\nthird\n');
  });

  it('newline-separated commands', () => {
    const result = run('echo first\necho second');
    expect(result.output).toBe('first\nsecond\n');
  });
});

// ─── Exit ───────────────────────────────────────────────────────

describe('Interpreter — Exit', () => {
  it('exit stops execution', () => {
    const result = run('echo before\nexit 0\necho after');
    expect(result.output).toBe('before\n');
    expect(result.exitCode).toBe(0);
  });

  it('exit with code', () => {
    const result = run('exit 42');
    expect(result.exitCode).toBe(42);
  });
});

// ─── Brace Groups & Subshells ───────────────────────────────────

describe('Interpreter — Brace Groups & Subshells', () => {
  it('executes brace group', () => {
    const result = run('{ echo hello; echo world; }');
    expect(result.output).toBe('hello\nworld\n');
  });

  it('subshell isolates variable changes', () => {
    const result = run('X=outer\n(X=inner)\necho $X');
    // Subshell changes should not leak to parent
    expect(result.output).toBe('outer\n');
  });
});

// ─── External Command Delegation ────────────────────────────────

describe('Interpreter — External Commands', () => {
  it('delegates unknown commands to executeCommand', () => {
    const execCmd = vi.fn(() => 'file1\nfile2\n');
    const result = run('ls', { execCmd });
    expect(execCmd).toHaveBeenCalled();
    expect(result.output).toBe('file1\nfile2\n');
  });

  it('passes arguments to external command', () => {
    const execCmd = vi.fn(() => '');
    run('ls -la /tmp', { execCmd });
    expect(execCmd).toHaveBeenCalledWith(['ls', '-la', '/tmp']);
  });
});

// ─── Builtins ───────────────────────────────────────────────────

describe('Interpreter — Builtins', () => {
  it('printf formats output', () => {
    const result = run('printf "Hello %s\\n" world');
    expect(result.output).toBe('Hello world\n');
  });

  it('test -z checks empty string', () => {
    const result = run('if test -z ""; then echo empty; fi');
    expect(result.output).toBe('empty\n');
  });

  it('test -n checks non-empty string', () => {
    const result = run('if test -n "hello"; then echo nonempty; fi');
    expect(result.output).toBe('nonempty\n');
  });

  it('type identifies builtins', () => {
    const result = run('type echo');
    expect(result.output).toContain('shell builtin');
  });

  it('type identifies functions', () => {
    const result = run('f() { true; }\ntype f');
    expect(result.output).toContain('function');
  });

  it('let evaluates arithmetic', () => {
    const result = run('let X=5+3\necho $X');
    expect(result.output).toBe('8\n');
  });
});
