/**
 * ASTNode — Abstract Syntax Tree node definitions for the bash parser.
 *
 * Mirrors the grammar rules from bash_grammar.py (Rules 0–82).
 * Each node carries enough information for the interpreter to execute
 * the script, including source positions for error reporting.
 *
 * Node types follow the bash grammar hierarchy:
 *   Program → CommandList → Pipeline → Command → Word
 */

import type { SourcePosition } from '@/bash/lexer/Token';

// ─── Base ────────────────────────────────────────────────────────

export interface ASTBase {
  type: string;
  position?: SourcePosition;
}

// ─── Program (Root) ──────────────────────────────────────────────

export interface Program extends ASTBase {
  type: 'Program';
  body: CommandList;
}

// ─── Command List (Sequence of And/Or lists) ─────────────────────

export interface CommandList extends ASTBase {
  type: 'CommandList';
  commands: AndOrList[];
}

// ─── And/Or List (&&, ||) ────────────────────────────────────────

export interface AndOrList extends ASTBase {
  type: 'AndOrList';
  first: Pipeline;
  rest: AndOrPart[];
}

export interface AndOrPart {
  operator: '&&' | '||';
  pipeline: Pipeline;
}

// ─── Pipeline (cmd1 | cmd2 | cmd3) ──────────────────────────────

export interface Pipeline extends ASTBase {
  type: 'Pipeline';
  commands: Command[];
  negated?: boolean;  // ! pipeline
}

// ─── Command (tagged union) ─────────────────────────────────────

export type Command =
  | SimpleCommand
  | IfClause
  | ForClause
  | WhileClause
  | UntilClause
  | CaseClause
  | FunctionDef
  | BraceGroup
  | Subshell;

// ─── Simple Command ─────────────────────────────────────────────

export interface SimpleCommand extends ASTBase {
  type: 'SimpleCommand';
  assignments: Assignment[];
  words: Word[];
  redirections: Redirection[];
}

// ─── Compound Commands ──────────────────────────────────────────

export interface IfClause extends ASTBase {
  type: 'IfClause';
  condition: CommandList;
  thenBody: CommandList;
  elifClauses: ElifClause[];
  elseBody: CommandList | null;
  redirections: Redirection[];
}

export interface ElifClause {
  condition: CommandList;
  body: CommandList;
}

export interface ForClause extends ASTBase {
  type: 'ForClause';
  variable: string;
  words: Word[] | null;  // null → iterate over "$@"
  body: CommandList;
  redirections: Redirection[];
}

export interface WhileClause extends ASTBase {
  type: 'WhileClause';
  condition: CommandList;
  body: CommandList;
  redirections: Redirection[];
}

export interface UntilClause extends ASTBase {
  type: 'UntilClause';
  condition: CommandList;
  body: CommandList;
  redirections: Redirection[];
}

export interface CaseClause extends ASTBase {
  type: 'CaseClause';
  word: Word;
  items: CaseItem[];
  redirections: Redirection[];
}

export interface CaseItem {
  patterns: Word[];
  body: CommandList | null;
}

export interface FunctionDef extends ASTBase {
  type: 'FunctionDef';
  name: string;
  body: Command;      // typically a BraceGroup
  redirections: Redirection[];
}

export interface BraceGroup extends ASTBase {
  type: 'BraceGroup';
  body: CommandList;
  redirections: Redirection[];
}

export interface Subshell extends ASTBase {
  type: 'Subshell';
  body: CommandList;
  redirections: Redirection[];
}

// ─── Word (the leaf of the AST) ─────────────────────────────────

export type Word =
  | LiteralWord
  | SingleQuotedWord
  | DoubleQuotedWord
  | VariableRef
  | CommandSubstitution
  | ArithmeticSubstitution
  | CompoundWord;

export interface LiteralWord extends ASTBase {
  type: 'LiteralWord';
  value: string;
}

export interface SingleQuotedWord extends ASTBase {
  type: 'SingleQuotedWord';
  value: string;   // content without quotes
}

export interface DoubleQuotedWord extends ASTBase {
  type: 'DoubleQuotedWord';
  parts: WordPart[];  // mix of literal text and variable/command refs
}

/** Part of a double-quoted string — either literal text or an expansion. */
export type WordPart =
  | { type: 'text'; value: string }
  | { type: 'variable'; name: string; braced: boolean; modifier?: string }
  | { type: 'special'; name: string }
  | { type: 'command'; command: string }
  | { type: 'arithmetic'; expression: string };

export interface VariableRef extends ASTBase {
  type: 'VariableRef';
  name: string;
  braced: boolean;
  modifier?: string;   // e.g. ":-default", ":+alt", ":=default", "#pattern"
}

export interface CommandSubstitution extends ASTBase {
  type: 'CommandSubstitution';
  command: string;      // raw command string (will be parsed recursively)
  backtick: boolean;    // true if `cmd` form
}

export interface ArithmeticSubstitution extends ASTBase {
  type: 'ArithmeticSubstitution';
  expression: string;   // raw expression (evaluated by interpreter)
}

/** A word composed of adjacent parts: e.g. "hello"$name'world' */
export interface CompoundWord extends ASTBase {
  type: 'CompoundWord';
  parts: Word[];
}

// ─── Assignment ─────────────────────────────────────────────────

export interface Assignment extends ASTBase {
  type: 'Assignment';
  name: string;
  value: Word | null;   // null if VAR= (empty)
}

// ─── Redirection ────────────────────────────────────────────────

export type RedirectionOp = '>' | '>>' | '<' | '<<' | '<<<' | '<&' | '>&';

export interface Redirection extends ASTBase {
  type: 'Redirection';
  op: RedirectionOp;
  fd?: number;          // file descriptor (default: 1 for >, 0 for <)
  target: Word;
}

// ─── Factory Functions ──────────────────────────────────────────

export function makeProgram(body: CommandList, pos?: SourcePosition): Program {
  return { type: 'Program', body, position: pos };
}

export function makeCommandList(commands: AndOrList[], pos?: SourcePosition): CommandList {
  return { type: 'CommandList', commands, position: pos };
}

export function makeAndOrList(first: Pipeline, rest: AndOrPart[] = [], pos?: SourcePosition): AndOrList {
  return { type: 'AndOrList', first, rest, position: pos };
}

export function makePipeline(commands: Command[], pos?: SourcePosition): Pipeline {
  return { type: 'Pipeline', commands, position: pos };
}

export function makeSimpleCommand(
  words: Word[],
  assignments: Assignment[] = [],
  redirections: Redirection[] = [],
  pos?: SourcePosition,
): SimpleCommand {
  return { type: 'SimpleCommand', assignments, words, redirections, position: pos };
}

export function makeLiteralWord(value: string, pos?: SourcePosition): LiteralWord {
  return { type: 'LiteralWord', value, position: pos };
}

export function makeAssignment(name: string, value: Word | null, pos?: SourcePosition): Assignment {
  return { type: 'Assignment', name, value, position: pos };
}

export function makeRedirection(op: RedirectionOp, target: Word, fd?: number, pos?: SourcePosition): Redirection {
  return { type: 'Redirection', op, fd, target, position: pos };
}
