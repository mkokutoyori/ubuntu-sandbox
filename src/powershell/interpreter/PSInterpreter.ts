/**
 * PSInterpreter — PowerShell 5.1 AST walker / executor.
 *
 * Sections:
 *   1. Class setup + expression evaluation
 *   2. Statement executors (if / while / for / foreach / switch / try / function)
 *   3. Pipeline engine + built-in cmdlets
 */

import { PSLexer } from '@/powershell/lexer/PSLexer';
import { PSParser } from '@/powershell/parser/PSParser';
import { PSEnvironment, PSValue, seedBuiltins } from '@/powershell/runtime/PSEnvironment';
import { expandString, psValueToString } from '@/powershell/runtime/PSExpansion';
import type {
  PSProgram, PSStatementList, PSStatement,
  PSPipelineStatement, PSAssignmentStatement,
  PSIfStatement, PSWhileStatement, PSDoWhileStatement, PSDoUntilStatement,
  PSForStatement, PSForeachStatement, PSSwitchStatement, PSTryStatement,
  PSFunctionDefinition, PSReturnStatement, PSThrowStatement,
  PSPipeline, PSCommand,
  PSExpression, PSLiteralExpression, PSVariableExpression,
  PSBinaryExpression, PSUnaryExpression, PSRangeExpression,
  PSArrayExpression, PSHashtableExpression, PSSubExpressionExpression,
  PSMemberExpression, PSStaticMemberExpression, PSIndexExpression,
  PSInvocationExpression, PSCastExpression, PSCommandExpression,
  PSScriptBlock, PSPipelineExpression,
} from '@/powershell/parser/PSASTNode';

// ─── Flow-control signals ─────────────────────────────────────────────────────

class ReturnSignal  { constructor(public readonly value: PSValue) {} }
class BreakSignal   {}
class ContinueSignal {}

