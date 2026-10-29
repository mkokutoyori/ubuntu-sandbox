/**
 * Token and AST definitions for the sed script language.
 *
 * Pipeline: SedLexer (string → SedToken[]) → SedParser (tokens → SedProgram)
 * → SedEngine (execute against the input). The lexer is context-sensitive
 * after a command letter (sed's `s`/`y`/`a` payloads are delimiter-driven),
 * so it captures raw payload strings; the parser compiles regexes and links
 * blocks/labels; the engine runs the flat instruction list with a program
 * counter so branches (`b`/`t`/`T`) work.
 */

export class SedSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number | null = null,
    readonly bare = false,
    readonly anchor: number | null = null,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'SedSyntaxError';
  }
}

// ── Raw (pre-compile) address produced by the lexer ─────────────────

export type RawAddress =
  | { kind: 'line'; line: number }
  | { kind: 'last' }
  | { kind: 'step'; first: number; step: number }
  | { kind: 'regex'; src: string; flags: string }
  | { kind: 'plus'; n: number }
  | { kind: 'tilde'; n: number };

// ── Raw command payloads ────────────────────────────────────────────

export interface RawSub {
  delim: string;
  pattern: string;
  replacement: string;
  flags: string;
  writeFile?: string;
}

export interface RawY {
  from: string;
  to: string;
}

// ── Token stream ────────────────────────────────────────────────────

export type SedTokenBody =
  | { type: 'addr'; addr: RawAddress }
  | { type: 'comma' }
  | { type: 'bang' }
  | { type: 'lbrace' }
  | { type: 'rbrace' }
  | { type: 'sep'; char: string }
  | { type: 'sub'; sub: RawSub }
  | { type: 'y'; y: RawY }
  | { type: 'text'; name: string; text: string; textless?: boolean }
  | { type: 'quit'; name: string; code: number }
  | { type: 'op'; name: string; width?: number }
  | { type: 'eof' };

export type SedToken = SedTokenBody & { readonly pos: number; readonly start: number };

// ── Compiled AST ────────────────────────────────────────────────────

export interface Address {
  kind: 'line' | 'last' | 'step' | 'regex' | 'plus' | 'tilde';
  line?: number;
  first?: number;
  step?: number;
  re?: RegExp;
  reuseLast?: boolean;   // empty // regex → reuse last regex applied at runtime
  n?: number;            // plus / tilde
}

export interface SubCommand {
  re: RegExp;
  reuseLast: boolean;
  replacement: string;
  global: boolean;
  nth: number;
  print: boolean;
  writeFile?: string;
}

export interface Instruction {
  addr1: Address | null;
  addr2: Address | null;
  negate: boolean;
  name: string;          // command letter, or '{' '}' ':'
  sub?: SubCommand;
  y?: { from: string; to: string };
  text?: string;         // a/i/c/r/w/b/t/T/: payload
  textless?: boolean;
  exitCode?: number;     // q/Q
  width?: number;        // l
  blockEnd?: number;     // for '{': index of the matching '}'
}

export interface SedProgram {
  instructions: Instruction[];
  labels: Map<string, number>;
}
