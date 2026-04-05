/**
 * Tests for BashParser — recursive descent parser.
 */

import { describe, it, expect } from 'vitest';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';
import type {
  Program, SimpleCommand, Pipeline, AndOrList, CommandList,
  IfClause, ForClause, WhileClause, UntilClause, CaseClause,
  FunctionDef, BraceGroup, Subshell,
  LiteralWord, SingleQuotedWord, DoubleQuotedWord, VariableRef,
  CommandSubstitution, ArithmeticSubstitution,
  Assignment, Redirection,
} from '@/bash/parser/ASTNode';

const lexer = new BashLexer();
const parser = new BashParser();

/** Helper: parse a bash string and return the Program AST. */
function parse(input: string): Program {
  const tokens = lexer.tokenize(input);
  return parser.parse(tokens);
}

/** Helper: get the first command from a program (unwraps Program→CommandList→AndOrList→Pipeline→Command). */
function firstCommand(prog: Program) {
  return prog.body.commands[0].first.commands[0];
}

// ─── Simple Commands ────────────────────────────────────────────

describe('BashParser — Simple Commands', () => {
  it('parses a single word command', () => {
    const prog = parse('ls');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.type).toBe('SimpleCommand');
    expect(cmd.words).toHaveLength(1);
    expect((cmd.words[0] as LiteralWord).value).toBe('ls');
  });

  it('parses a command with arguments', () => {
    const prog = parse('echo hello world');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words).toHaveLength(3);
    expect((cmd.words[0] as LiteralWord).value).toBe('echo');
    expect((cmd.words[1] as LiteralWord).value).toBe('hello');
    expect((cmd.words[2] as LiteralWord).value).toBe('world');
  });

  it('parses a command with single-quoted argument', () => {
    const prog = parse("echo 'hello world'");
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words).toHaveLength(2);
    expect(cmd.words[1].type).toBe('SingleQuotedWord');
    expect((cmd.words[1] as SingleQuotedWord).value).toBe('hello world');
  });

  it('parses a command with double-quoted argument', () => {
    const prog = parse('echo "hello world"');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words).toHaveLength(2);
    expect(cmd.words[1].type).toBe('DoubleQuotedWord');
  });

  it('parses a command with variable reference', () => {
    const prog = parse('echo $HOME');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words).toHaveLength(2);
    expect(cmd.words[1].type).toBe('VariableRef');
    expect((cmd.words[1] as VariableRef).name).toBe('HOME');
    expect((cmd.words[1] as VariableRef).braced).toBe(false);
  });

  it('parses a command with braced variable', () => {
    const prog = parse('echo ${HOME}');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words[1].type).toBe('VariableRef');
    expect((cmd.words[1] as VariableRef).name).toBe('HOME');
    expect((cmd.words[1] as VariableRef).braced).toBe(true);
  });

  it('parses a command with variable modifier', () => {
    const prog = parse('echo ${VAR:-default}');
    const cmd = firstCommand(prog) as SimpleCommand;
    const vr = cmd.words[1] as VariableRef;
    expect(vr.name).toBe('VAR');
    expect(vr.braced).toBe(true);
    expect(vr.modifier).toBe(':-default');
  });

  it('parses a command with special variable $?', () => {
    const prog = parse('echo $?');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words[1].type).toBe('VariableRef');
    expect((cmd.words[1] as VariableRef).name).toBe('?');
  });

  it('parses a command with command substitution $()', () => {
    const prog = parse('echo $(whoami)');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words[1].type).toBe('CommandSubstitution');
    expect((cmd.words[1] as CommandSubstitution).command).toBe('whoami');
    expect((cmd.words[1] as CommandSubstitution).backtick).toBe(false);
  });

  it('parses a command with backtick substitution', () => {
    const prog = parse('echo `whoami`');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words[1].type).toBe('CommandSubstitution');
    expect((cmd.words[1] as CommandSubstitution).command).toBe('whoami');
    expect((cmd.words[1] as CommandSubstitution).backtick).toBe(true);
  });

  it('parses a command with arithmetic substitution', () => {
    const prog = parse('echo $((1 + 2))');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.words[1].type).toBe('ArithmeticSubstitution');
    expect((cmd.words[1] as ArithmeticSubstitution).expression).toBe('1 + 2');
  });

  it('parses empty program', () => {
    const prog = parse('');
    expect(prog.type).toBe('Program');
    expect(prog.body.commands).toHaveLength(0);
  });
});

