/**
 * PSASTNode — Abstract Syntax Tree node definitions for PowerShell 5.1.
 *
 * Grammar hierarchy:
 *   Program → StatementList → Statement → Pipeline → Command → Expression
 *
 * PowerShell specifics vs bash:
 *   - Expressions are first-class (assignable, pipeable)
 *   - Script blocks { } are values (closures / lambdas)
 *   - Type literals [Type] for casting and parameter decoration
 *   - param() blocks inside functions / script blocks
 *   - try/catch/finally, throw, trap
 *   - switch statement with -regex, -wildcard, -exact flags
 *   - foreach ($x in $collection) — not bash-style `for x in list`
 *   - class / enum definitions (PS5+)
 */

import type { SourcePosition } from '@/powershell/lexer/PSToken';

// ─── Base ─────────────────────────────────────────────────────────────────────

export interface ASTBase {
  type: string;
  position?: SourcePosition;
}

// ─── Program (Root) ───────────────────────────────────────────────────────────

export interface PSProgram extends ASTBase {
  type: 'Program';
  body: PSStatementList;
}

// ─── Statement List ───────────────────────────────────────────────────────────

export interface PSStatementList extends ASTBase {
  type: 'StatementList';
  statements: PSStatement[];
}

// ─── Statement (tagged union) ─────────────────────────────────────────────────

export type PSStatement =
  | PSPipelineStatement
  | PSAssignmentStatement
  | PSIfStatement
  | PSWhileStatement
  | PSDoWhileStatement
  | PSDoUntilStatement
  | PSForStatement
  | PSForeachStatement
  | PSSwitchStatement
  | PSTryStatement
  | PSFunctionDefinition
  | PSClassDefinition
  | PSEnumDefinition
  | PSReturnStatement
  | PSBreakStatement
  | PSContinueStatement
  | PSThrowStatement
  | PSTrapStatement
  | PSUsingStatement;

// ─── Pipeline Statement ───────────────────────────────────────────────────────

export interface PSPipelineStatement extends ASTBase {
  type: 'PipelineStatement';
  pipeline: PSPipeline;
  redirections: PSRedirection[];
}

/** A pipeline of one or more commands joined by | */
export interface PSPipeline extends ASTBase {
  type: 'Pipeline';
  commands: PSCommand[];
}

/** A single command within a pipeline */
export interface PSCommand extends ASTBase {
  type: 'Command';
  /** Command name/expression (cmdlet name, variable holding a scriptblock, & call) */
  name: PSExpression;
  /** Named parameters: -Name value, -Switch */
  parameters: PSCommandParameter[];
  /** Positional arguments (expressions not preceded by -ParamName) */
  arguments: PSExpression[];
}

export interface PSCommandParameter extends ASTBase {
  type: 'CommandParameter';
  name: string;           // lowercase parameter name (without -)
  value: PSExpression | null;  // null for switch parameters
}

// ─── Assignment Statement ─────────────────────────────────────────────────────

export interface PSAssignmentStatement extends ASTBase {
  type: 'AssignmentStatement';
  target: PSVariableExpression | PSIndexExpression | PSMemberExpression;
  operator: '=' | '+=' | '-=' | '*=' | '/=' | '%=';
  value: PSExpression;
}

// ─── if / elseif / else ───────────────────────────────────────────────────────

export interface PSIfStatement extends ASTBase {
  type: 'IfStatement';
  condition: PSExpression;
  thenBody: PSScriptBlock;
  elseifClauses: PSElseifClause[];
  elseBody: PSScriptBlock | null;
}

export interface PSElseifClause {
  condition: PSExpression;
  body: PSScriptBlock;
}

// ─── while ────────────────────────────────────────────────────────────────────

export interface PSWhileStatement extends ASTBase {
  type: 'WhileStatement';
  condition: PSExpression;
  body: PSScriptBlock;
}

// ─── do {} while () / do {} until () ─────────────────────────────────────────

export interface PSDoWhileStatement extends ASTBase {
  type: 'DoWhileStatement';
  body: PSScriptBlock;
  condition: PSExpression;
}

