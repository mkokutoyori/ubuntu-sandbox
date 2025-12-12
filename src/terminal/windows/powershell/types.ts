/**
 * PowerShell AST Types
 */

export type PSASTNode =
  | NumberLiteral
  | StringLiteral
  | VariableRef
  | ArrayLiteral
  | HashTableLiteral
  | BinaryOp
  | UnaryOp
  | Assignment
  | Pipeline
  | CommandExpr
  | MemberAccess
  | IndexAccess
  | IfStatement
  | WhileStatement
  | ForStatement
  | ForEachStatement
  | DoWhileStatement
  | DoUntilStatement
  | SwitchStatement
  | TryCatchStatement
  | FunctionDef
  | Return
  | Break
  | Continue
  | Throw
  | ScriptBlock
  | SubExpression
  | ParenExpr
  | ExprStatement;

export interface NumberLiteral {
  type: 'NumberLiteral';
  value: number;
  isFloat: boolean;
}

export interface StringLiteral {
  type: 'StringLiteral';
  value: string;
  expandable: boolean;
}

export interface VariableRef {
  type: 'VariableRef';
  name: string;
  scope?: 'Global' | 'Local' | 'Script' | 'Private' | 'Env';
}

export interface ArrayLiteral {
  type: 'ArrayLiteral';
  elements: PSASTNode[];
}

export interface HashTableLiteral {
  type: 'HashTableLiteral';
  entries: { key: PSASTNode; value: PSASTNode }[];
}

export interface BinaryOp {
  type: 'BinaryOp';
  operator: string;
  left: PSASTNode;
  right: PSASTNode;
}

export interface UnaryOp {
  type: 'UnaryOp';
  operator: string;
  operand: PSASTNode;
}

export interface Assignment {
  type: 'Assignment';
  target: PSASTNode;
  operator: string;
  value: PSASTNode;
}

export interface Pipeline {
  type: 'Pipeline';
  commands: CommandExpr[];
}

export interface CommandExpr {
  type: 'CommandExpr';
  command: string;
  arguments: CommandArgument[];
}

export interface CommandArgument {
  type: 'argument' | 'parameter';
  name?: string;
  value: PSASTNode | null;
}

export interface MemberAccess {
  type: 'MemberAccess';
  object: PSASTNode;
  member: string;
  isStatic: boolean;
}

export interface IndexAccess {
  type: 'IndexAccess';
  object: PSASTNode;
  index: PSASTNode;
}

export interface IfStatement {
  type: 'IfStatement';
  condition: PSASTNode;
  thenBlock: PSASTNode[];
  elseIfBlocks: { condition: PSASTNode; block: PSASTNode[] }[];
  elseBlock: PSASTNode[];
}

export interface WhileStatement {
  type: 'WhileStatement';
  condition: PSASTNode;
  body: PSASTNode[];
}

export interface ForStatement {
  type: 'ForStatement';
  init: PSASTNode | null;
  condition: PSASTNode | null;
  update: PSASTNode | null;
  body: PSASTNode[];
}

export interface ForEachStatement {
  type: 'ForEachStatement';
  variable: string;
  collection: PSASTNode;
  body: PSASTNode[];
}

export interface DoWhileStatement {
  type: 'DoWhileStatement';
  body: PSASTNode[];
  condition: PSASTNode;
}

export interface DoUntilStatement {
  type: 'DoUntilStatement';
  body: PSASTNode[];
  condition: PSASTNode;
}

export interface SwitchStatement {
  type: 'SwitchStatement';
  expression: PSASTNode;
  cases: { condition: PSASTNode; block: PSASTNode[] }[];
  defaultBlock: PSASTNode[];
}

export interface TryCatchStatement {
  type: 'TryCatchStatement';
  tryBlock: PSASTNode[];
  catchBlocks: { exceptionType?: string; variable?: string; block: PSASTNode[] }[];
  finallyBlock: PSASTNode[];
}

export interface FunctionDef {
  type: 'FunctionDef';
  name: string;
  params: FunctionParam[];
  body: PSASTNode[];
}

export interface FunctionParam {
  name: string;
  type?: string;
  defaultValue?: PSASTNode;
  mandatory?: boolean;
}

export interface Return {
  type: 'Return';
  value: PSASTNode | null;
}

export interface Break {
  type: 'Break';
  label?: string;
}

export interface Continue {
  type: 'Continue';
  label?: string;
}

export interface Throw {
  type: 'Throw';
  expression: PSASTNode | null;
}

export interface ScriptBlock {
  type: 'ScriptBlock';
  params: FunctionParam[];
  body: PSASTNode[];
}

export interface SubExpression {
  type: 'SubExpression';
  expression: PSASTNode;
}

export interface ParenExpr {
  type: 'ParenExpr';
  expression: PSASTNode;
}

export interface ExprStatement {
  type: 'ExprStatement';
  expression: PSASTNode;
}