// ─── Assignments ────────────────────────────────────────────────

describe('BashParser — Assignments', () => {
  it('parses a simple assignment', () => {
    const prog = parse('FOO=bar');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.assignments).toHaveLength(1);
    expect(cmd.assignments[0].name).toBe('FOO');
    expect((cmd.assignments[0].value as LiteralWord).value).toBe('bar');
  });

  it('parses an empty assignment', () => {
    const prog = parse('FOO=');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.assignments).toHaveLength(1);
    expect(cmd.assignments[0].name).toBe('FOO');
    expect(cmd.assignments[0].value).toBeNull();
  });

  it('parses assignment before command', () => {
    const prog = parse('FOO=bar echo hello');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.assignments).toHaveLength(1);
    expect(cmd.assignments[0].name).toBe('FOO');
    expect(cmd.words).toHaveLength(2);
    expect((cmd.words[0] as LiteralWord).value).toBe('echo');
  });

  it('parses multiple assignments', () => {
    const prog = parse('A=1 B=2 cmd');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.assignments).toHaveLength(2);
    expect(cmd.assignments[0].name).toBe('A');
    expect(cmd.assignments[1].name).toBe('B');
    expect(cmd.words).toHaveLength(1);
  });
});

// ─── Redirections ───────────────────────────────────────────────

describe('BashParser — Redirections', () => {
  it('parses output redirection >', () => {
    const prog = parse('echo hello > file.txt');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.redirections).toHaveLength(1);
    expect(cmd.redirections[0].op).toBe('>');
    expect((cmd.redirections[0].target as LiteralWord).value).toBe('file.txt');
  });

  it('parses append redirection >>', () => {
    const prog = parse('echo hello >> file.txt');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.redirections).toHaveLength(1);
    expect(cmd.redirections[0].op).toBe('>>');
  });

  it('parses input redirection <', () => {
    const prog = parse('cat < input.txt');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.redirections).toHaveLength(1);
    expect(cmd.redirections[0].op).toBe('<');
  });

  it('parses stderr redirection 2>', () => {
    const prog = parse('cmd 2> err.log');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.redirections).toHaveLength(1);
    expect(cmd.redirections[0].op).toBe('>');
    expect(cmd.redirections[0].fd).toBe(2);
  });

  it('parses stderr append 2>>', () => {
    const prog = parse('cmd 2>> err.log');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.redirections).toHaveLength(1);
    expect(cmd.redirections[0].op).toBe('>>');
    expect(cmd.redirections[0].fd).toBe(2);
  });

  it('parses here-string <<<', () => {
    const prog = parse('cat <<< hello');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.redirections).toHaveLength(1);
    expect(cmd.redirections[0].op).toBe('<<<');
  });

  it('parses multiple redirections', () => {
    const prog = parse('cmd < in.txt > out.txt 2> err.txt');
    const cmd = firstCommand(prog) as SimpleCommand;
    expect(cmd.redirections).toHaveLength(3);
    expect(cmd.redirections[0].op).toBe('<');
    expect(cmd.redirections[1].op).toBe('>');
    expect(cmd.redirections[2].op).toBe('>');
    expect(cmd.redirections[2].fd).toBe(2);
  });
});

// ─── Pipelines ──────────────────────────────────────────────────

describe('BashParser — Pipelines', () => {
  it('parses a simple pipeline', () => {
    const prog = parse('ls | grep foo');
    const pipeline = prog.body.commands[0].first;
    expect(pipeline.commands).toHaveLength(2);
    expect((pipeline.commands[0] as SimpleCommand).words[0]).toMatchObject({ type: 'LiteralWord', value: 'ls' });
    expect((pipeline.commands[1] as SimpleCommand).words[0]).toMatchObject({ type: 'LiteralWord', value: 'grep' });
  });

  it('parses a multi-stage pipeline', () => {
    const prog = parse('cat file | grep pattern | sort | uniq');
    const pipeline = prog.body.commands[0].first;
    expect(pipeline.commands).toHaveLength(4);
  });

  it('parses pipeline with newline after pipe', () => {
    const prog = parse('ls |\ngrep foo');
    const pipeline = prog.body.commands[0].first;
    expect(pipeline.commands).toHaveLength(2);
  });
});

// ─── And/Or Lists ───────────────────────────────────────────────