export interface PSDoUntilStatement extends ASTBase {
  type: 'DoUntilStatement';
  body: PSScriptBlock;
  condition: PSExpression;
}

// ─── for (init; cond; iter) ───────────────────────────────────────────────────

export interface PSForStatement extends ASTBase {
  type: 'ForStatement';
  init: PSStatement | null;
  condition: PSExpression | null;
  iterator: PSStatement | null;
  body: PSScriptBlock;
}

// ─── foreach ($item in $collection) ─────────────────────────────────────────

export interface PSForeachStatement extends ASTBase {
  type: 'ForeachStatement';
  flags: string[];         // -parallel, -throttleLimit N
  variable: PSVariableExpression;
  collection: PSExpression;
  body: PSScriptBlock;
}

// ─── switch ───────────────────────────────────────────────────────────────────

export interface PSSwitchStatement extends ASTBase {
  type: 'SwitchStatement';
  flags: string[];         // exact, regex, wildcard, caseSensitive, file
  subject: PSExpression;
  clauses: PSSwitchClause[];
  defaultBody: PSScriptBlock | null;
}

export interface PSSwitchClause {
  pattern: PSExpression;
  body: PSScriptBlock;
}

// ─── try / catch / finally ────────────────────────────────────────────────────

export interface PSTryStatement extends ASTBase {
  type: 'TryStatement';
  tryBody: PSScriptBlock;
  catchClauses: PSCatchClause[];
  finallyBody: PSScriptBlock | null;
}

export interface PSCatchClause {
  types: string[];          // exception type names (empty = catch all)
  body: PSScriptBlock;
}

// ─── function / filter ────────────────────────────────────────────────────────

export interface PSFunctionDefinition extends ASTBase {
  type: 'FunctionDefinition';
  kind: 'function' | 'filter' | 'workflow' | 'configuration';
  name: string;
  body: PSScriptBlock;
}

// ─── class ────────────────────────────────────────────────────────────────────

export interface PSClassDefinition extends ASTBase {
  type: 'ClassDefinition';
  name: string;
  baseClass: string | null;
  interfaces: string[];
  members: PSClassMember[];
}

export type PSClassMember = PSPropertyDeclaration | PSMethodDefinition;

export interface PSPropertyDeclaration extends ASTBase {
  type: 'PropertyDeclaration';
  modifiers: string[];   // hidden, static
  propertyType: string | null;
  name: string;
  initializer: PSExpression | null;
}

export interface PSMethodDefinition extends ASTBase {
  type: 'MethodDefinition';
  modifiers: string[];
  returnType: string | null;
  name: string;
  parameters: PSParamDeclaration[];
  body: PSStatementList;
}

// ─── enum ─────────────────────────────────────────────────────────────────────

export interface PSEnumDefinition extends ASTBase {
  type: 'EnumDefinition';
  name: string;
  baseType: string | null;
  members: PSEnumMember[];
}

export interface PSEnumMember {
  name: string;
  value: PSExpression | null;
}

// ─── Control flow statements ─────────────────────────────────────────────────

export interface PSReturnStatement extends ASTBase {
  type: 'ReturnStatement';
  value: PSExpression | null;
}

export interface PSBreakStatement extends ASTBase {
  type: 'BreakStatement';
  label: string | null;
}

export interface PSContinueStatement extends ASTBase {
  type: 'ContinueStatement';
  label: string | null;
}

export interface PSThrowStatement extends ASTBase {
  type: 'ThrowStatement';
  value: PSExpression | null;
}

export interface PSTrapStatement extends ASTBase {
  type: 'TrapStatement';
  exceptionType: string | null;
  body: PSScriptBlock;
}

