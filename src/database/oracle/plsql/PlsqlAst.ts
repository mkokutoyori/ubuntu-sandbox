export interface TypeRef {
  name: string;
  args: number[];
  anchored?: { target: string; kind: 'TYPE' | 'ROWTYPE' };
}

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ident'; name: string }
  | { kind: 'attr'; target: string; attribute: string }
  | { kind: 'member'; object: Expr; name: string }
  | { kind: 'index'; collection: Expr; index: Expr }
  | { kind: 'call'; name: string; args: CallArg[] }
  | { kind: 'unary'; op: string; operand: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'isnull'; operand: Expr; negated: boolean }
  | { kind: 'between'; operand: Expr; low: Expr; high: Expr; negated: boolean }
  | { kind: 'in'; operand: Expr; list: Expr[]; negated: boolean }
  | { kind: 'like'; operand: Expr; pattern: Expr; negated: boolean }
  | { kind: 'case'; selector: Expr | null; whens: { when: Expr; then: Expr }[]; elseExpr: Expr | null };

export interface CallArg {
  name: string | null;
  value: Expr;
}

export interface VarDecl {
  kind: 'var';
  name: string;
  type: TypeRef;
  constant: boolean;
  notNull: boolean;
  init: Expr | null;
}

export interface CursorDecl {
  kind: 'cursor';
  name: string;
  params: { name: string; type: TypeRef }[];
  query: string;
}

export interface ExceptionDecl {
  kind: 'exception';
  name: string;
}

export interface PragmaExceptionInit {
  kind: 'pragma_exception_init';
  exceptionName: string;
  code: number;
}

/**
 * Compile-time directive with no runtime semantics in the simulator
 * (AUTONOMOUS_TRANSACTION, SERIALLY_REUSABLE, UDF, INLINE, …).
 * EXCEPTION_INIT is the exception: it binds an error code and has its
 * own node above.
 */
export interface PragmaDecl {
  kind: 'pragma';
  name: string;
}

export interface TypeDecl {
  kind: 'type';
  name: string;
  def:
    | { form: 'record'; fields: { name: string; type: TypeRef; init: Expr | null }[] }
    | { form: 'table'; element: TypeRef; indexed: boolean }
    | { form: 'varray'; element: TypeRef; limit: number };
}

export interface ParamDecl {
  name: string;
  mode: 'IN' | 'OUT' | 'IN OUT';
  type: TypeRef;
  init: Expr | null;
}

export interface SubprogramDecl {
  kind: 'subprogram';
  isFunction: boolean;
  name: string;
  params: ParamDecl[];
  returnType: TypeRef | null;
  block: Block | null;
}

export type Declaration =
  | VarDecl | CursorDecl | ExceptionDecl | PragmaExceptionInit | PragmaDecl | TypeDecl | SubprogramDecl;

export interface Block {
  kind: 'block';
  declarations: Declaration[];
  body: Stmt[];
  handlers: ExceptionHandler[];
}

export interface ExceptionHandler {
  names: string[];
  others: boolean;
  body: Stmt[];
}

export type AssignTarget =
  | { kind: 'ident'; name: string }
  | { kind: 'member'; object: AssignTarget; name: string }
  | { kind: 'index'; base: AssignTarget; index: Expr };

export type Stmt =
  | { kind: 'null' }
  | Block
  | { kind: 'assign'; target: AssignTarget; value: Expr }
  | { kind: 'if'; branches: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null }
  | { kind: 'case'; selector: Expr | null; whens: { match: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null }
  | { kind: 'loop'; label: string | null; body: Stmt[] }
  | { kind: 'while'; label: string | null; cond: Expr; body: Stmt[] }
  | { kind: 'forNum'; label: string | null; varName: string; reverse: boolean; low: Expr; high: Expr; body: Stmt[] }
  | { kind: 'forCursor'; label: string | null; varName: string; cursorName: string | null; args: CallArg[]; query: string | null; body: Stmt[] }
  | { kind: 'exit'; label: string | null; when: Expr | null }
  | { kind: 'continue'; label: string | null; when: Expr | null }
  | { kind: 'goto'; label: string }
  | { kind: 'labelMark'; label: string }
  | { kind: 'return'; value: Expr | null }
  | { kind: 'raise'; name: string | null }
  | { kind: 'open'; cursorName: string; args: CallArg[] }
  | { kind: 'openFor'; varName: string; query: string }
  | { kind: 'fetch'; cursorName: string; intoTargets: AssignTarget[]; bulk: boolean; limit: Expr | null }
  | { kind: 'close'; cursorName: string }
  | { kind: 'selectInto'; sql: string; intoTargets: AssignTarget[]; bulk: boolean }
  | { kind: 'sql'; sql: string }
  | { kind: 'executeImmediate'; sqlExpr: Expr; intoTargets: AssignTarget[]; bulkInto: boolean; using: { mode: string; expr: Expr }[] }
  | { kind: 'call'; name: string; args: CallArg[]; rawArgs: string }
  | { kind: 'pipeRow'; value: Expr };