describe('BashParser — And/Or Lists', () => {
  it('parses && operator', () => {
    const prog = parse('cmd1 && cmd2');
    const andOr = prog.body.commands[0];
    expect(andOr.rest).toHaveLength(1);
    expect(andOr.rest[0].operator).toBe('&&');
  });

  it('parses || operator', () => {
    const prog = parse('cmd1 || cmd2');
    const andOr = prog.body.commands[0];
    expect(andOr.rest).toHaveLength(1);
    expect(andOr.rest[0].operator).toBe('||');
  });

  it('parses chained and/or', () => {
    const prog = parse('cmd1 && cmd2 || cmd3');
    const andOr = prog.body.commands[0];
    expect(andOr.rest).toHaveLength(2);
    expect(andOr.rest[0].operator).toBe('&&');
    expect(andOr.rest[1].operator).toBe('||');
  });
});

// ─── Command Lists (Sequences) ─────────────────────────────────

describe('BashParser — Command Lists', () => {
  it('parses semicolon-separated commands', () => {
    const prog = parse('cmd1; cmd2; cmd3');
    expect(prog.body.commands).toHaveLength(3);
  });

  it('parses newline-separated commands', () => {
    const prog = parse('cmd1\ncmd2\ncmd3');
    expect(prog.body.commands).toHaveLength(3);
  });

  it('parses mixed separators', () => {
    const prog = parse('cmd1; cmd2\ncmd3');
    expect(prog.body.commands).toHaveLength(3);
  });
});

// ─── If Clause ──────────────────────────────────────────────────

describe('BashParser — If Clause', () => {
  it('parses simple if/then/fi', () => {
    const prog = parse('if true; then echo yes; fi');
    const ifCmd = firstCommand(prog) as IfClause;
    expect(ifCmd.type).toBe('IfClause');
    expect(ifCmd.condition.commands).toHaveLength(1);
    expect(ifCmd.thenBody.commands).toHaveLength(1);
    expect(ifCmd.elifClauses).toHaveLength(0);
    expect(ifCmd.elseBody).toBeNull();
  });

  it('parses if/then/else/fi', () => {
    const prog = parse('if true; then echo yes; else echo no; fi');
    const ifCmd = firstCommand(prog) as IfClause;
    expect(ifCmd.thenBody.commands).toHaveLength(1);
    expect(ifCmd.elseBody).not.toBeNull();
    expect(ifCmd.elseBody!.commands).toHaveLength(1);
  });

  it('parses if/elif/else/fi', () => {
    const prog = parse('if cmd1; then echo a; elif cmd2; then echo b; else echo c; fi');
    const ifCmd = firstCommand(prog) as IfClause;
    expect(ifCmd.elifClauses).toHaveLength(1);
    expect(ifCmd.elseBody).not.toBeNull();
  });

  it('parses if with multiple elif', () => {
    const prog = parse('if c1; then e1; elif c2; then e2; elif c3; then e3; fi');
    const ifCmd = firstCommand(prog) as IfClause;
    expect(ifCmd.elifClauses).toHaveLength(2);
    expect(ifCmd.elseBody).toBeNull();
  });

  it('parses if with newlines', () => {
    const prog = parse('if true\nthen\n  echo yes\nfi');
    const ifCmd = firstCommand(prog) as IfClause;
    expect(ifCmd.type).toBe('IfClause');
    expect(ifCmd.thenBody.commands).toHaveLength(1);
  });
});

// ─── For Clause ─────────────────────────────────────────────────

describe('BashParser — For Clause', () => {
  it('parses for-in loop', () => {
    const prog = parse('for x in a b c; do echo $x; done');
    const forCmd = firstCommand(prog) as ForClause;
    expect(forCmd.type).toBe('ForClause');
    expect(forCmd.variable).toBe('x');
    expect(forCmd.words).toHaveLength(3);
    expect(forCmd.body.commands).toHaveLength(1);
  });

  it('parses for loop without word list (implicit $@)', () => {
    const prog = parse('for arg; do echo $arg; done');
    const forCmd = firstCommand(prog) as ForClause;
    expect(forCmd.variable).toBe('arg');
    expect(forCmd.words).toBeNull();
  });

  it('parses for loop with newlines', () => {
    const prog = parse('for i in 1 2 3\ndo\n  echo $i\ndone');
    const forCmd = firstCommand(prog) as ForClause;
    expect(forCmd.variable).toBe('i');
    expect(forCmd.words).toHaveLength(3);
  });
});