export interface PSUsingStatement extends ASTBase {
  type: 'UsingStatement';
  kind: 'module' | 'namespace' | 'assembly';
  name: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Expressions
// ═══════════════════════════════════════════════════════════════════════════════

export type PSExpression =
  | PSLiteralExpression
  | PSVariableExpression
  | PSSubExpressionExpression
  | PSArrayExpression
  | PSHashtableExpression
  | PSScriptBlock
  | PSTypeLiteral
  | PSUnaryExpression
  | PSBinaryExpression
  | PSRangeExpression
  | PSMemberExpression
  | PSStaticMemberExpression
  | PSIndexExpression
  | PSInvocationExpression
  | PSCastExpression
  | PSFormatExpression
  | PSSplatExpression
  | PSCommandExpression    // bareword command used as expression (pipeline head)
  | PSPipelineExpression;  // pipeline used as expression (e.g. $r = cmd1 | cmd2)

/** A pipeline used in expression context — e.g. `$r = 1,2,3 | Where-Object { ... }` */
export interface PSPipelineExpression extends ASTBase {
  type: 'PipelineExpression';
  pipeline: PSPipeline;
}

// ─── Literal ──────────────────────────────────────────────────────────────────

export type PSLiteralValue = string | number | boolean | null;

export interface PSLiteralExpression extends ASTBase {
  type: 'LiteralExpression';
  value: PSLiteralValue;
  raw: string;        // original text (for numbers with suffixes, strings with quotes)
  kind: 'string' | 'expandable' | 'number' | 'boolean' | 'null' | 'heredoc';
}

// ─── Variable ────────────────────────────────────────────────────────────────

export interface PSVariableExpression extends ASTBase {
  type: 'VariableExpression';
  name: string;         // includes scope qualifier if present (e.g. "env:PATH")
  scope: string | null; // "env", "script", "global", "local" or null
  varName: string;      // just the variable part (without "scope:")
}

// ─── Subexpression $(...) ─────────────────────────────────────────────────────

export interface PSSubExpressionExpression extends ASTBase {
  type: 'SubExpression';
  body: PSStatementList;
}

// ─── Array expression @(...) ──────────────────────────────────────────────────

export interface PSArrayExpression extends ASTBase {
  type: 'ArrayExpression';
  elements: PSStatement[];    // statements whose pipeline output forms array elements
}

// ─── Hashtable literal @{k=v; ...} ───────────────────────────────────────────

export interface PSHashtableExpression extends ASTBase {
  type: 'HashtableExpression';
  pairs: PSHashtablePair[];
}

export interface PSHashtablePair {
  key: PSExpression;
  value: PSExpression;
}

// ─── Script block { ... } ────────────────────────────────────────────────────

export interface PSScriptBlock extends ASTBase {
  type: 'ScriptBlock';
  paramBlock: PSParamBlock | null;
  beginBlock: PSStatementList | null;
  processBlock: PSStatementList | null;
  endBlock: PSStatementList | null;
  /** If no begin/process/end, the body goes here */
  body: PSStatementList | null;
}

// ─── param() block ────────────────────────────────────────────────────────────

export interface PSParamBlock extends ASTBase {
  type: 'ParamBlock';
  attributes: PSAttribute[];
  parameters: PSParamDeclaration[];
}

export interface PSParamDeclaration extends ASTBase {
  type: 'ParamDeclaration';
  attributes: PSAttribute[];
  paramType: string | null;
  name: PSVariableExpression;
  defaultValue: PSExpression | null;
  mandatory: boolean;
}

export interface PSAttribute extends ASTBase {
  type: 'Attribute';
  name: string;
  positionalArgs: PSExpression[];
  namedArgs: Record<string, PSExpression>;
}

// ─── Type literal [TypeName] ──────────────────────────────────────────────────

export interface PSTypeLiteral extends ASTBase {
  type: 'TypeLiteral';
  typeName: string;
}

// ─── Unary expressions ────────────────────────────────────────────────────────

export type PSUnaryOperator = '-not' | '!' | '-bnot' | '+' | '-';

export interface PSUnaryExpression extends ASTBase {
  type: 'UnaryExpression';
  operator: PSUnaryOperator;
  operand: PSExpression;
}

// ─── Binary expressions ───────────────────────────────────────────────────────

export type PSBinaryOperator =
  // Arithmetic
  | '+' | '-' | '*' | '/' | '%'
  // Comparison (case-insensitive by default)
  | '-eq' | '-ne' | '-gt' | '-ge' | '-lt' | '-le'
  | '-like' | '-notlike' | '-match' | '-notmatch'
  | '-contains' | '-notcontains' | '-in' | '-notin'
  | '-is' | '-isnot' | '-as'
  // Case-sensitive variants
  | '-ceq' | '-cne' | '-cgt' | '-cge' | '-clt' | '-cle'
  | '-clike' | '-cnotlike' | '-cmatch' | '-cnotmatch'
  // String operators
  | '-replace' | '-split' | '-join' | '-f'
  // Logical
  | '-and' | '-or' | '-xor'
  // Bitwise
  | '-band' | '-bor' | '-bxor' | '-shl' | '-shr';

export interface PSBinaryExpression extends ASTBase {
  type: 'BinaryExpression';
  operator: PSBinaryOperator;
  left: PSExpression;
  right: PSExpression;
}

// ─── Range 1..10 ─────────────────────────────────────────────────────────────

export interface PSRangeExpression extends ASTBase {
  type: 'RangeExpression';
  start: PSExpression;
  end: PSExpression;
}

// ─── Member access $obj.Property ─────────────────────────────────────────────

export interface PSMemberExpression extends ASTBase {
  type: 'MemberExpression';
  object: PSExpression;
  member: string | PSExpression;   // string = static name; expression = computed ($obj.$prop)
  computed: boolean;
}

// ─── Static member [Type]::Member ────────────────────────────────────────────

export interface PSStaticMemberExpression extends ASTBase {
  type: 'StaticMemberExpression';
  typeName: string;
  member: string;
}

// ─── Index $arr[i] ───────────────────────────────────────────────────────────

export interface PSIndexExpression extends ASTBase {
  type: 'IndexExpression';
  object: PSExpression;
  index: PSExpression;
}

// ─── Method call $obj.Method(args) ───────────────────────────────────────────

export interface PSInvocationExpression extends ASTBase {
  type: 'InvocationExpression';
  callee: PSExpression;          // $obj.Method or [Type]::Method
  arguments: PSExpression[];
}

// ─── Type cast [int]$x ───────────────────────────────────────────────────────

export interface PSCastExpression extends ASTBase {
  type: 'CastExpression';
  targetType: string;
  operand: PSExpression;
}

// ─── Format string ("fmt" -f arg1, arg2) ──────────────────────────────────────

export interface PSFormatExpression extends ASTBase {
  type: 'FormatExpression';
  format: PSExpression;
  arguments: PSExpression[];
}

// ─── Splatting @params ────────────────────────────────────────────────────────

export interface PSSplatExpression extends ASTBase {
  type: 'SplatExpression';
  name: string;
}

// ─── Bareword as expression (for pipeline head use) ───────────────────────────

export interface PSCommandExpression extends ASTBase {
  type: 'CommandExpression';
  name: string;
}

// ─── Redirection ──────────────────────────────────────────────────────────────

export type PSRedirectionOp = '>' | '>>' | '2>' | '2>>' | '*>' | '*>>';

export interface PSRedirection extends ASTBase {
  type: 'Redirection';
  op: PSRedirectionOp;
  target: PSExpression | null;  // null for >$null
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory Functions
// ═══════════════════════════════════════════════════════════════════════════════

export function makeProgram(body: PSStatementList, pos?: SourcePosition): PSProgram {
  return { type: 'Program', body, position: pos };
}

export function makeStatementList(statements: PSStatement[], pos?: SourcePosition): PSStatementList {
  return { type: 'StatementList', statements, position: pos };
}

export function makePipeline(commands: PSCommand[], pos?: SourcePosition): PSPipeline {
  return { type: 'Pipeline', commands, position: pos };
}

export function makePipelineStatement(pipeline: PSPipeline, redirections: PSRedirection[] = [], pos?: SourcePosition): PSPipelineStatement {
  return { type: 'PipelineStatement', pipeline, redirections, position: pos };
}

export function makeCommand(name: PSExpression, params: PSCommandParameter[] = [], args: PSExpression[] = [], pos?: SourcePosition): PSCommand {
  return { type: 'Command', name, parameters: params, arguments: args, position: pos };
}

export function makeCommandParam(name: string, value: PSExpression | null, pos?: SourcePosition): PSCommandParameter {
  return { type: 'CommandParameter', name, value, position: pos };
}

export function makeLiteral(value: PSLiteralValue, raw: string, kind: PSLiteralExpression['kind'], pos?: SourcePosition): PSLiteralExpression {
  return { type: 'LiteralExpression', value, raw, kind, position: pos };
}

export function makeVariable(name: string, pos?: SourcePosition): PSVariableExpression {
  const colonIdx = name.indexOf(':');
  const scope = colonIdx >= 0 ? name.substring(0, colonIdx) : null;
  const varName = colonIdx >= 0 ? name.substring(colonIdx + 1) : name;
  return { type: 'VariableExpression', name, scope, varName, position: pos };
}

export function makeAssignment(
  target: PSAssignmentStatement['target'],
  operator: PSAssignmentStatement['operator'],
  value: PSExpression,
  pos?: SourcePosition,
): PSAssignmentStatement {
  return { type: 'AssignmentStatement', target, operator, value, position: pos };
}

export function makeUnary(operator: PSUnaryOperator, operand: PSExpression, pos?: SourcePosition): PSUnaryExpression {
  return { type: 'UnaryExpression', operator, operand, position: pos };
}

export function makeBinary(operator: PSBinaryOperator, left: PSExpression, right: PSExpression, pos?: SourcePosition): PSBinaryExpression {
  return { type: 'BinaryExpression', operator, left, right, position: pos };
}

export function makeRange(start: PSExpression, end: PSExpression, pos?: SourcePosition): PSRangeExpression {
  return { type: 'RangeExpression', start, end, position: pos };
}

export function makeMember(object: PSExpression, member: string | PSExpression, computed: boolean, pos?: SourcePosition): PSMemberExpression {
  return { type: 'MemberExpression', object, member, computed, position: pos };
}

export function makeIndex(object: PSExpression, index: PSExpression, pos?: SourcePosition): PSIndexExpression {
  return { type: 'IndexExpression', object, index, position: pos };
}

export function makeCast(targetType: string, operand: PSExpression, pos?: SourcePosition): PSCastExpression {
  return { type: 'CastExpression', targetType, operand, position: pos };
}

export function makeScriptBlock(
  body: PSStatementList | null,
  paramBlock: PSParamBlock | null = null,
  pos?: SourcePosition,
): PSScriptBlock {
  return { type: 'ScriptBlock', paramBlock, beginBlock: null, processBlock: null, endBlock: null, body, position: pos };
}

export function makeHashtable(pairs: PSHashtablePair[], pos?: SourcePosition): PSHashtableExpression {
  return { type: 'HashtableExpression', pairs, position: pos };
}

export function makeArrayExpr(elements: PSStatement[], pos?: SourcePosition): PSArrayExpression {
  return { type: 'ArrayExpression', elements, position: pos };
}

export function makeIfStatement(
  condition: PSExpression,
  thenBody: PSScriptBlock,
  elseifClauses: PSElseifClause[] = [],
  elseBody: PSScriptBlock | null = null,
  pos?: SourcePosition,
): PSIfStatement {
  return { type: 'IfStatement', condition, thenBody, elseifClauses, elseBody, position: pos };
}

export function makeFunctionDef(
  kind: PSFunctionDefinition['kind'],
  name: string,
  body: PSScriptBlock,
  pos?: SourcePosition,
): PSFunctionDefinition {
  return { type: 'FunctionDefinition', kind, name, body, position: pos };
}

export function makeRedirection(op: PSRedirectionOp, target: PSExpression | null, pos?: SourcePosition): PSRedirection {
  return { type: 'Redirection', op, target, position: pos };
}
