/**
 * Shell Parser and Executor Tests
 *
 * Tests the shell lexer, parser, and executor for proper handling of:
 * - Pipes
 * - Redirections
 * - Combined pipes and redirections
 * - Command chaining (&&, ||, ;)
 * - Quotes and escapes
 * - Variables
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tokenize, TokenType } from '../terminal/shell/lexer';
import { parseShellInput, astToString } from '../terminal/shell/parser';
import { executeShellCommand } from '../terminal/shell/executor';
import { executeInlineLoop, clearShellFunctions, hasShellFunction } from '../terminal/shell/scriptInterpreter';
import { FileSystem } from '../terminal/filesystem';
import { PackageManager } from '../terminal/packages';
import { TerminalState } from '../terminal/types';

describe('Shell Lexer', () => {
  it('tokenizes simple words', () => {
    const result = tokenize('echo hello world');
    expect(result.success).toBe(true);
    expect(result.tokens.length).toBe(4); // 3 words + EOF
    expect(result.tokens[0].type).toBe(TokenType.WORD);
    expect(result.tokens[0].value).toBe('echo');
  });

  it('tokenizes pipes', () => {
    const result = tokenize('ls | grep foo');
    expect(result.success).toBe(true);
    const pipeToken = result.tokens.find(t => t.type === TokenType.PIPE);
    expect(pipeToken).toBeDefined();
    expect(pipeToken?.value).toBe('|');
  });

  it('tokenizes redirections', () => {
    const result = tokenize('echo hello > file.txt');
    expect(result.success).toBe(true);
    const redirectToken = result.tokens.find(t => t.type === TokenType.REDIRECT_OUT);
    expect(redirectToken).toBeDefined();
  });

  it('tokenizes append redirections', () => {
    const result = tokenize('echo hello >> file.txt');
    expect(result.success).toBe(true);
    const redirectToken = result.tokens.find(t => t.type === TokenType.REDIRECT_APPEND);
    expect(redirectToken).toBeDefined();
    expect(redirectToken?.value).toBe('>>');
  });

  it('tokenizes single-quoted strings', () => {
    const result = tokenize("echo 'hello world'");
    expect(result.success).toBe(true);
    const stringToken = result.tokens.find(t => t.type === TokenType.STRING_SINGLE);
    expect(stringToken).toBeDefined();
    expect(stringToken?.value).toBe('hello world');
  });

  it('tokenizes double-quoted strings', () => {
    const result = tokenize('echo "hello world"');
    expect(result.success).toBe(true);
    const stringToken = result.tokens.find(t => t.type === TokenType.STRING_DOUBLE);
    expect(stringToken).toBeDefined();
    expect(stringToken?.value).toBe('hello world');
  });

  it('tokenizes variables', () => {
    const result = tokenize('echo $HOME');
    expect(result.success).toBe(true);
    const varToken = result.tokens.find(t => t.type === TokenType.VARIABLE);
    expect(varToken).toBeDefined();
    expect(varToken?.value).toBe('$HOME');
  });

  it('tokenizes AND operator', () => {
    const result = tokenize('cd /tmp && ls');
    expect(result.success).toBe(true);
    const andToken = result.tokens.find(t => t.type === TokenType.AND);
    expect(andToken).toBeDefined();
    expect(andToken?.value).toBe('&&');
  });

  it('tokenizes OR operator', () => {
    const result = tokenize('test -f file || echo missing');
    expect(result.success).toBe(true);
    const orToken = result.tokens.find(t => t.type === TokenType.OR);
    expect(orToken).toBeDefined();
    expect(orToken?.value).toBe('||');
  });

  it('tokenizes command substitution', () => {
    const result = tokenize('echo $(date)');
    expect(result.success).toBe(true);
    const cmdSubToken = result.tokens.find(t => t.type === TokenType.COMMAND_SUB);
    expect(cmdSubToken).toBeDefined();
    expect(cmdSubToken?.value).toBe('date');
  });

  it('handles complex command with quotes and pipe', () => {
    const result = tokenize('echo "print(\'hello\')" >> file.py | python file.py');
    expect(result.success).toBe(true);

    // Should have: echo, quoted_string, >>, file.py, |, python, file.py, EOF
    const pipeToken = result.tokens.find(t => t.type === TokenType.PIPE);
    const appendToken = result.tokens.find(t => t.type === TokenType.REDIRECT_APPEND);

    expect(pipeToken).toBeDefined();
    expect(appendToken).toBeDefined();
  });
});

describe('Shell Parser', () => {
  it('parses simple command', () => {
    const result = parseShellInput('ls -la');
    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.ast?.body.length).toBe(1);
    expect(result.ast?.body[0].commands[0].command.name.value).toBe('ls');
  });

  it('parses pipeline', () => {
    const result = parseShellInput('ls | grep foo | wc -l');
    expect(result.success).toBe(true);
    expect(result.ast?.body[0].commands.length).toBe(3);
  });

  it('parses redirection', () => {
    const result = parseShellInput('echo hello > file.txt');
    expect(result.success).toBe(true);
    const cmd = result.ast?.body[0].commands[0];
    expect(cmd?.redirections.length).toBe(1);
    expect(cmd?.redirections[0].operator).toBe('>');
  });

  it('parses command with append redirection AND pipe', () => {
    const result = parseShellInput('echo "text" >> file.txt | cat file.txt');
    expect(result.success).toBe(true);

    // Should be a pipeline with 2 commands
    expect(result.ast?.body[0].commands.length).toBe(2);

    // First command has append redirection
    const firstCmd = result.ast?.body[0].commands[0];
    expect(firstCmd?.redirections.some(r => r.operator === '>>')).toBe(true);

    // Second command is cat
    const secondCmd = result.ast?.body[0].commands[1];
    expect(secondCmd?.command.name.value).toBe('cat');
  });

  it('parses chained commands with &&', () => {
    const result = parseShellInput('cd /tmp && ls');
    expect(result.success).toBe(true);
    expect(result.ast?.body.length).toBe(2);
    expect(result.ast?.operators[0]).toBe('&&');
  });
});

describe('Shell Executor', () => {
  let fs: FileSystem;
  let pm: PackageManager;
  let state: TerminalState;

  beforeEach(() => {
    fs = new FileSystem();
    pm = new PackageManager();

    // Install python package
    pm.install(['python3']);

    state = {
      currentPath: '/home/user',
      currentUser: 'user',
      hostname: 'test-host',
      history: [],
      historyIndex: -1,
      aliases: {},
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/user',
        USER: 'user',
      },
      isRoot: false,
    };
  });

  it('executes simple command', () => {
    const result = executeShellCommand('echo hello', state, fs, pm);
    expect(result.output).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('executes pipe correctly', () => {
    const result = executeShellCommand('echo "line1\nline2\nline3" | wc -l', state, fs, pm);
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('3');
  });

  it('executes redirection correctly', () => {
    const result = executeShellCommand('echo "test content" > /home/user/test.txt', state, fs, pm);
    expect(result.exitCode).toBe(0);

    const file = fs.getNode('/home/user/test.txt');
    expect(file).toBeDefined();
    expect(file?.content).toContain('test content');
  });

  it('executes append redirection correctly', () => {
    // First write
    executeShellCommand('echo "line1" > /home/user/append.txt', state, fs, pm);

    // Then append
    executeShellCommand('echo "line2" >> /home/user/append.txt', state, fs, pm);

    const file = fs.getNode('/home/user/append.txt');
    expect(file?.content).toContain('line1');
    expect(file?.content).toContain('line2');
  });

  it('executes redirection with pipe', () => {
    // Create file first
    executeShellCommand('echo "hello world" > /home/user/test.txt', state, fs, pm);

    // Then cat and pipe to grep
    const result = executeShellCommand('cat /home/user/test.txt | grep hello', state, fs, pm);
    expect(result.output).toContain('hello');
  });

  it('handles chained commands with &&', () => {
    const result = executeShellCommand('echo first && echo second', state, fs, pm);
    expect(result.output).toContain('first');
    expect(result.output).toContain('second');
  });

  it('handles chained commands with || (short circuit)', () => {
    // First succeeds, so second shouldn't run
    const result = executeShellCommand('echo first || echo second', state, fs, pm);
    expect(result.output).toContain('first');
    expect(result.output).not.toContain('second');
  });

  it('handles sort pipe', () => {
    const result = executeShellCommand('echo "c\nb\na" | sort', state, fs, pm);
    expect(result.exitCode).toBe(0);
    const lines = result.output.trim().split('\n');
    expect(lines[0]).toBe('a');
    expect(lines[1]).toBe('b');
    expect(lines[2]).toBe('c');
  });

  it('handles grep pipe', () => {
    const result = executeShellCommand('echo "foo\nbar\nbaz" | grep ba', state, fs, pm);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('bar');
    expect(result.output).toContain('baz');
    expect(result.output).not.toContain('foo');
  });

  it('handles head pipe', () => {
    const result = executeShellCommand('echo "1\n2\n3\n4\n5" | head -n 2', state, fs, pm);
    expect(result.exitCode).toBe(0);
    const lines = result.output.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('1');
    expect(lines[1]).toBe('2');
  });

  it('handles tail pipe', () => {
    const result = executeShellCommand('echo "1\n2\n3\n4\n5" | tail -n 2', state, fs, pm);
    expect(result.exitCode).toBe(0);
    const lines = result.output.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('4');
    expect(lines[1]).toBe('5');
  });
});

describe('Shell Functions', () => {
  let fs: FileSystem;
  let pm: PackageManager;
  let state: TerminalState;

  beforeEach(() => {
    clearShellFunctions();
    fs = new FileSystem();
    pm = new PackageManager();
    state = {
      currentPath: '/home/user',
      currentUser: 'user',
      hostname: 'test-host',
      history: [],
      historyIndex: -1,
      aliases: {},
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/user',
        USER: 'user',
      },
      isRoot: false,
    };
  });

  it('defines and calls inline function', () => {
    // Define function
    const defResult = executeInlineLoop('greet() { echo "Hello"; }', state, fs, pm);
    expect(defResult).not.toBeNull();
    expect(defResult?.exitCode).toBe(0);
    expect(hasShellFunction('greet')).toBe(true);

    // Call function
    const callResult = executeInlineLoop('greet', state, fs, pm);
    expect(callResult).not.toBeNull();
    expect(callResult?.output).toBe('Hello');
  });

  it('handles function with positional argument $1', () => {
    // Define function with $1
    executeInlineLoop('sayhi() { echo "Hi $1"; }', state, fs, pm);

    // Call with argument
    const result = executeInlineLoop('sayhi World', state, fs, pm);
    expect(result).not.toBeNull();
    expect(result?.output).toBe('Hi World');
  });

  it('handles function with multiple arguments', () => {
    executeInlineLoop('add() { echo "$1 + $2"; }', state, fs, pm);

    const result = executeInlineLoop('add 5 3', state, fs, pm);
    expect(result).not.toBeNull();
    expect(result?.output).toBe('5 + 3');
  });

  it('handles $# for argument count', () => {
    executeInlineLoop('countargs() { echo "Count: $#"; }', state, fs, pm);

    const result = executeInlineLoop('countargs a b c', state, fs, pm);
    expect(result).not.toBeNull();
    expect(result?.output).toBe('Count: 3');
  });

  it('handles $@ for all arguments', () => {
    executeInlineLoop('allargs() { echo "Args: $@"; }', state, fs, pm);

    const result = executeInlineLoop('allargs one two three', state, fs, pm);
    expect(result).not.toBeNull();
    expect(result?.output).toBe('Args: one two three');
  });

  it('handles for loop', () => {
    const result = executeInlineLoop('for i in 1 2 3; do echo $i; done', state, fs, pm);
    expect(result).not.toBeNull();
    expect(result?.output).toBe('1\n2\n3');
  });

  it('handles if statement', () => {
    const result = executeInlineLoop('if true; then echo yes; else echo no; fi', state, fs, pm);
    expect(result).not.toBeNull();
    expect(result?.output).toBe('yes');
  });

  it('handles brace expansion in for loop', () => {
    const result = executeInlineLoop('for i in {1..3}; do echo $i; done', state, fs, pm);
    expect(result).not.toBeNull();
    expect(result?.output).toBe('1\n2\n3');
  });
});