// ─── While Clause ───────────────────────────────────────────────

describe('BashParser — While Clause', () => {
  it('parses while loop', () => {
    const prog = parse('while true; do echo loop; done');
    const whileCmd = firstCommand(prog) as WhileClause;
    expect(whileCmd.type).toBe('WhileClause');
    expect(whileCmd.condition.commands).toHaveLength(1);
    expect(whileCmd.body.commands).toHaveLength(1);
  });

  it('parses while loop with newlines', () => {
    const prog = parse('while true\ndo\n  echo loop\ndone');
    const whileCmd = firstCommand(prog) as WhileClause;
    expect(whileCmd.type).toBe('WhileClause');
  });
});

// ─── Until Clause ───────────────────────────────────────────────

describe('BashParser — Until Clause', () => {
  it('parses until loop', () => {
    const prog = parse('until false; do echo loop; done');
    const untilCmd = firstCommand(prog) as UntilClause;
    expect(untilCmd.type).toBe('UntilClause');
    expect(untilCmd.condition.commands).toHaveLength(1);
    expect(untilCmd.body.commands).toHaveLength(1);
  });
});

// ─── Case Clause ────────────────────────────────────────────────

describe('BashParser — Case Clause', () => {
  it('parses simple case statement', () => {
    const prog = parse('case $x in\n  a) echo a;;\n  b) echo b;;\nesac');
    const caseCmd = firstCommand(prog) as CaseClause;
    expect(caseCmd.type).toBe('CaseClause');
    expect(caseCmd.items).toHaveLength(2);
    expect((caseCmd.items[0].patterns[0] as LiteralWord).value).toBe('a');
    expect((caseCmd.items[1].patterns[0] as LiteralWord).value).toBe('b');
  });

  it('parses case with multiple patterns per item', () => {
    const prog = parse('case $x in\n  a|b) echo ab;;\nesac');
    const caseCmd = firstCommand(prog) as CaseClause;
    expect(caseCmd.items).toHaveLength(1);
    expect(caseCmd.items[0].patterns).toHaveLength(2);
  });

  it('parses case with wildcard pattern', () => {
    const prog = parse('case $x in\n  *) echo default;;\nesac');
    const caseCmd = firstCommand(prog) as CaseClause;
    expect(caseCmd.items).toHaveLength(1);
    expect((caseCmd.items[0].patterns[0] as LiteralWord).value).toBe('*');
  });

  it('parses case with empty body item', () => {
    const prog = parse('case $x in\n  a) ;;\nesac');
    const caseCmd = firstCommand(prog) as CaseClause;
    expect(caseCmd.items).toHaveLength(1);
    expect(caseCmd.items[0].body).toBeNull();
  });
});

// ─── Function Definitions ───────────────────────────────────────

describe('BashParser — Function Definitions', () => {
  it('parses name() form', () => {
    const prog = parse('greet() { echo hello; }');
    const fn = firstCommand(prog) as FunctionDef;
    expect(fn.type).toBe('FunctionDef');
    expect(fn.name).toBe('greet');
    expect(fn.body.type).toBe('BraceGroup');
  });

  it('parses function keyword form', () => {
    const prog = parse('function greet { echo hello; }');
    const fn = firstCommand(prog) as FunctionDef;
    expect(fn.type).toBe('FunctionDef');
    expect(fn.name).toBe('greet');
  });

  it('parses function keyword with parens', () => {
    const prog = parse('function greet() { echo hello; }');
    const fn = firstCommand(prog) as FunctionDef;
    expect(fn.type).toBe('FunctionDef');
    expect(fn.name).toBe('greet');
  });
});

// ─── Brace Groups ───────────────────────────────────────────────

describe('BashParser — Brace Groups', () => {
  it('parses brace group', () => {
    const prog = parse('{ echo hello; }');
    const bg = firstCommand(prog) as BraceGroup;
    expect(bg.type).toBe('BraceGroup');
    expect(bg.body.commands).toHaveLength(1);
  });

  it('parses brace group with multiple commands', () => {
    const prog = parse('{ echo a; echo b; echo c; }');
    const bg = firstCommand(prog) as BraceGroup;
    expect(bg.body.commands).toHaveLength(3);
  });
});

// ─── Subshells ──────────────────────────────────────────────────