export class PSRuntimeError extends Error {
  constructor(message: string) { super(message); this.name = 'PSRuntimeError'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1 — Class setup + expression evaluation
// ═══════════════════════════════════════════════════════════════════════════════

export class PSInterpreter {
  private readonly lexer  = new PSLexer();
  private readonly parser = new PSParser();
  private readonly global: PSEnvironment;
  private outputLines: string[] = [];

  // ── User-defined functions registered at global scope ─────────────────────
  private readonly functions = new Map<string, PSScriptBlock>();

  /** Host hook: returns true if a path exists on the embedding device. */
  testPathHook: ((path: string) => boolean) | null = null;

  /** Host hook: resolve a $env: variable name → string value (or null if unknown). */
  envVarHook: ((name: string) => string | null) | null = null;

  constructor() {
    this.global = new PSEnvironment();
    seedBuiltins(this.global);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  execute(code: string): string {
    this.outputLines = [];
    const tokens = this.lexer.tokenize(code);
    const ast    = this.parser.parse(tokens);
    this.execProgram(ast, this.global);
    return this.outputLines.join('\n');
  }

  /**
   * Interactive variant of execute(): bare expressions that produce a value
   * without explicitly writing to the pipeline (e.g. `$x`, `2+3`) are printed
   * to the output, matching the PowerShell REPL.
   */
  executeInteractive(code: string): string {
    this.outputLines = [];
    const tokens = this.lexer.tokenize(code);
    const ast    = this.parser.parse(tokens);
    for (const stmt of ast.body.statements) {
      const wasEmpty = this.outputLines.length;
      const result = this.execStatement(stmt, this.global);
      // If the statement produced a value but emitted no output, echo it
      // (REPL-style) — unless it's an assignment ($x = ...) which never echoes.
      const didOutput = this.outputLines.length > wasEmpty;
      if (!didOutput && stmt.type !== 'AssignmentStatement' && result !== null && result !== undefined) {
        if (Array.isArray(result)) {
          for (const item of result) this.outputLines.push(psValueToString(item));
        } else {
          this.outputLines.push(psValueToString(result));
        }
      }
    }
    return this.outputLines.join('\n');
  }

  getVariable(name: string): PSValue {
    return this.global.get(name);
  }

  setVariable(name: string, value: PSValue): void {
    this.global.set(name, value);
  }

  // ── Program / StatementList ────────────────────────────────────────────────

  private execProgram(node: PSProgram, env: PSEnvironment): PSValue {
    return this.execStatementList(node.body, env);
  }

  execStatementList(node: PSStatementList, env: PSEnvironment): PSValue {
    let last: PSValue = null;
    for (const stmt of node.statements) {
      last = this.execStatement(stmt, env);
    }
    return last;
  }

  // ── Statement dispatcher ───────────────────────────────────────────────────

  execStatement(node: PSStatement, env: PSEnvironment): PSValue {
    switch (node.type) {
      case 'PipelineStatement':   return this.execPipelineStmt(node as PSPipelineStatement, env);
      case 'AssignmentStatement': return this.execAssignment(node as PSAssignmentStatement, env);
      case 'IfStatement':         return this.execIf(node as PSIfStatement, env);
      case 'WhileStatement':      return this.execWhile(node as PSWhileStatement, env);
      case 'DoWhileStatement':    return this.execDoWhile(node as PSDoWhileStatement, env);
      case 'DoUntilStatement':    return this.execDoUntil(node as PSDoUntilStatement, env);
      case 'ForStatement':        return this.execFor(node as PSForStatement, env);
      case 'ForeachStatement':    return this.execForeach(node as PSForeachStatement, env);
      case 'SwitchStatement':     return this.execSwitch(node as PSSwitchStatement, env);
      case 'TryStatement':        return this.execTry(node as PSTryStatement, env);
      case 'FunctionDefinition':  return this.execFunctionDef(node as PSFunctionDefinition, env);
      case 'ReturnStatement':     return this.execReturn(node as PSReturnStatement, env);
      case 'BreakStatement':      throw new BreakSignal();
      case 'ContinueStatement':   throw new ContinueSignal();
      case 'ThrowStatement':      return this.execThrow(node as PSThrowStatement, env);
      default:                    return null;
    }
  }

  // ── Assignment ─────────────────────────────────────────────────────────────

  private execAssignment(node: PSAssignmentStatement, env: PSEnvironment): PSValue {
    const rhs = this.evalExpr(node.value, env);

    // Index / member targets: $h["x"] = v   /   $obj.prop = v
    if (node.target.type === 'IndexExpression' || node.target.type === 'MemberExpression') {
      const result = this.computeAssignResult(node, rhs, env);
      this.writeTarget(node.target, result, env);
      return result;
    }

    const target = node.target as PSVariableExpression;
    const varName = target.varName ?? (target as unknown as { name: string }).name;

    if (node.operator === '=') {
      env.set(varName, rhs);
      return rhs;
    }

    const current = (env.get(varName) as number) ?? 0;
    const result = this.applyCompound(node.operator, current, rhs);
    env.update(varName, result);
    return result;
  }

  private applyCompound(op: PSAssignmentStatement['operator'], current: PSValue, rhs: PSValue): PSValue {
    switch (op) {
      case '+=': return this.applyPlus(current, rhs);
      case '-=': return (current as number) - (rhs as number);
      case '*=': return (current as number) * (rhs as number);
      case '/=': return (current as number) / (rhs as number);
      case '%=': return (current as number) % (rhs as number);
      default:   return rhs;
    }
  }

  private computeAssignResult(
    node: PSAssignmentStatement,
    rhs: PSValue,
    env: PSEnvironment,
  ): PSValue {
    if (node.operator === '=') return rhs;
    const current = this.evalExpr(node.target, env);
    return this.applyCompound(node.operator, current, rhs);
  }

  /** Writes a value to an index- or member-target expression. */
  private writeTarget(
    target: PSIndexExpression | PSMemberExpression,
    value: PSValue,
    env: PSEnvironment,
  ): void {
    if (target.type === 'IndexExpression') {
      const container = this.evalExpr(target.object, env);
      const key = this.evalExpr(target.index, env);
      if (Array.isArray(container)) {
        container[Number(key)] = value;
      } else if (container && typeof container === 'object') {
        (container as Record<string, PSValue>)[psValueToString(key)] = value;
      } else {
        throw new PSRuntimeError(`Cannot index into value of type ${typeof container}`);
      }
      return;
    }
    // MemberExpression
    const container = this.evalExpr(target.object, env);
    const memberName = typeof target.member === 'string'
      ? target.member
      : psValueToString(this.evalExpr(target.member, env));
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      (container as Record<string, PSValue>)[memberName] = value;
      return;
    }
    throw new PSRuntimeError(`Cannot assign to property '${memberName}' of non-object value`);
  }

  private execPipelineStmt(node: PSPipelineStatement, env: PSEnvironment): PSValue {
    return this.execPipeline(node.pipeline, env);
  }

  // ── ScriptBlock executor ───────────────────────────────────────────────────

  execScriptBlock(block: PSScriptBlock, env: PSEnvironment): PSValue {
    try {
      if (block.beginBlock)   this.execStatementList(block.beginBlock,   env);
      if (block.processBlock) this.execStatementList(block.processBlock, env);
      if (block.endBlock)     this.execStatementList(block.endBlock,     env);
      if (block.body)         return this.execStatementList(block.body,  env);
      return null;
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
  }

  // ── ScriptBlock invocation (functions, cmdlet filter blocks) ──────────────

  invokeScriptBlock(
    block: PSScriptBlock,
    namedArgs: Record<string, PSValue>,
    positionalArgs: PSValue[],
    parentEnv: PSEnvironment,
    pipelineInput?: PSValue,
  ): PSValue {
    const childEnv = parentEnv.createChild();

    // $_ / $PSItem for pipeline
    if (pipelineInput !== undefined) {
      childEnv.set('_',      pipelineInput);
      childEnv.set('PSItem', pipelineInput);
    }

    // Bind declared parameters
    if (block.paramBlock) {
      block.paramBlock.parameters.forEach(p => {
        const pname = p.name.varName ?? p.name.name;
        const pkey  = pname.toLowerCase();
        if (namedArgs[pkey] !== undefined) {
          childEnv.set(pname, namedArgs[pkey]);
        } else if (positionalArgs.length > 0) {
          childEnv.set(pname, positionalArgs.shift()!);
        } else if (p.defaultValue) {
          childEnv.set(pname, this.evalExpr(p.defaultValue, parentEnv));
        } else {
          childEnv.set(pname, null);
        }
      });
    }

    return this.execScriptBlock(block, childEnv);
  }

  // ── Expression dispatcher ──────────────────────────────────────────────────

  evalExpr(node: PSExpression, env: PSEnvironment): PSValue {
    switch (node.type) {
      case 'LiteralExpression':        return this.evalLiteral(node as PSLiteralExpression, env);
      case 'VariableExpression':       return this.evalVariable(node as PSVariableExpression, env);
      case 'BinaryExpression':         return this.evalBinary(node as PSBinaryExpression, env);
      case 'UnaryExpression':          return this.evalUnary(node as PSUnaryExpression, env);
      case 'ArrayExpression':          return this.evalArray(node as PSArrayExpression, env);
      case 'HashtableExpression':      return this.evalHashtable(node as PSHashtableExpression, env);
      case 'SubExpression':            return this.evalSubExpr(node as PSSubExpressionExpression, env);
      case 'MemberExpression':         return this.evalMember(node as PSMemberExpression, env);
      case 'StaticMemberExpression':   return this.evalStaticMember(node as PSStaticMemberExpression, env);
      case 'IndexExpression':          return this.evalIndex(node as PSIndexExpression, env);
      case 'InvocationExpression':     return this.evalInvocation(node as PSInvocationExpression, env);
      case 'CastExpression':           return this.evalCast(node as PSCastExpression, env);
      case 'RangeExpression':          return this.evalRange(node as PSRangeExpression, env);
      case 'CommandExpression':        return this.evalCommandExpr(node as PSCommandExpression, env);
      case 'PipelineExpression':       return this.execPipeline((node as PSPipelineExpression).pipeline, env);
      case 'ScriptBlock':              return node as unknown as PSValue;
      case 'AssignmentStatement':      return this.execAssignment(node as unknown as PSAssignmentStatement, env);
      default:                         return null;
    }
  }

  // ── Literal ────────────────────────────────────────────────────────────────

  private evalLiteral(node: PSLiteralExpression, env: PSEnvironment): PSValue {
    if (node.kind === 'expandable') {
      return this.expandDoubleQuotedString(node.value as string, env);
    }
    return node.value as PSValue;
  }

  private expandDoubleQuotedString(raw: string, env: PSEnvironment): string {
    return expandString(raw, env, (code) => {
      const tokens = this.lexer.tokenize(code);
      const ast    = this.parser.parse(tokens);
      return this.execProgram(ast, env);
    });
  }

  // ── Variable ───────────────────────────────────────────────────────────────

  private evalVariable(node: PSVariableExpression, env: PSEnvironment): PSValue {
    const name = node.varName ?? node.name;

    if (node.scope === 'global') return env.getGlobal(name);
    if (node.scope === 'env') {
      // Try host hook first (provides Windows-specific simulated env vars)
      if (this.envVarHook) {
        const v = this.envVarHook(name);
        if (v !== null) return v;
      }
      // Fall back to real process environment (works on native Windows)
      return process.env[name.toUpperCase()] ?? null;
    }

    // $true / $false / $null resolved via seedBuiltins
    const val = env.get(name);
    return val === undefined ? null : val;
  }

  // ── Binary ─────────────────────────────────────────────────────────────────

  private evalBinary(node: PSBinaryExpression, env: PSEnvironment): PSValue {
    const op = node.operator.toLowerCase();

    // Short-circuit
    if (op === '-and') {
      return this.isTruthy(this.evalExpr(node.left, env))
        ? this.evalExpr(node.right, env)
        : false;
    }
    if (op === '-or') {
      const l = this.evalExpr(node.left, env);
      return this.isTruthy(l) ? l : this.evalExpr(node.right, env);
    }

    const left  = this.evalExpr(node.left,  env);
    const right = this.evalExpr(node.right, env);

    switch (op) {
      case '+':  return this.applyPlus(left, right);
      case '-':  return (left as number) - (right as number);
      case '*':  return this.applyMultiply(left, right);
      case '/':  return (left as number) / (right as number);
      case '%':  return (left as number) % (right as number);

      case '-eq':  return this.psEq(left, right, false);
      case '-ne':  return !this.psEq(left, right, false);
      case '-ceq': return this.psEq(left, right, true);
      case '-cne': return !this.psEq(left, right, true);
      case '-ieq': return this.psEq(left, right, false);
      case '-ine': return !this.psEq(left, right, false);
      case '-gt':  return (left as number) > (right as number);
      case '-lt':  return (left as number) < (right as number);
      case '-ge':  return (left as number) >= (right as number);
      case '-le':  return (left as number) <= (right as number);
      case '-cgt': return String(left) > String(right);
      case '-clt': return String(left) < String(right);
      case '-cge': return String(left) >= String(right);
      case '-cle': return String(left) <= String(right);

      case '-like':     return this.psLike(String(left), String(right), false);
      case '-notlike':  return !this.psLike(String(left), String(right), false);
      case '-clike':    return this.psLike(String(left), String(right), true);
      case '-cnotlike': return !this.psLike(String(left), String(right), true);

      case '-match': {
        const matched = this.psMatch(String(left), String(right), false, env);
        return matched;
      }
      case '-notmatch': return !this.psMatch(String(left), String(right), false, env);
      case '-cmatch':   return this.psMatch(String(left), String(right), true, env);
      case '-cnotmatch':return !this.psMatch(String(left), String(right), true, env);

      case '-contains': {
        const arr = Array.isArray(left) ? left : [];
        return arr.some(e => this.psEq(e, right, false));
      }
      case '-notcontains': {
        const arr = Array.isArray(left) ? left : [];
        return !arr.some(e => this.psEq(e, right, false));
      }
      case '-in': {
        const arr = Array.isArray(right) ? right : [];
        return arr.some(e => this.psEq(e, left, false));
      }
      case '-notin': {
        const arr = Array.isArray(right) ? right : [];
        return !arr.some(e => this.psEq(e, left, false));
      }

      case '-xor':  return this.isTruthy(left) !== this.isTruthy(right);
      case '-band': return (left as number) & (right as number);
      case '-bor':  return (left as number) | (right as number);
      case '-bxor': return (left as number) ^ (right as number);
      case '-shl':  return (left as number) << (right as number);
      case '-shr':  return (left as number) >> (right as number);

      case '-replace': {
        const args = Array.isArray(right) ? right : [right];
        const pattern = String(args[0] ?? '');
        const repl    = String(args[1] ?? '');
        return String(left).replace(new RegExp(pattern, 'gi'), repl);
      }
      case '-split': {
        const args = Array.isArray(right) ? right : [right];
        const pattern = String(args[0] ?? '');
        const limit   = args[1] !== undefined ? Number(args[1]) : undefined;
        const parts = String(left).split(new RegExp(pattern));
        return limit !== undefined ? parts.slice(0, limit) : parts;
      }
      case '-join':   return (Array.isArray(left) ? left : [left]).map(psValueToString).join(String(right));

      case '-is':   return this.psIs(left, String(right));
      case '-isnot':return !this.psIs(left, String(right));
      case '-as':   return this.psCast(left, String(right));

      default:
        throw new PSRuntimeError(`Unknown operator: ${op}`);
    }
  }

  // ── Unary ──────────────────────────────────────────────────────────────────

  private evalUnary(node: PSUnaryExpression, env: PSEnvironment): PSValue {
    const val = this.evalExpr(node.operand, env);
    switch (node.operator) {
      case '-':    return -(val as number);
      case '+':    return +(val as number);
      case '-not': return !this.isTruthy(val);
      case '!':    return !this.isTruthy(val);
      case '-bnot':return ~(val as number);
      default:     throw new PSRuntimeError(`Unknown unary operator: ${node.operator}`);
    }
  }

  // ── Array @() ─────────────────────────────────────────────────────────────

  private evalArray(node: PSArrayExpression, env: PSEnvironment): PSValue {
    const result: PSValue[] = [];
    for (const stmt of node.elements) {
      const val = this.execStatement(stmt, env);
      if (Array.isArray(val)) result.push(...val);
      else if (val !== null && val !== undefined) result.push(val);
    }
    return result;
  }

  // ── Hashtable @{k=v} ──────────────────────────────────────────────────────

  private evalHashtable(node: PSHashtableExpression, env: PSEnvironment): PSValue {
    const result: Record<string, PSValue> = {};
    for (const pair of node.pairs) {
      const key = psValueToString(this.evalExpr(pair.key, env));
      result[key] = this.evalExpr(pair.value, env);
    }
    return result;
  }

  // ── SubExpression $(...) ───────────────────────────────────────────────────

  private evalSubExpr(node: PSSubExpressionExpression, env: PSEnvironment): PSValue {
    return this.execStatementList(node.body, env);
  }

  // ── Range 1..5 ────────────────────────────────────────────────────────────

  private evalRange(node: PSRangeExpression, env: PSEnvironment): PSValue {
    const start = this.evalExpr(node.start, env) as number;
    const end   = this.evalExpr(node.end,   env) as number;
    const arr: number[] = [];
    if (start <= end) for (let i = start; i <= end; i++) arr.push(i);
    else              for (let i = start; i >= end; i--) arr.push(i);
    return arr;
  }

  // ── Member $obj.Prop ──────────────────────────────────────────────────────

  private evalMember(node: PSMemberExpression, env: PSEnvironment): PSValue {
    const obj    = this.evalExpr(node.object, env);
    const member = typeof node.member === 'string'
      ? node.member.toLowerCase()
      : psValueToString(this.evalExpr(node.member as PSExpression, env)).toLowerCase();
    return this.getMember(obj, member);
  }

  // ── Static member [Type]::Member ─────────────────────────────────────────

  private evalStaticMember(node: PSStaticMemberExpression, env: PSEnvironment): PSValue {
    const typeName = node.typeName.toLowerCase();
    const member   = node.member.toLowerCase();
    const typeObj  = STATIC_TYPES[typeName];
    if (typeObj) return this.getMember(typeObj as PSValue, member);
    return null;
  }

  // ── Index $arr[i] ─────────────────────────────────────────────────────────

  private evalIndex(node: PSIndexExpression, env: PSEnvironment): PSValue {
    const obj = this.evalExpr(node.object, env);
    const idx = this.evalExpr(node.index,  env);
    if (Array.isArray(obj)) {
      let i = idx as number;
      if (i < 0) i = obj.length + i;
      return obj[i] ?? null;
    }
    if (obj !== null && typeof obj === 'object') {
      return (obj as Record<string, PSValue>)[String(idx)] ?? null;
    }
    return null;
  }

  // ── Method call $obj.Method(args) ────────────────────────────────────────

  private evalInvocation(node: PSInvocationExpression, env: PSEnvironment): PSValue {
    const callee = this.evalExpr(node.callee, env);
    const args   = node.arguments.map(a => this.evalExpr(a, env));
    if (typeof callee === 'function') {
      return (callee as (...a: PSValue[]) => PSValue)(...args);
    }
    return null;
  }

  // ── Cast [type]expr ───────────────────────────────────────────────────────

  private evalCast(node: PSCastExpression, env: PSEnvironment): PSValue {
    const val = this.evalExpr(node.operand, env);
    return this.psCast(val, node.targetType);
  }

  // ── CommandExpression (bareword as expression — may be a zero-arg function call) ─

  private evalCommandExpr(node: PSCommandExpression, env: PSEnvironment): PSValue {
    if (node.name === '++' || node.name === '--') return null;
    const lname = node.name.toLowerCase();
    const block = this.functions.get(lname);
    if (block) return this.invokeScriptBlock(block, {}, [], env, undefined);
    // Try as built-in with no args (e.g. Get-Date, Get-Location bareword in expression)
    try { return this.execBuiltin(lname, [], {}, undefined, env); }
    // In PS, a bareword that isn't a known command is treated as a string value
    // (preserving the original casing) — e.g. `Select-Object Name` passes "Name".
    catch { return node.name; }
  }

  // ── Public coercion helpers ────────────────────────────────────────────────

  psCast(val: PSValue, typeName: string): PSValue {
    const t = typeName.replace(/^\[|\]$/g, '').toLowerCase();
    switch (t) {
      case 'int':
      case 'int32':
      case 'long':
      case 'int64':   return parseInt(String(val), 10);
      case 'double':
      case 'float':
      case 'single':
      case 'decimal': return parseFloat(String(val));
      case 'string':  return psValueToString(val);
      case 'bool':
      case 'boolean': return this.isTruthy(val);
      case 'char':    return String(val).charAt(0);
      case 'array':   return Array.isArray(val) ? val : [val];
      default:        return val;
    }
  }

  isTruthy(val: PSValue): boolean {
    if (val === null || val === undefined) return false;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number')  return val !== 0;
    if (typeof val === 'string')  return val.length > 0;
    if (Array.isArray(val))       return val.length > 0;
    return true;
  }

  private applyPlus(left: PSValue, right: PSValue): PSValue {
    if (Array.isArray(left)) return [...left, ...(Array.isArray(right) ? right : [right])];
    if (typeof left === 'string' || typeof right === 'string')
      return psValueToString(left) + psValueToString(right);
    return (left as number) + (right as number);
  }

  private applyMultiply(left: PSValue, right: PSValue): PSValue {
    if (typeof left === 'string' && typeof right === 'number') return left.repeat(right);
    if (typeof right === 'string' && typeof left === 'number') return right.repeat(left);
    return (left as number) * (right as number);
  }

  private psEq(a: PSValue, b: PSValue, caseSensitive: boolean): boolean {
    if (typeof a === 'string' && typeof b === 'string')
      return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
    return a === b;
  }

  private psLike(str: string, pattern: string, caseSensitive: boolean): boolean {
    const regex = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(regex, caseSensitive ? '' : 'i').test(str);
  }

  private psMatch(str: string, pattern: string, caseSensitive: boolean, env: PSEnvironment): boolean {
    const re = new RegExp(pattern, caseSensitive ? '' : 'i');
    const m  = str.match(re);
    if (m) {
      const matches: Record<string, PSValue> = { '0': m[0] };
      m.slice(1).forEach((g, i) => { matches[String(i + 1)] = g ?? null; });
      env.set('Matches', matches);
    }
    return !!m;
  }

  private psIs(val: PSValue, typeName: string): boolean {
    const t = typeName.replace(/^\[|\]$/g, '').toLowerCase();
    switch (t) {
      case 'string':           return typeof val === 'string';
      case 'int': case 'int32':
      case 'double': case 'float': return typeof val === 'number';
      case 'bool': case 'boolean': return typeof val === 'boolean';
      case 'array':            return Array.isArray(val);
      case 'null':             return val === null;
      default:                 return false;
    }
  }

  // ── Member access helper ───────────────────────────────────────────────────

  getMember(obj: PSValue, member: string): PSValue {
    if (obj === null || obj === undefined) return null;

    if (typeof obj === 'string') return this.getStringMember(obj, member);
    if (Array.isArray(obj))     return this.getArrayMember(obj, member);

    if (typeof obj === 'object') {
      const rec = obj as Record<string, PSValue>;
      const key = Object.keys(rec).find(k => k.toLowerCase() === member) ?? member;
      const val = rec[key];
      if (val !== undefined) return val;
      // PSObject built-in properties
      if (member === 'count') return Object.keys(rec).length;
      if (member === 'keys')  return Object.keys(rec);
    }
    return null;
  }

  private getStringMember(s: string, member: string): PSValue {
    switch (member) {
      case 'length':     return s.length;
      case 'toupper':    return () => s.toUpperCase();
      case 'tolower':    return () => s.toLowerCase();
      case 'trim':       return () => s.trim();
      case 'trimstart':  return () => s.trimStart();
      case 'trimend':    return () => s.trimEnd();
      case 'contains':   return (sub: PSValue) => s.toLowerCase().includes(String(sub).toLowerCase());
      case 'startswith': return (pfx: PSValue) => s.toLowerCase().startsWith(String(pfx).toLowerCase());
      case 'endswith':   return (sfx: PSValue) => s.toLowerCase().endsWith(String(sfx).toLowerCase());
      case 'replace':    return (o: PSValue, n: PSValue) => s.split(String(o)).join(String(n));
      case 'split':      return (sep: PSValue) => s.split(String(sep));
      case 'indexof':    return (sub: PSValue) => s.indexOf(String(sub));
      case 'substring':  return (start: PSValue, len?: PSValue) =>
        len !== undefined ? s.substr(Number(start), Number(len)) : s.substr(Number(start));
      case 'padleft':    return (w: PSValue) => s.padStart(Number(w));
      case 'padright':   return (w: PSValue) => s.padEnd(Number(w));
      case 'chars':      return Array.from(s);
      default:           return null;
    }
  }

  private getArrayMember(arr: PSValue[], member: string): PSValue {
    switch (member) {
      case 'length':
      case 'count':    return arr.length;
      case 'contains': return (v: PSValue) => arr.some(e => this.psEq(e, v, false));
      case 'indexof':  return (v: PSValue) => arr.findIndex(e => this.psEq(e, v, false));
      default:         return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2 — Statement executors
  // ═══════════════════════════════════════════════════════════════════════════

  // ── if / elseif / else ─────────────────────────────────────────────────────

  private execIf(node: PSIfStatement, env: PSEnvironment): PSValue {
    if (this.isTruthy(this.evalExpr(node.condition, env))) {
      return this.execScriptBlock(node.thenBody, env);
    }
    for (const ei of node.elseifClauses) {
      if (this.isTruthy(this.evalExpr(ei.condition, env))) {
        return this.execScriptBlock(ei.body, env);
      }
    }
    if (node.elseBody) return this.execScriptBlock(node.elseBody, env);
    return null;
  }

  // ── while ──────────────────────────────────────────────────────────────────

  private execWhile(node: PSWhileStatement, env: PSEnvironment): PSValue {
    while (this.isTruthy(this.evalExpr(node.condition, env))) {
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal)    break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
    return null;
  }

  // ── do-while ───────────────────────────────────────────────────────────────

  private execDoWhile(node: PSDoWhileStatement, env: PSEnvironment): PSValue {
    do {
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal)    break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    } while (this.isTruthy(this.evalExpr(node.condition, env)));
    return null;
  }

  // ── do-until ───────────────────────────────────────────────────────────────

  private execDoUntil(node: PSDoUntilStatement, env: PSEnvironment): PSValue {
    do {
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal)    break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    } while (!this.isTruthy(this.evalExpr(node.condition, env)));
    return null;
  }

  // ── for (init; cond; iter) ─────────────────────────────────────────────────

  private execFor(node: PSForStatement, env: PSEnvironment): PSValue {
    if (node.init) this.execStatement(node.init, env);
    outer: while (!node.condition || this.isTruthy(this.evalExpr(node.condition, env))) {
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal)    break outer;
        if (e instanceof ContinueSignal) { /* fall through to iterator */ }
        else throw e;
      }
      if (node.iterator) this.execStatement(node.iterator, env);
    }
    return null;
  }

  // ── foreach ($x in $collection) ───────────────────────────────────────────

  private execForeach(node: PSForeachStatement, env: PSEnvironment): PSValue {
    const varName    = node.variable.varName ?? node.variable.name;
    const collection = this.evalExpr(node.collection, env);
    const items: PSValue[] = Array.isArray(collection) ? collection
      : collection !== null && collection !== undefined ? [collection] : [];

    for (const item of items) {
      env.set(varName, item);
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal)    break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
    return null;
  }

  // ── switch ─────────────────────────────────────────────────────────────────

  private execSwitch(node: PSSwitchStatement, env: PSEnvironment): PSValue {
    const subject = this.evalExpr(node.subject, env);
    let matched = false;

    for (const clause of node.clauses) {
      const test = this.evalExpr(clause.pattern, env);
      if (this.switchMatch(subject, test)) {
        matched = true;
        try { this.execScriptBlock(clause.body, env); }
        catch (e) { if (e instanceof BreakSignal) return null; throw e; }
      }
    }

    if (!matched && node.defaultBody) {
      try { this.execScriptBlock(node.defaultBody, env); }
      catch (e) { if (e instanceof BreakSignal) return null; throw e; }
    }
    return null;
  }

  private switchMatch(subject: PSValue, test: PSValue): boolean {
    if (typeof subject === 'string' && typeof test === 'string')
      return subject.toLowerCase() === test.toLowerCase();
    return subject === test;
  }

  // ── try / catch / finally ──────────────────────────────────────────────────

  private execTry(node: PSTryStatement, env: PSEnvironment): PSValue {
    let result: PSValue = null;
    try {
      result = this.execScriptBlock(node.tryBody, env);
    } catch (e) {
      if (node.catchClauses.length > 0) {
        // Catch runs in current scope — set $_ directly in env, not a child
        env.set('_', this.makeErrorRecord(e));
        const clause = node.catchClauses.find(c => c.types.length === 0) ?? node.catchClauses[0];
        result = this.execScriptBlock(clause.body, env);
      } else {
        throw e;
      }
    } finally {
      if (node.finallyBody) this.execScriptBlock(node.finallyBody, env);
    }
    return result;
  }

  private makeErrorRecord(e: unknown): Record<string, PSValue> {
    const msg = e instanceof Error ? e.message : String(e);
    return { Message: msg, Exception: msg, FullyQualifiedErrorId: 'RuntimeException' } as Record<string, PSValue>;
  }

  // ── function definition ────────────────────────────────────────────────────

  private execFunctionDef(node: PSFunctionDefinition, env: PSEnvironment): PSValue {
    const block = node.body;
    this.functions.set(node.name.toLowerCase(), block);
    env.set(node.name, node.name as PSValue); // marker so lookup can find it
    return null;
  }

  // ── return ─────────────────────────────────────────────────────────────────

  private execReturn(node: PSReturnStatement, env: PSEnvironment): PSValue {
    const val = node.value ? this.evalExpr(node.value, env) : null;
    throw new ReturnSignal(val);
  }

  // ── throw ──────────────────────────────────────────────────────────────────

  private execThrow(node: PSThrowStatement, env: PSEnvironment): PSValue {
    const val = node.value ? this.evalExpr(node.value, env) : new PSRuntimeError('ScriptHalted');
    if (val instanceof Error) throw val;
    throw new Error(String(val));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3 — Pipeline engine + built-in cmdlets
  // ═══════════════════════════════════════════════════════════════════════════

  execPipeline(node: PSPipeline, env: PSEnvironment): PSValue {
    if (node.commands.length === 0) return null;
    if (node.commands.length === 1) return this.execCommand(node.commands[0], env, undefined);

    let pipeInput: PSValue = undefined;
    let result: PSValue = null;
    for (const cmd of node.commands) {
      result = this.execCommand(cmd, env, pipeInput);
      pipeInput = result;
    }
    return result;
  }

  private execCommand(node: PSCommand, env: PSEnvironment, pipeInput: PSValue): PSValue {
    const nameNode = node.name;

    // ── Special command-name cases ────────────────────────────────────────

    // $x++ / $x-- encoded as AssignmentStatement in command name position
    if (nameNode.type === 'AssignmentStatement') {
      return this.execAssignment(nameNode as unknown as PSAssignmentStatement, env);
    }

    // ++$x / --$x: CommandExpression("++") with variable argument
    if (nameNode.type === 'CommandExpression') {
      const ce = nameNode as PSCommandExpression;
      if ((ce.name === '++' || ce.name === '--') && node.arguments.length > 0) {
        const varNode = node.arguments[0] as PSVariableExpression;
        const vname = varNode.varName ?? varNode.name;
        const cur = (env.get(vname) as number) ?? 0;
        const newVal = ce.name === '++' ? cur + 1 : cur - 1;
        env.update(vname, newVal);
        return newVal;
      }
      // [Type] cast: TypeLiteral as name — handled below via cast
    }

    // [Type] cast: TypeLiteral in command name position with one argument
    if (nameNode.type === 'TypeLiteral') {
      const typeName = (nameNode as { typeName: string }).typeName;
      const arg = node.arguments[0] ? this.evalExpr(node.arguments[0], env) : null;
      return this.psCast(arg, typeName);
    }

    // ── Pure-value expressions: evaluate directly, not as cmdlet names ───
    if (this.isPureValueNode(nameNode, env)) {
      return this.evalExpr(nameNode, env);
    }

    // ── Resolve command name string ───────────────────────────────────────
    const rawName = this.resolveCommandName(nameNode, env);
    const lname   = rawName.toLowerCase();

    // ── Collect parameters and positional args ────────────────────────────
    const positional: PSValue[] = [];
    const named: Record<string, PSValue> = {};

    for (const p of node.parameters) {
      named[p.name.toLowerCase()] = p.value ? this.evalExpr(p.value, env) : true;
    }
    for (const a of node.arguments) {
      positional.push(this.evalExpr(a, env));
    }

    // ── User-defined function lookup ──────────────────────────────────────
    const block = this.functions.get(lname);
    if (block) {
      return this.invokeScriptBlock(block, named, positional, env, pipeInput);
    }

    // ── Built-in cmdlet dispatch ──────────────────────────────────────────
    return this.execBuiltin(lname, positional, named, pipeInput, env);
  }

  private resolveCommandName(nameNode: PSExpression, env: PSEnvironment): string {
    if (nameNode.type === 'LiteralExpression')
      return String((nameNode as PSLiteralExpression).value);
    if (nameNode.type === 'CommandExpression')
      return (nameNode as PSCommandExpression).name;
    if (nameNode.type === 'VariableExpression') {
      const val = this.evalVariable(nameNode as PSVariableExpression, env);
      return psValueToString(val);
    }
    return psValueToString(this.evalExpr(nameNode, env));
  }

  // ── Built-in cmdlet table ─────────────────────────────────────────────────

  private execBuiltin(
    name: string,
    pos: PSValue[],
    named: Record<string, PSValue>,
    pipeInput: PSValue,
    env: PSEnvironment,
  ): PSValue {
    switch (name) {
      // ── Output ────────────────────────────────────────────────────────────
      case 'write-output': case 'echo': {
        const val = pos[0] ?? pipeInput ?? null;
        if (Array.isArray(val)) {
          for (const item of val) this.outputLines.push(psValueToString(item));
        } else {
          this.outputLines.push(psValueToString(val));
        }
        return val;
      }
      case 'write-host': {
        const val = pos[0] ?? pipeInput ?? null;
        this.outputLines.push(psValueToString(val));
        return null;
      }
      case 'write-error': {
        this.outputLines.push(`ERROR: ${psValueToString(pos[0] ?? pipeInput ?? null)}`);
        return null;
      }
      case 'write-warning': {
        this.outputLines.push(`WARNING: ${psValueToString(pos[0] ?? pipeInput ?? null)}`);
        return null;
      }
      case 'write-verbose': {
        const pref = psValueToString(env.get('VerbosePreference') ?? 'SilentlyContinue');
        if (pref === 'Continue') {
          this.outputLines.push(`VERBOSE: ${psValueToString(pos[0] ?? pipeInput ?? null)}`);
        }
        return null;
      }
      case 'out-null':   return null;
      case 'out-string': return psValueToString(pipeInput ?? pos[0] ?? null);
      case 'out-host': {
        this.outputLines.push(psValueToString(pipeInput ?? pos[0] ?? null));
        return null;
      }

      // ── Collection cmdlets ────────────────────────────────────────────────
      case 'where-object': case '?': {
        const input  = this.toArray(pipeInput);
        const filter = (named['filterscript'] ?? pos[0]) as PSScriptBlock;
        return input.filter(item =>
          this.isTruthy(this.invokeScriptBlock(filter, {}, [], env, item)));
      }
      case 'foreach-object': case '%': {
        const input  = this.toArray(pipeInput);
        const script = (named['process'] ?? pos[0]) as PSScriptBlock;
        const begin  = named['begin'] as PSScriptBlock | undefined;
        const end    = named['end']   as PSScriptBlock | undefined;
        const out: PSValue[] = [];
        const captureOutput = (val: PSValue) => {
          if (val === null || val === undefined) return;
          if (Array.isArray(val)) for (const v of val) out.push(v);
          else out.push(val);
        };
        if (begin) captureOutput(this.invokeScriptBlock(begin, {}, [], env, null));
        for (const item of input) captureOutput(this.invokeScriptBlock(script, {}, [], env, item));
        if (end) captureOutput(this.invokeScriptBlock(end, {}, [], env, null));
        return out;
      }
      case 'select-object': {
        const input = this.toArray(pipeInput);
        const props = this.stringArgs(pos, named, 'property');
        if (props.length === 0) return pipeInput;
        return input.map(item => {
          const src = item as Record<string, PSValue>;
          const out: Record<string, PSValue> = {};
          for (const p of props) {
            const key = Object.keys(src).find(k => k.toLowerCase() === p.toLowerCase()) ?? p;
            out[key] = src[key] ?? null;
          }
          return out;
        });
      }
      case 'sort-object': {
        const input = this.toArray(pipeInput);
        const props = this.stringArgs(pos, named, 'property');
        const desc  = this.isTruthy(named['descending'] ?? false);
        return [...input].sort((a, b) => {
          const av = props.length ? (a as Record<string, PSValue>)[props[0]] : a;
          const bv = props.length ? (b as Record<string, PSValue>)[props[0]] : b;
          const cmp = String(av).localeCompare(String(bv));
          return desc ? -cmp : cmp;
        });
      }
      case 'measure-object': {
        const input = this.toArray(pipeInput);
        const props = this.stringArgs(pos, named, 'property');
        const nums  = input.map(item => {
          const v = props.length ? (item as Record<string, PSValue>)[props[0]] : item;
          return Number(v);
        }).filter(n => !isNaN(n));

        const result: Record<string, PSValue> = { Count: nums.length };
        if ('sum' in named || pos.some(p => p === '-sum'))
          result['Sum'] = nums.reduce((a, b) => a + b, 0);
        if ('average' in named)
          result['Average'] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        if ('minimum' in named || 'min' in named)
          result['Minimum'] = nums.length ? Math.min(...nums) : null;
        if ('maximum' in named || 'max' in named)
          result['Maximum'] = nums.length ? Math.max(...nums) : null;
        // -Sum as switch (named['sum'] === true)
        if (named['sum'] === true)
          result['Sum'] = nums.reduce((a, b) => a + b, 0);
        return result;
      }
      case 'group-object': {
        const input = this.toArray(pipeInput);
        const props = this.stringArgs(pos, named, 'property');
        const groups: Record<string, PSValue[]> = {};
        for (const item of input) {
          const key = props.length
            ? psValueToString((item as Record<string, PSValue>)[props[0]] ?? null)
            : psValueToString(item);
          if (!groups[key]) groups[key] = [];
          groups[key].push(item);
        }
        return Object.entries(groups).map(([k, v]) =>
          ({ Name: k, Count: v.length, Group: v } as Record<string, PSValue>));
      }

      // ── String / conversion ───────────────────────────────────────────────
      case 'convertto-json':   return JSON.stringify(pipeInput ?? pos[0] ?? null, null, 2);
      case 'convertfrom-json': {
        try { return JSON.parse(psValueToString(pipeInput ?? pos[0] ?? null)) as PSValue; }
        catch { return null; }
      }
      case 'format-list': case 'fl':
      case 'format-table': case 'ft':
        return this.toArray(pipeInput).map(v => psValueToString(v)).join('\n');

      // ── Variable cmdlets ──────────────────────────────────────────────────
      case 'set-variable': {
        const vname = psValueToString(named['name'] ?? pos[0] ?? '');
        env.set(vname, named['value'] ?? pos[1] ?? null);
        return null;
      }
      case 'get-variable': {
        const vname = psValueToString(named['name'] ?? pos[0] ?? '');
        return env.get(vname) ?? null;
      }
      case 'clear-variable': case 'remove-variable': {
        const vname = psValueToString(named['name'] ?? pos[0] ?? '');
        env.set(vname, null);
        return null;
      }

      // ── Misc ──────────────────────────────────────────────────────────────
      case 'new-object': {
        const tname = psValueToString(named['typename'] ?? pos[0] ?? '').toLowerCase();
        if (tname.includes('hashtable') || tname.includes('dictionary'))
          return {} as Record<string, PSValue>;
        return [] as PSValue[];
      }
      case 'get-random': {
        const max = named['maximum'] ?? pos[0] ?? null;
        const min = Number(named['minimum'] ?? 0);
        return max !== null
          ? Math.floor(Math.random() * (Number(max) - min)) + min
          : Math.random();
      }
      case 'tee-object': {
        const vname = psValueToString(named['variable'] ?? pos[0] ?? '');
        env.set(vname, pipeInput ?? null);
        return pipeInput ?? null;
      }
      case 'invoke-expression': case 'iex': {
        const code = psValueToString(named['command'] ?? pos[0] ?? pipeInput ?? '');
        const outerOutput = this.outputLines;
        this.executeInteractive(code); // internally resets then fills this.outputLines
        const iexOutput = this.outputLines;
        this.outputLines = outerOutput;
        outerOutput.push(...iexOutput);
        return null;
      }

      // ── Date / Time ───────────────────────────────────────────────────────
      case 'get-date': {
        const fmt = named['format'] ? psValueToString(named['format']) : null;
        const d = new Date();
        if (fmt !== null) return formatDate(d, fmt);
        return {
          Year:        d.getFullYear(),
          Month:       d.getMonth() + 1,
          Day:         d.getDate(),
          Hour:        d.getHours(),
          Minute:      d.getMinutes(),
          Second:      d.getSeconds(),
          Millisecond: d.getMilliseconds(),
          DayOfWeek:   d.getDay(),
          DayOfYear:   Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000),
        } as Record<string, PSValue>;
      }
      case 'new-timespan': {
        const days  = Number(named['days']    ?? 0);
        const hours = Number(named['hours']   ?? 0);
        const mins  = Number(named['minutes'] ?? 0);
        const secs  = Number(named['seconds'] ?? 0);
        const total = days * 86400 + hours * 3600 + mins * 60 + secs;
        return {
          Days:         Math.floor(total / 86400),
          Hours:        Math.floor((total % 86400) / 3600),
          Minutes:      Math.floor((total % 3600) / 60),
          Seconds:      total % 60,
          TotalSeconds: total,
          TotalMinutes: total / 60,
          TotalHours:   total / 3600,
          TotalDays:    total / 86400,
        } as Record<string, PSValue>;
      }
      case 'start-sleep': return null;

      // ── Path helpers ──────────────────────────────────────────────────────
      case 'split-path': {
        const p = psValueToString(named['path'] ?? pos[0] ?? '');
        const sep = p.includes('\\') ? '\\' : '/';
        const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
        const leaf = idx >= 0 ? p.slice(idx + 1) : p;
        const parent = idx >= 0 ? p.slice(0, idx) : '';
        if (named['leaf'] === true)      return leaf;
        if (named['parent'] === true)    return parent;
        if (named['extension'] === true) {
          const dot = leaf.lastIndexOf('.');
          return dot > 0 ? leaf.slice(dot) : '';
        }
        if (named['qualifier'] === true) {
          const m = p.match(/^[A-Za-z]:/);
          return m ? m[0] : '';
        }
        // Default = parent (matches PS behavior)
        void sep;
        return parent;
      }
      case 'join-path': {
        const p1 = psValueToString(named['path']      ?? pos[0] ?? '').replace(/[\\/]+$/, '');
        const p2 = psValueToString(named['childpath'] ?? pos[1] ?? '').replace(/^[\\/]+/,  '');
        const sep = p1.includes('/') && !p1.includes('\\') ? '/' : '\\';
        return `${p1}${sep}${p2}`;
      }
      case 'test-path': {
        // Without a filesystem binding the interpreter can only return false.
        // Host shells (PowerShellSubShell) may override this via a hook.
        if (this.testPathHook) return this.testPathHook(psValueToString(named['path'] ?? pos[0] ?? ''));
        return false;
      }

      // ── Comparison / uniqueness ───────────────────────────────────────────
      case 'compare-object': {
        const ref  = this.toArray(named['referenceobject']);
        const diff = this.toArray(named['differenceobject']);
        const includeEqual = named['includeequal'] === true;
        const out: Record<string, PSValue>[] = [];
        const refSet  = new Set(ref.map(v  => psValueToString(v)));
        const diffSet = new Set(diff.map(v => psValueToString(v)));
        for (const v of ref)  if (!diffSet.has(psValueToString(v))) out.push({ InputObject: v, SideIndicator: '<=' });
        for (const v of diff) if (!refSet.has(psValueToString(v)))  out.push({ InputObject: v, SideIndicator: '=>' });
        if (includeEqual) for (const v of ref) if (diffSet.has(psValueToString(v))) out.push({ InputObject: v, SideIndicator: '==' });
        return out;
      }
      case 'get-unique': {
        const arr = this.toArray(pipeInput);
        const out: PSValue[] = [];
        let prev: string | null = null;
        for (const v of arr) {
          const key = psValueToString(v);
          if (key !== prev) { out.push(v); prev = key; }
        }
        return out;
      }

      // ── Select-String ─────────────────────────────────────────────────────
      case 'select-string': {
        const patterns = this.stringArgs(pos, named, 'pattern');
        const pat = patterns[0] ?? '';
        const simple = named['simplematch'] === true;
        const notMatch = named['notmatch'] === true;
        const caseSensitive = named['casesensitive'] === true;
        const input = this.toArray(pipeInput);
        const re = simple
          ? new RegExp(escapeRegex(pat), caseSensitive ? '' : 'i')
          : new RegExp(pat, caseSensitive ? '' : 'i');
        const matches: Record<string, PSValue>[] = [];
        for (const item of input) {
          const line = psValueToString(item);
          const hit = re.test(line);
          if (hit !== notMatch) {
            matches.push({ Line: line, Pattern: pat, LineNumber: matches.length + 1 });
          }
        }
        return matches;
      }

      // ── CSV converters ────────────────────────────────────────────────────
      case 'convertto-csv': {
        const arr = this.toArray(pipeInput);
        if (arr.length === 0) return [];
        const first = arr[0] as Record<string, PSValue>;
        const headers = Object.keys(first);
        const lines: string[] = [];
        if (!(named['notypeinformation'] === true)) lines.push('#TYPE Hashtable');
        lines.push(headers.map(h => `"${h}"`).join(','));
        for (const row of arr) {
          const r = row as Record<string, PSValue>;
          lines.push(headers.map(h => `"${psValueToString(r[h] ?? '')}"`).join(','));
        }
        return lines;
      }
      case 'convertfrom-csv': {
        const lines = this.toArray(pipeInput).map(v => psValueToString(v));
        if (lines.length < 2) return [];
        const headers = parseCsvLine(lines[0]);
        const rows: Record<string, PSValue>[] = [];
        for (let i = 1; i < lines.length; i++) {
          const cells = parseCsvLine(lines[i]);
          const obj: Record<string, PSValue> = {};
          headers.forEach((h, j) => obj[h] = cells[j] ?? '');
          rows.push(obj);
        }
        return rows;
      }

      // ── Get-Member ────────────────────────────────────────────────────────
      case 'get-member': {
        const input = this.toArray(pipeInput);
        if (input.length === 0) return [];
        const sample = input[0] as Record<string, PSValue>;
        const filter = named['membertype'] ? psValueToString(named['membertype']).toLowerCase() : null;
        const out: Record<string, PSValue>[] = [];
        for (const key of Object.keys(sample)) {
          const type = typeof sample[key] === 'function' ? 'Method' : 'Property';
          if (filter && type.toLowerCase() !== filter) continue;
          out.push({ Name: key, MemberType: type, Definition: `${typeof sample[key]} ${key}` });
        }
        return out;
      }

      // ── No-op / stubs ─────────────────────────────────────────────────────
      case 'write-progress':
      case 'write-debug':
      case 'write-information':
      case 'out-file':
      case 'out-printer':
        return null;

      default:
        throw new PSRuntimeError(
          `The term '${name}' is not recognized as a cmdlet, function, or operable program.`);
    }
  }

  /** Returns true when a command-name node is really a value, not a cmdlet name. */
  private isPureValueNode(node: PSExpression, env?: PSEnvironment): boolean {
    switch (node.type) {
      case 'ArrayExpression':
      case 'HashtableExpression':
      case 'RangeExpression':
      case 'BinaryExpression':
      case 'UnaryExpression':
      case 'MemberExpression':
      case 'StaticMemberExpression':
      case 'IndexExpression':
      case 'InvocationExpression':
      case 'CastExpression':
      case 'SubExpression':
      case 'PipelineExpression':
      case 'ScriptBlock':
        return true;
      case 'LiteralExpression': {
        const k = (node as PSLiteralExpression).kind;
        // Quoted strings ("…" / '…') are values, not cmdlet names.
        // Bare words come through as CommandExpression, not LiteralExpression.
        return k === 'number' || k === 'boolean' || k === 'null'
            || k === 'string' || k === 'expandable';
      }
      case 'VariableExpression': {
        // Variables always evaluate to their value, not as cmdlet invocations.
        // Use `& $cmd` or Invoke-Expression to invoke a variable as a command.
        return true;
      }
      default:
        return false;
    }
  }

  private toArray(val: PSValue): PSValue[] {
    if (val === null || val === undefined) return [];
    return Array.isArray(val) ? val : [val];
  }

  private stringArgs(pos: PSValue[], named: Record<string, PSValue>, key: string): string[] {
    const src = named[key] ?? (pos.length > 0 ? pos : null);
    if (!src) return [];
    return (Array.isArray(src) ? src : [src]).map(v => psValueToString(v));
  }
}

// ─── Static type map ─────────────────────────────────────────────────────────

const STATIC_TYPES: Record<string, Record<string, PSValue>> = {
  math: {
    pi:    Math.PI,
    e:     Math.E,
    abs:   (x: PSValue) => Math.abs(x as number),
    ceil:  (x: PSValue) => Math.ceil(x as number),
    floor: (x: PSValue) => Math.floor(x as number),
    round: (x: PSValue, d?: PSValue) =>
      d !== undefined ? parseFloat((x as number).toFixed(d as number)) : Math.round(x as number),
    sqrt:  (x: PSValue) => Math.sqrt(x as number),
    pow:   (b: PSValue, e: PSValue) => Math.pow(b as number, e as number),
    min:   (a: PSValue, b: PSValue) => Math.min(a as number, b as number),
    max:   (a: PSValue, b: PSValue) => Math.max(a as number, b as number),
  } as Record<string, PSValue>,
};
STATIC_TYPES['system.math'] = STATIC_TYPES['math'];

// ─── Helper functions for built-in cmdlets ──────────────────────────────────

/** Minimal PowerShell-style Get-Date -Format implementation. */
function formatDate(d: Date, fmt: string): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  // Order matters: longer tokens first so yyyy is matched before yy, MM before M, etc.
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/yy/g,   String(d.getFullYear()).slice(-2))
    .replace(/MM/g,   pad2(d.getMonth() + 1))
    .replace(/dd/g,   pad2(d.getDate()))
    .replace(/HH/g,   pad2(d.getHours()))
    .replace(/mm/g,   pad2(d.getMinutes()))
    .replace(/ss/g,   pad2(d.getSeconds()))
    .replace(/fff/g,  pad3(d.getMilliseconds()));
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a single CSV line, handling "quoted,commas" and escaped "" quotes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
