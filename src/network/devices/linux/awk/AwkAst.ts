export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'regex'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'field'; index: Expr }
  | { kind: 'index'; name: string; subscripts: Expr[] }
  | { kind: 'assign'; op: string; target: LValue; value: Expr }
  | { kind: 'ternary'; cond: Expr; then: Expr; else: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'logical'; op: 'and' | 'or'; left: Expr; right: Expr }
  | { kind: 'match'; negated: boolean; left: Expr; right: Expr }
  | { kind: 'in'; subscripts: Expr[]; array: string }
  | { kind: 'concat'; parts: Expr[] }
  | { kind: 'unary'; op: string; operand: Expr }
  | { kind: 'preIncr'; op: string; target: LValue }
  | { kind: 'postIncr'; op: string; target: LValue }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'builtin'; name: string; args: Expr[] }
  | { kind: 'grouping'; expr: Expr }
  | { kind: 'getline'; into: LValue | null; source: { type: 'file' | 'cmd'; expr: Expr } | null };

export type LValue =
  | { kind: 'var'; name: string }
  | { kind: 'field'; index: Expr }
  | { kind: 'index'; name: string; subscripts: Expr[] };

export type Stmt =
  | { kind: 'print'; args: Expr[]; output: Redirect | null }
  | { kind: 'printf'; args: Expr[]; output: Redirect | null }
  | { kind: 'expr'; expr: Expr }
  | { kind: 'if'; cond: Expr; then: Stmt; else: Stmt | null }
  | { kind: 'while'; cond: Expr; body: Stmt }
  | { kind: 'doWhile'; body: Stmt; cond: Expr }
  | { kind: 'for'; init: Stmt | null; cond: Expr | null; update: Stmt | null; body: Stmt }
  | { kind: 'forIn'; var: string; array: string; body: Stmt }
  | { kind: 'block'; body: Stmt[] }
  | { kind: 'next' }
  | { kind: 'nextfile' }
  | { kind: 'exit'; code: Expr | null }
  | { kind: 'return'; value: Expr | null }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'delete'; name: string; subscripts: Expr[] | null }
  | { kind: 'getline'; expr: Expr };

export interface Redirect {
  type: 'truncate' | 'append' | 'pipe';
  target: Expr;
}

export type Pattern =
  | { type: 'begin' }
  | { type: 'end' }
  | { type: 'always' }
  | { type: 'expr'; expr: Expr }
  | { type: 'range'; start: Expr; end: Expr };

export interface Rule {
  pattern: Pattern;
  action: Stmt[] | null;
}

export interface FunctionDef {
  name: string;
  params: string[];
  body: Stmt[];
}

export interface Program {
  rules: Rule[];
  functions: Map<string, FunctionDef>;
}