describe('BashParser — Subshells', () => {
  it('parses subshell', () => {
    const prog = parse('(echo hello)');
    const sub = firstCommand(prog) as Subshell;
    expect(sub.type).toBe('Subshell');
    expect(sub.body.commands).toHaveLength(1);
  });

  it('parses subshell with multiple commands', () => {
    const prog = parse('(echo a; echo b)');
    const sub = firstCommand(prog) as Subshell;
    expect(sub.body.commands).toHaveLength(2);
  });

  it('parses subshell with redirection', () => {
    const prog = parse('(echo hello) > out.txt');
    const sub = firstCommand(prog) as Subshell;
    expect(sub.type).toBe('Subshell');
    expect(sub.redirections).toHaveLength(1);
    expect(sub.redirections[0].op).toBe('>');
  });
});

// ─── Complex Scripts ────────────────────────────────────────────

describe('BashParser — Complex Scripts', () => {
  it('parses pipeline with redirection', () => {
    const prog = parse('ls -la | grep foo > results.txt');
    const pipeline = prog.body.commands[0].first;
    expect(pipeline.commands).toHaveLength(2);
    const grepCmd = pipeline.commands[1] as SimpleCommand;
    expect(grepCmd.redirections).toHaveLength(1);
  });

  it('parses if with pipeline condition', () => {
    const prog = parse('if echo test | grep test; then echo found; fi');
    const ifCmd = firstCommand(prog) as IfClause;
    expect(ifCmd.type).toBe('IfClause');
    // condition is a command list containing one and/or list with a pipeline
    expect(ifCmd.condition.commands[0].first.commands).toHaveLength(2);
  });

  it('parses nested if statements', () => {
    const prog = parse('if true; then if false; then echo inner; fi; fi');
    const outerIf = firstCommand(prog) as IfClause;
    expect(outerIf.type).toBe('IfClause');
    const innerIf = outerIf.thenBody.commands[0].first.commands[0] as IfClause;
    expect(innerIf.type).toBe('IfClause');
  });

  it('parses for loop inside function', () => {
    const prog = parse('listall() { for f in a b c; do echo $f; done; }');
    const fn = firstCommand(prog) as FunctionDef;
    expect(fn.type).toBe('FunctionDef');
    const braceBody = fn.body as BraceGroup;
    const forCmd = braceBody.body.commands[0].first.commands[0] as ForClause;
    expect(forCmd.type).toBe('ForClause');
    expect(forCmd.variable).toBe('f');
  });

  it('parses multi-line script', () => {
    const script = `
FOO=hello
echo $FOO
if true; then
  echo yes
fi
for i in 1 2 3; do
  echo $i
done
`;
    const prog = parse(script);
    expect(prog.body.commands.length).toBeGreaterThanOrEqual(4);
  });

  it('parses command with and/or and pipeline combined', () => {
    const prog = parse('cmd1 | cmd2 && cmd3 || cmd4');
    const andOr = prog.body.commands[0];
    // First pipeline: cmd1 | cmd2
    expect(andOr.first.commands).toHaveLength(2);
    // Rest: && cmd3, || cmd4
    expect(andOr.rest).toHaveLength(2);
    expect(andOr.rest[0].operator).toBe('&&');
    expect(andOr.rest[1].operator).toBe('||');
  });
});

// ─── Error Handling ─────────────────────────────────────────────

describe('BashParser — Error Handling', () => {
  it('throws on unexpected token after valid command', () => {
    expect(() => parse('echo hello )')).toThrow();
  });

  it('throws on missing then in if', () => {
    expect(() => parse('if true; echo yes; fi')).toThrow(/Expected 'then'/);
  });

  it('throws on missing fi in if', () => {
    expect(() => parse('if true; then echo yes')).toThrow();
  });

  it('throws on missing do in for', () => {
    expect(() => parse('for x in a b; echo $x; done')).toThrow(/Expected 'do'/);
  });

  it('throws on missing done in for', () => {
    expect(() => parse('for x in a b; do echo $x')).toThrow();
  });

  it('throws on missing done in while', () => {
    expect(() => parse('while true; do echo loop')).toThrow();
  });

  it('throws on missing esac in case', () => {
    expect(() => parse('case $x in a) echo a;;')).toThrow();
  });

  it('throws on missing closing brace', () => {
    expect(() => parse('{ echo hello')).toThrow();
  });

  it('throws on missing closing paren in subshell', () => {
    expect(() => parse('(echo hello')).toThrow();
  });
});
