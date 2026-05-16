/**
 * PSRuntime — Unified PowerShell execution engine.
 *
 * Replaces the split between PSInterpreter (language features only) and
 * PowerShellExecutor (Windows cmdlets only). This single engine:
 *   - Tokenizes and parses PowerShell source via the existing Lexer + Parser
 *   - Walks the AST (all statement and expression types)
 *   - Dispatches cmdlet invocations through a CmdletRegistry (plugin pattern)
 *   - Receives system resources via PSProviders (dependency injection)
 *
 * Sections:
 *   1. Types, signals, and setup
 *   2. Expression evaluators
 *   3. Statement executors
 *   4. Pipeline engine + cmdlet dispatch
 *   5. Helper utilities
 */

import { PSLexer }  from '@/powershell/lexer/PSLexer';
import { PSParser } from '@/powershell/parser/PSParser';
import { PS_OPERATOR_PARAMS } from '@/powershell/lexer/PSToken';
import { PSEnvironment, PSValue, seedBuiltins } from '@/powershell/runtime/PSEnvironment';
import { expandString, psValueToString } from '@/powershell/runtime/PSExpansion';
import { CmdletRegistry } from '@/powershell/runtime/PSCmdletRegistry';
import { NULL_PROVIDERS } from '@/powershell/providers/NullProviders';
import { formatDefault } from '@/network/devices/windows/PSPipeline';
import type { PSProviders } from '@/powershell/providers/PSProviders';
import type { CmdletContext, IRuntimeRef } from '@/powershell/cmdlets/CmdletContext';
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
  PSClassDefinition, PSMethodDefinition, PSPropertyDeclaration,
  PSBreakStatement, PSContinueStatement, PSTrapStatement,
} from '@/powershell/parser/PSASTNode';

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1 — Types, signals, and setup
// ═══════════════════════════════════════════════════════════════════════════════

/** Thrown by return statements to unwind the call stack. */
export class ReturnSignal   { constructor(public readonly value: PSValue) {} }
/** Thrown by break statements inside loops. Carries optional label for labeled loops. */
export class BreakSignal    { constructor(public readonly label?: string) {} }
/** Thrown by continue statements inside loops. Carries optional label for labeled loops. */
export class ContinueSignal { constructor(public readonly label?: string) {} }

/** Runtime error (unrecognised cmdlet, type mismatch, etc.). */
export class PSRuntimeError extends Error {
  constructor(message: string) { super(message); this.name = 'PSRuntimeError'; }
}

// ─── Static type map ([math], [system.math]) ─────────────────────────────────

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

  regex: {
    // [regex]::Match(input, pattern) → match object with .Value / .Groups
    match:   (input: PSValue, pattern: PSValue) => {
      const m = String(input).match(new RegExp(String(pattern)));
      if (!m) return { Value: '', Success: false, Groups: [] as PSValue[] } as unknown as PSValue;
      return { Value: m[0], Success: true, Groups: m as unknown as PSValue } as unknown as PSValue;
    },
    // [regex]::Matches(input, pattern) → array of match objects
    matches: (input: PSValue, pattern: PSValue) => {
      const all = [...String(input).matchAll(new RegExp(String(pattern), 'g'))];
      return all.map(m => ({ Value: m[0], Index: m.index ?? 0 } as unknown as PSValue));
    },
    // [regex]::Replace(input, pattern, replacement|evaluator)
    replace: (input: PSValue, pattern: PSValue, replacement: PSValue) => {
      if (typeof replacement === 'function') {
        return String(input).replace(new RegExp(String(pattern), 'g'), (match) => {
          const result = (replacement as (...a: PSValue[]) => PSValue)(
            { Value: match, Groups: [match] as PSValue[] } as unknown as PSValue
          );
          return String(result ?? '');
        });
      }
      return String(input).replace(new RegExp(String(pattern), 'g'), String(replacement));
    },
    // [regex]::IsMatch(input, pattern) → boolean
    ismatch: (input: PSValue, pattern: PSValue) =>
      new RegExp(String(pattern)).test(String(input)),
    // [regex]::Escape(str) → escaped pattern
    escape:  (s: PSValue) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    // [regex]::Split(input, pattern) → string[]
    split:   (input: PSValue, pattern: PSValue) =>
      String(input).split(new RegExp(String(pattern))) as PSValue[],
  } as Record<string, PSValue>,

  guid: {
    // [guid]::NewGuid() → UUID string
    newguid: () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }) as PSValue;
    },
    // [guid]::Parse(s) → same string (we represent GUIDs as strings)
    parse: (s: PSValue) => String(s) as PSValue,
    empty: '00000000-0000-0000-0000-000000000000' as PSValue,
  } as Record<string, PSValue>,

  datetime: {
    // [datetime]::Now
    now:     new Date() as unknown as PSValue,
    // [datetime]::UtcNow
    utcnow:  new Date() as unknown as PSValue,
    // [datetime]::Today
    today:   (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })() as unknown as PSValue,
    // [datetime]::Parse(s) → Date
    parse:   (s: PSValue) => new Date(String(s)) as unknown as PSValue,
    // [datetime]::ParseExact(s, fmt, culture) → Date (simplified)
    parseexact: (s: PSValue) => new Date(String(s)) as unknown as PSValue,
    minvalue: new Date(0) as unknown as PSValue,
    maxvalue: new Date(8640000000000000) as unknown as PSValue,
  } as Record<string, PSValue>,

  'system.io.path': {
    combine:              (...parts: PSValue[]) => parts.map(String).join('\\') as PSValue,
    getfilename:          (p: PSValue) => { const s = String(p); return s.split(/[\\/]/).pop() ?? s; },
    getfilenamewithoutextension: (p: PSValue) => {
      const name = String(p).split(/[\\/]/).pop() ?? '';
      const dot = name.lastIndexOf('.');
      return (dot > 0 ? name.slice(0, dot) : name) as PSValue;
    },
    getextension:         (p: PSValue) => { const s = String(p); const d = s.lastIndexOf('.'); return (d >= 0 ? s.slice(d) : '') as PSValue; },
    getdirectoryname:     (p: PSValue) => { const s = String(p); const parts = s.split(/[\\/]/); parts.pop(); return parts.join('\\') as PSValue; },
    getfullpath:          (p: PSValue) => String(p) as PSValue,
    ispathrootd:          (p: PSValue) => /^[A-Za-z]:\\?$/.test(String(p)),
    gettemppath:          () => 'C:\\Windows\\Temp' as PSValue,
    gettempfilename:      () => `C:\\Windows\\Temp\\tmp${Math.random().toString(36).slice(2)}.tmp` as PSValue,
    directoryseparatorchar: '\\' as PSValue,
    pathseparator:         ';' as PSValue,
    altdirectoryseparatorchar: '/' as PSValue,
  } as Record<string, PSValue>,
} as Record<string, Record<string, PSValue>>;
STATIC_TYPES['system.math'] = STATIC_TYPES['math'];
STATIC_TYPES['system.text.regularexpressions.regex'] = STATIC_TYPES['regex'];
STATIC_TYPES['system.guid'] = STATIC_TYPES['guid'];
STATIC_TYPES['system.datetime'] = STATIC_TYPES['datetime'];
STATIC_TYPES['io.path'] = STATIC_TYPES['system.io.path'];
STATIC_TYPES['path'] = STATIC_TYPES['system.io.path'];

// ─── Collection type factories ────────────────────────────────────────────────

const makeArrayList = (): PSValue => {
  const arr: PSValue[] = [];
  (arr as Record<string, PSValue>)['__list__'] = arr as unknown as PSValue;
  Object.defineProperty(arr, 'Count', { get: () => arr.length, enumerable: false, configurable: true });
  return arr as unknown as PSValue;
};

const makeQueue = (): PSValue => {
  const items: PSValue[] = [];
  const q: Record<string, PSValue> = { __type__: 'Queue', __items__: items as PSValue[] };
  Object.defineProperty(q, 'Count', { get: () => items.length, enumerable: false, configurable: true });
  return q as unknown as PSValue;
};

const makeStack = (): PSValue => {
  const items: PSValue[] = [];
  const s: Record<string, PSValue> = { __type__: 'Stack', __items__: items as PSValue[] };
  Object.defineProperty(s, 'Count', { get: () => items.length, enumerable: false, configurable: true });
  return s as unknown as PSValue;
};

const makeListGeneric = (): PSValue => makeArrayList();

const COLLECTION_TYPES = ['arraylist', 'system.collections.arraylist',
  'list', 'system.collections.generic.list[string]', 'system.collections.generic.list[int]',
  'system.collections.generic.list[object]'];
const QUEUE_TYPES = ['queue', 'system.collections.queue'];
const STACK_TYPES = ['stack', 'system.collections.stack'];

for (const t of COLLECTION_TYPES) {
  STATIC_TYPES[t] = { new: makeListGeneric } as Record<string, PSValue>;
}
for (const t of QUEUE_TYPES) {
  STATIC_TYPES[t] = { new: makeQueue } as Record<string, PSValue>;
}
for (const t of STACK_TYPES) {
  STATIC_TYPES[t] = { new: makeStack } as Record<string, PSValue>;
}

// ═══════════════════════════════════════════════════════════════════════════════

export class PSRuntime {
  private readonly lexer   = new PSLexer();
  private readonly parser  = new PSParser();
  readonly global: PSEnvironment;
  private outputLines: string[] = [];

  /** AST cache: same source code → reuse the parsed program. */
  private readonly astCache = new Map<string, PSProgram>();
  /** Hard upper bound on the AST cache; LRU-ish eviction once we cross it. */
  private static readonly AST_CACHE_LIMIT = 256;

  /**
   * Render a top-level statement result into outputLines. Arrays of plain
   * PSObjects go through the table formatter (formatDefault) so they
   * display in canonical Format-Table layout instead of the
   * `Key=Value; ...` hashtable form psValueToString produces.
   */
  private renderValue(result: PSValue): void {
    if (Array.isArray(result)) {
      // Array of plain objects (all elements are non-null records with at
      // least one string-keyed field) → table format.
      const arr = result as PSValue[];
      if (arr.length > 0 && arr.every(v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date))) {
        const formatted = formatDefault(arr as Array<Record<string, unknown>>);
        if (formatted) this.outputLines.push(formatted);
        return;
      }
      for (const item of arr) this.outputLines.push(psValueToString(item));
      return;
    }
    // A single plain object (e.g. Measure-Object's result, Get-Item, a
    // custom [pscustomobject]) should render through the same default
    // formatter — ≤4 props → table, >4 props → list — instead of the
    // inline `Key=Value; ...` form. Date instances are scalar; let them
    // fall through to psValueToString.
    if (result !== null && typeof result === 'object' && !Array.isArray(result)
        && !(result instanceof Date)
        && !this.isScriptBlock(result)
        && Object.keys(result as Record<string, unknown>).length > 0
        && !this.hasInternalSentinel(result as Record<string, unknown>)
        && this.allScalarValues(result as Record<string, unknown>)) {
      const formatted = formatDefault([result as Record<string, unknown>]);
      if (formatted) { this.outputLines.push(formatted); return; }
    }
    this.outputLines.push(psValueToString(result));
  }

  /** True when an object carries a runtime sentinel key (collection
   *  wrappers, queues, stacks) that must not be table-formatted. */
  private hasInternalSentinel(obj: Record<string, unknown>): boolean {
    return '__list__' in obj || '__type__' in obj || '__items__' in obj
        || 'SecureString' in obj;
  }

  /** Only auto-table/list a single object when every value is a scalar
   *  (string/number/bool/null/Date). Objects with nested records/arrays
   *  (Get-Acl's Access, etc.) keep the richer psValueToString rendering. */
  private allScalarValues(obj: Record<string, unknown>): boolean {
    for (const v of Object.values(obj)) {
      if (v === null || v === undefined) continue;
      const t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') continue;
      if (v instanceof Date) continue;
      // Arrays render through renderObjectShort as `{a, b, c}` — that is a
      // legitimate table cell, so allow them. Nested non-Date objects still
      // disqualify the row (Get-Acl's Access keeps Format-List rendering).
      if (Array.isArray(v)) continue;
      return false;
    }
    return true;
  }

  /** Parse + cache. Identical source strings re-use the same PSProgram. */
  private parseCached(code: string): PSProgram {
    const hit = this.astCache.get(code);
    if (hit) {
      // Refresh recency by re-inserting at the end of the iteration order.
      this.astCache.delete(code);
      this.astCache.set(code, hit);
      return hit;
    }
    const tokens = this.lexer.tokenize(code);
    const ast    = this.parser.parse(tokens);
    if (this.astCache.size >= PSRuntime.AST_CACHE_LIMIT) {
      // Drop the oldest entry (first key in iteration order).
      const oldest = this.astCache.keys().next().value;
      if (oldest !== undefined) this.astCache.delete(oldest);
    }
    this.astCache.set(code, ast);
    return ast;
  }

  /** User-defined functions survive between execute() calls. */
  private readonly functions = new Map<string, { block: PSScriptBlock; isFilter: boolean }>();

  /** User-defined PowerShell classes. */
  private readonly userClasses = new Map<string, PSClassDefinition>();

  /** Error objects collected by emitError — merged into output when 2>&1 is active. */
  private errorObjects: PSValue[] = [];

  /** Script registry for dot-sourcing simulated scripts (path → PS source). */
  private readonly scriptRegistry = new Map<string, string>();

  /** Cmdlet registry — maps names/aliases → ICmdlet implementations. */
  private readonly registry: CmdletRegistry;

  /** Injected system providers (null values = provider unavailable). */
  readonly providers: PSProviders;

  /** Optional hook for $env: variable resolution (set by the host shell). */
  testPathHook: ((path: string) => boolean) | null = null;

  /** Optional hook for Test-Path resolution (set by the host shell). */
  envVarHook: ((name: string) => string | null) | null = null;

  constructor(
    registry: CmdletRegistry,
    providers: PSProviders = NULL_PROVIDERS,
    globalEnv?: PSEnvironment,
  ) {
    this.registry  = registry;
    this.providers = providers;
    this.global    = globalEnv ?? new PSEnvironment();
    if (!globalEnv) {
      seedBuiltins(this.global);
      this.global.set('__drives__', {
        c:        { Name: 'C',        Root: 'C:\\',   Used: 0, Free: 0 },
        d:        { Name: 'D',        Root: 'D:\\',   Used: 0, Free: 0 },
        env:      { Name: 'Env',      Root: '',       Used: 0, Free: 0 },
        variable: { Name: 'Variable', Root: '',       Used: 0, Free: 0 },
        function: { Name: 'Function', Root: '',       Used: 0, Free: 0 },
        hklm:     { Name: 'HKLM',     Root: 'HKLM:\\', Used: 0, Free: 0 },
        hkcu:     { Name: 'HKCU',     Root: 'HKCU:\\', Used: 0, Free: 0 },
      } as Record<string, PSValue>);
    }
  }

  /** Register a script file's content for dot-sourcing simulation. */
  registerScript(path: string, content: string): void {
    this.scriptRegistry.set(path.toLowerCase(), content);
  }

  /**
   * Canonical command names + aliases for Tab-completion. Pulls straight
   * from the live registry so new cmdlets are completable without
   * touching a static list (open/closed).
   */
  listCommandNames(): string[] {
    const out = new Set<string>();
    for (const c of this.registry.cmdlets()) {
      out.add(c.displayName ?? this.titleCase(c.name));
      for (const a of c.aliases) out.add(a);
    }
    return [...out].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  private titleCase(raw: string): string {
    return raw.split('-')
      .map(seg => seg
        ? seg.replace(/(^|[^a-z])([a-z])/g, (_, p: string, ch: string) => p + ch.toUpperCase())
        : seg)
      .join('-');
  }

  /** Variable names currently in scope, for `$x<Tab>` completion. */
  listVariableNames(): string[] {
    const snap = this.global.snapshot();
    return Object.keys(snap);
  }

  /**
   * Declared parameter names for a cmdlet (resolved by name or alias),
   * for `-<Tab>` completion. Pulls ICmdlet.parameters when the cmdlet
   * declares it (open/closed — no central table). Always returns [] for
   * unknown commands; the sub-shell layers the common parameters on top.
   */
  getCommandParameters(name: string): string[] {
    const cmdlet = this.registry.resolve(name.toLowerCase());
    const declared = cmdlet?.parameters;
    return declared ? [...declared] : [];
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Execute a PowerShell script. Pipeline output is collected and returned as a string. */
  execute(code: string): string {
    this.outputLines = [];
    const ast = this.parseCached(code);
    this.execTopLevel(ast.body.statements, this.global);
    return this.outputLines.join('\n');
  }

  private execTopLevel(statements: PSStatement[], env: PSEnvironment): void {
    // Pre-scan for trap handlers so they apply to the whole statement list
    const traps: PSTrapStatement[] = [];
    const stmts: PSStatement[] = [];
    for (const s of statements) {
      if (s.type === 'TrapStatement') traps.push(s as PSTrapStatement);
      else stmts.push(s);
    }

    const runOne = (stmt: PSStatement) => {
      const before = this.outputLines.length;
      const result = this.execStatement(stmt, env);
      const emitted = this.outputLines.length > before;
      if (!emitted && result !== null && result !== undefined
          && stmt.type !== 'AssignmentStatement'
          && stmt.type !== 'FunctionDefinition') {
        this.renderValue(result);
      }
    };

    if (traps.length === 0) {
      for (const stmt of stmts) runOne(stmt);
      return;
    }

    for (const stmt of stmts) {
      try {
        runOne(stmt);
      } catch (e) {
        if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) throw e;
        const trap = traps[0];
        // Run trap body in same scope so variable assignments are visible to the caller
        env.set('_', e instanceof Error ? e : new Error(String(e)));
        try {
          this.execScriptBlock(trap.body, env);
        } catch (te) {
          if (te instanceof ContinueSignal && !te.label) continue;
          if (te instanceof BreakSignal    && !te.label) return;
          throw te;
        }
      }
    }
  }

  /**
   * REPL variant: bare expressions that produce a value without explicitly
   * writing to the pipeline (e.g. `$x`, `2+3`) are echoed to output.
   */
  executeInteractive(code: string): string {
    this.outputLines = [];
    const ast = this.parseCached(code);
    // Reuse execTopLevel so trap handlers work in interactive mode too
    this.execTopLevelInteractive(ast.body.statements, this.global);
    return this.outputLines.join('\n');
  }

  private execTopLevelInteractive(statements: PSStatement[], env: PSEnvironment): void {
    const traps: PSTrapStatement[] = [];
    const stmts: PSStatement[] = [];
    for (const s of statements) {
      if (s.type === 'TrapStatement') traps.push(s as PSTrapStatement);
      else stmts.push(s);
    }

    const runOne = (stmt: PSStatement) => {
      const wasEmpty = this.outputLines.length;
      const result = this.execStatement(stmt, env);
      const didOutput = this.outputLines.length > wasEmpty;
      if (!didOutput && stmt.type !== 'AssignmentStatement' && result !== null && result !== undefined) {
        this.renderValue(result);
      }
    };

    if (traps.length === 0) {
      for (const stmt of stmts) runOne(stmt);
      return;
    }

    for (const stmt of stmts) {
      try {
        runOne(stmt);
      } catch (e) {
        if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) throw e;
        const trap = traps[0];
        env.set('_', e instanceof Error ? e : new Error(String(e)));
        try {
          this.execScriptBlock(trap.body, env);
        } catch (te) {
          if (te instanceof ContinueSignal && !te.label) continue;
          if (te instanceof BreakSignal    && !te.label) return;
          throw te;
        }
      }
    }
  }

  /** Execute code and return the last produced PSValue (without stringification). Used by IEX. */
  executeForValue(code: string): PSValue {
    const tokens = this.lexer.tokenize(code);
    const ast    = this.parser.parse(tokens);
    let last: PSValue = null;
    for (const stmt of ast.body.statements) {
      last = this.execStatement(stmt, this.global);
    }
    return last;
  }

  getVariable(name: string): PSValue { return this.global.get(name); }
  setVariable(name: string, value: PSValue): void { this.global.set(name, value); }

  // ── Program / StatementList ────────────────────────────────────────────────

  private execProgram(node: PSProgram, env: PSEnvironment): PSValue {
    return this.execStatementList(node.body, env);
  }

  execStatementList(node: PSStatementList, env: PSEnvironment): PSValue {
    // Pre-scan for trap handlers
    const traps: PSTrapStatement[] = [];
    const stmts: PSStatement[] = [];
    for (const s of node.statements) {
      if (s.type === 'TrapStatement') traps.push(s as PSTrapStatement);
      else stmts.push(s);
    }

    if (traps.length === 0) {
      let last: PSValue = null;
      for (const stmt of stmts) last = this.execStatement(stmt, env);
      return last;
    }

    // Slow path: execute with trap handlers
    let last: PSValue = null;
    for (const stmt of stmts) {
      try {
        last = this.execStatement(stmt, env);
      } catch (e) {
        if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) throw e;
        const trap = traps[0];
        env.set('_', e instanceof Error ? e : new Error(String(e)));
        try {
          this.execScriptBlock(trap.body, env);
          // Trap body finished normally → continue to next statement
        } catch (te) {
          if (te instanceof ContinueSignal && !te.label) continue;
          if (te instanceof BreakSignal    && !te.label) break;
          throw te;
        }
      }
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
      case 'ClassDefinition':     return this.execClassDef(node as PSClassDefinition, env);
      case 'ReturnStatement':     return this.execReturn(node as PSReturnStatement, env);
      case 'BreakStatement':      throw new BreakSignal((node as PSBreakStatement).label ?? undefined);
      case 'ContinueStatement':   throw new ContinueSignal((node as PSContinueStatement).label ?? undefined);
      case 'ThrowStatement':      return this.execThrow(node as PSThrowStatement, env);
      case 'TrapStatement':       return null; // collected by execStatementList
      default:                    return null;
    }
  }

  // ── Assignment ─────────────────────────────────────────────────────────────

  private execAssignment(node: PSAssignmentStatement, env: PSEnvironment): PSValue {
    const rhs = this.evalExpr(node.value, env);

    if (node.target.type === 'IndexExpression' || node.target.type === 'MemberExpression') {
      const result = this.computeAssignResult(node, rhs, env);
      this.writeTarget(node.target, result, env);
      return result;
    }

    const target = node.target as PSVariableExpression;
    const varName = target.varName ?? (target as unknown as { name: string }).name;
    const scope = target.scope;

    const writeVar = (name: string, val: PSValue) => {
      if (scope === 'env') {
        this.providers.environment?.set(name, psValueToString(val));
        return;
      }
      if (scope === 'global' || scope === 'script') env.setGlobal(name, val);
      else env.set(name, val);
    };
    const updateVar = (name: string, val: PSValue) => {
      if (scope === 'env') {
        this.providers.environment?.set(name, psValueToString(val));
        return;
      }
      if (scope === 'global' || scope === 'script') env.setGlobal(name, val);
      else env.update(name, val);
    };

    if (node.operator === '=') { writeVar(varName, rhs); return rhs; }

    const readCurrent = (): PSValue => {
      if (scope === 'env') return this.providers.environment?.get(varName) ?? '';
      if (scope === 'global' || scope === 'script') return env.getGlobal(varName);
      return env.get(varName);
    };
    const current = readCurrent() ?? 0;
    const result = this.applyCompound(node.operator, current, rhs);
    updateVar(varName, result);
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

  private computeAssignResult(node: PSAssignmentStatement, rhs: PSValue, env: PSEnvironment): PSValue {
    if (node.operator === '=') return rhs;
    const current = this.evalExpr(node.target, env);
    return this.applyCompound(node.operator, current, rhs);
  }

  private writeTarget(target: PSIndexExpression | PSMemberExpression, value: PSValue, env: PSEnvironment): void {
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
    const container = this.evalExpr(target.object, env);
    const memberName = typeof target.member === 'string'
      ? target.member
      : psValueToString(this.evalExpr(target.member as PSExpression, env));
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      const rec = container as Record<string, PSValue>;
      // Validate against class property attributes
      const typeName = rec['__type__'];
      if (typeof typeName === 'string') {
        const cls = this.userClasses.get(typeName.toLowerCase());
        if (cls) this.validateClassProperty(cls, memberName, value);
      }
      rec[memberName] = value;
      return;
    }
    throw new PSRuntimeError(`Cannot assign to property '${memberName}' of non-object value`);
  }

  private execPipelineStmt(node: PSPipelineStatement, env: PSEnvironment): PSValue {
    const result = this.execPipeline(node.pipeline, env);
    for (const redir of node.redirections) {
      if (!redir.target) continue;
      const filePath = psValueToString(this.evalExpr(redir.target, env));
      if (!filePath) continue;
      const fs = this.providers.filesystem;
      if (!fs) continue;
      const content = Array.isArray(result)
        ? (result as PSValue[]).map(v => psValueToString(v)).join('\n')
        : psValueToString(result);
      if (redir.op === '>>' || redir.op === '2>>' || redir.op === '*>>') {
        fs.appendFile(filePath, content);
      } else {
        fs.writeFile(filePath, content);
      }
    }
    return result;
  }

  // ── ScriptBlock execution ──────────────────────────────────────────────────

  execScriptBlock(block: PSScriptBlock, env: PSEnvironment): PSValue {
    // Note: ReturnSignal must propagate up so that `return` inside an if/while
    // /try inside a function/scriptblock exits the *enclosing* function, not
    // just the inner block. Only invokeScriptBlock (the call boundary) catches.
    if (block.beginBlock)   this.execStatementList(block.beginBlock,   env);
    if (block.processBlock) this.execStatementList(block.processBlock, env);
    if (block.endBlock)     this.execStatementList(block.endBlock,     env);
    if (block.body)         return this.execStatementList(block.body,  env);
    return null;
  }

  /**
   * Dot-source a script block: run every body statement in `env` (no child
   * scope) and aggregate emitted values, matching real PowerShell where every
   * statement in a script contributes to the output pipeline.
   */
  private dotSourceScriptBlock(block: PSScriptBlock, env: PSEnvironment): PSValue {
    if (block.beginBlock)   this.execStatementList(block.beginBlock,   env);
    if (block.processBlock) this.execStatementList(block.processBlock, env);
    if (block.endBlock)     this.execStatementList(block.endBlock,     env);
    if (!block.body) return null;
    return this.aggregateCaptured(this.runBlockCapture(block.body, env));
  }

  /**
   * Build a dynamic `[Environment]` / `[System.Environment]` static type that
   * delegates to the device-backed environment provider. Constructed per call
   * (cheap, just closures) so it always reflects the current provider state.
   */
  private buildEnvironmentType(): Record<string, PSValue> {
    const provider = this.providers.environment;
    const lookup = (name: string): string => {
      if (provider) {
        const v = provider.get(name);
        if (v !== undefined && v !== null) return String(v);
      }
      if (this.envVarHook) {
        const v = this.envVarHook(name);
        if (v !== null) return v;
      }
      return process.env[name.toUpperCase()] ?? '';
    };
    // Property-style entries are eager scalars (computed at access time so the
    // freshest provider state is used). Method-style entries are functions
    // that the runtime invokes through InvocationExpression.
    return {
      username:               lookup('USERNAME') as PSValue,
      machinename:            lookup('COMPUTERNAME') as PSValue,
      userdomainname:         (lookup('USERDOMAIN') || lookup('COMPUTERNAME')) as PSValue,
      osversion:              { Platform: 'Win32NT', Version: '10.0.22631' } as Record<string, PSValue>,
      newline:                '\r\n' as PSValue,
      currentdirectory:       'C:\\' as PSValue,
      processorcount:         (Number(lookup('NUMBER_OF_PROCESSORS')) || 1) as PSValue,
      tickcount:              Date.now() as PSValue,
      is64bitoperatingsystem: true as PSValue,
      is64bitprocess:         true as PSValue,
      getenvironmentvariable: (name: PSValue, _target?: PSValue) => lookup(String(name)),
      setenvironmentvariable: (name: PSValue, value: PSValue, _target?: PSValue) => {
        const n = String(name);
        if (value === null || value === undefined) provider?.remove(n);
        else provider?.set(n, String(value));
        return null;
      },
      getenvironmentvariables: () => {
        const out: Record<string, PSValue> = {};
        for (const e of (provider?.list() ?? [])) out[e.Name] = e.Value;
        return out;
      },
      getfolderpath: (folder: PSValue) => {
        const which = String(folder).toLowerCase();
        if (which.includes('userprofile') || which.includes('user'))    return lookup('USERPROFILE');
        if (which.includes('appdata'))                                  return lookup('APPDATA');
        if (which.includes('local'))                                    return lookup('LOCALAPPDATA');
        if (which.includes('windows') || which.includes('system'))      return lookup('SYSTEMROOT');
        if (which.includes('program'))                                  return lookup('PROGRAMFILES');
        return '';
      },
    };
  }

  /** Reduce captured statement values into a single PSValue (null / scalar / array). */
  private aggregateCaptured(captured: PSValue[]): PSValue {
    if (captured.length === 0) return null;
    return captured.length === 1 ? captured[0] : captured;
  }

  invokeScriptBlock(
    block: PSScriptBlock,
    namedArgs: Record<string, PSValue>,
    positionalArgs: PSValue[],
    parentEnv: PSEnvironment,
    pipelineInput?: PSValue,
  ): PSValue {
    // If the ScriptBlock was created via GetNewClosure(), inject the captured
    // variables into a new scope that sits between parentEnv and childEnv.
    const closure = (block as unknown as Record<string, unknown>).__closure__;
    let effectiveParent = parentEnv;
    if (closure && typeof closure === 'object') {
      const closureEnv = parentEnv.createChild();
      for (const [k, v] of Object.entries(closure as Record<string, PSValue>)) {
        closureEnv.set(k, v);
      }
      effectiveParent = closureEnv;
    }
    const childEnv = effectiveParent.createChild();

    if (pipelineInput !== undefined) {
      childEnv.set('_',      pipelineInput);
      childEnv.set('PSItem', pipelineInput);
    }

    // Always expose $args (all positional args not consumed by param block)
    const remainingArgs = [...positionalArgs];

    if (block.paramBlock) {
      block.paramBlock.parameters.forEach(p => {
        const pname = p.name.varName ?? p.name.name;
        const pkey  = pname.toLowerCase();
        if (namedArgs[pkey] !== undefined) {
          childEnv.set(pname, namedArgs[pkey]);
        } else if (remainingArgs.length > 0) {
          childEnv.set(pname, remainingArgs.shift()!);
        } else if (p.defaultValue) {
          childEnv.set(pname, this.evalExpr(p.defaultValue, parentEnv));
        } else {
          childEnv.set(pname, null);
        }
      });
    }

    // $args contains positional args not consumed by declared parameters
    childEnv.set('args', remainingArgs);

    try {
      if (block.beginBlock)   this.execStatementList(block.beginBlock,   childEnv);
      if (block.processBlock) this.execStatementList(block.processBlock, childEnv);
      if (block.endBlock)     this.execStatementList(block.endBlock,     childEnv);
      if (block.body) return this.aggregateCaptured(this.runBlockCapture(block.body, childEnv));
      return null;
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2 — Expression evaluators
  // ═══════════════════════════════════════════════════════════════════════════

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
      case 'PipelineExpression': {
        const pe = node as PSPipelineExpression;
        const has2to1 = pe.redirections?.some(r => r.op === '2>&1');
        if (has2to1) {
          const savedErrors = this.errorObjects;
          this.errorObjects = [];
          const pipeResult = this.execPipeline(pe.pipeline, env);
          const errors = this.errorObjects;
          this.errorObjects = savedErrors;
          const items = Array.isArray(pipeResult) ? pipeResult
            : pipeResult !== null && pipeResult !== undefined ? [pipeResult] : [];
          const merged = [...items, ...errors];
          // Always return array when 2>&1 merges streams (consistent with collection semantics)
          return merged.length === 0 ? null : merged;
        }
        return this.execPipeline(pe.pipeline, env);
      }
      case 'ScriptBlock':              return node as unknown as PSValue;
      case 'AssignmentStatement':      return this.execAssignment(node as unknown as PSAssignmentStatement, env);
      case 'TypeLiteral':              return `[${(node as unknown as { typeName: string }).typeName}]`;
      case 'StatementExpression':      return this.execStatement((node as unknown as { stmt: PSStatement }).stmt, env);
      default:                         return null;
    }
  }

  private evalLiteral(node: PSLiteralExpression, env: PSEnvironment): PSValue {
    if (node.kind === 'expandable') return this.expandDoubleQuotedString(node.value as string, env);
    return node.value as PSValue;
  }

  private expandDoubleQuotedString(raw: string, env: PSEnvironment): string {
    return expandString(
      raw,
      env,
      (code) => {
        const ast = this.parseCached(code);
        return this.execProgram(ast, env);
      },
      (token, scope) => this.resolveExpansionVar(token, scope),
    );
  }

  /**
   * Resolve a variable token from inside a double-quoted string. Honors the
   * same scope qualifiers as $name VariableExpression evaluation so that
   * "$env:COMPUTERNAME" and "$($env:USERNAME)" both go through the device's
   * environment provider rather than falling back to process.env.
   */
  private resolveExpansionVar(token: string, env: PSEnvironment): PSValue {
    const colon = token.indexOf(':');
    if (colon === -1) {
      const val = env.get(token);
      return val === undefined ? null : val;
    }
    const scope   = token.slice(0, colon).toLowerCase();
    const varName = token.slice(colon + 1);
    if (scope === 'env') {
      const fromProvider = this.providers.environment?.get(varName);
      if (fromProvider !== undefined) return fromProvider;
      if (this.envVarHook) {
        const v = this.envVarHook(varName);
        if (v !== null) return v;
      }
      return process.env[varName.toUpperCase()] ?? null;
    }
    if (scope === 'global' || scope === 'script') return env.getGlobal(varName);
    if (scope === 'local')                        return env.get(varName) ?? null;
    return env.get(varName) ?? null;
  }

  private evalVariable(node: PSVariableExpression, env: PSEnvironment): PSValue {
    const name = node.varName ?? node.name;

    if (node.scope === 'global') return env.getGlobal(name);
    if (node.scope === 'script') return env.getGlobal(name);
    if (node.scope === 'local') {
      const val = env.get(name);
      return val === undefined ? null : val;
    }
    if (node.scope === 'using') {
      const val = env.getGlobal(name);
      return val === undefined ? null : val;
    }
    if (node.scope === 'env') {
      // Prefer the environment provider when one is wired (device-backed).
      const fromProvider = this.providers.environment?.get(name);
      if (fromProvider !== undefined) return fromProvider;
      if (this.envVarHook) {
        const v = this.envVarHook(name);
        if (v !== null) return v;
      }
      return process.env[name.toUpperCase()] ?? null;
    }

    const val = env.get(name);
    return val === undefined ? null : val;
  }

  private evalBinary(node: PSBinaryExpression, env: PSEnvironment): PSValue {
    const op = node.operator.toLowerCase();

    if (op === '-and') {
      return this.isTruthy(this.evalExpr(node.left, env))
        ? this.evalExpr(node.right, env) : false;
    }
    if (op === '-or') {
      const l = this.evalExpr(node.left, env);
      return this.isTruthy(l) ? l : this.evalExpr(node.right, env);
    }

    // -is / -isnot / -as: the right side is [TypeName] which the parser wraps as
    // CastExpression { targetType } or TypeLiteral { typeName } — extract the type name directly.
    if (op === '-is' || op === '-isnot' || op === '-as') {
      const left = this.evalExpr(node.left, env);
      const typeName = this.extractTypeName(node.right);
      if (op === '-is')    return this.psIs(left, `[${typeName}]`);
      if (op === '-isnot') return !this.psIs(left, `[${typeName}]`);
      return this.psCast(left, typeName);
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

      case '-match':    return this.psMatch(String(left), String(right), false, env);
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
        const repl = args[1] ?? '';
        if (this.isScriptBlock(repl) || typeof repl === 'function') {
          const fn = typeof repl === 'function' ? repl as (...a: PSValue[]) => PSValue
            : (m: PSValue) => this.invokeScriptBlock(repl as PSScriptBlock, {}, [], env, m);
          return String(left).replace(new RegExp(String(args[0] ?? ''), 'gi'), (match) => {
            const matchObj = { Value: match, Groups: [match] as PSValue[], Length: match.length } as unknown as PSValue;
            return psValueToString(fn(matchObj));
          });
        }
        return String(left).replace(new RegExp(String(args[0] ?? ''), 'gi'), String(repl));
      }
      case '-creplace': {
        const args = Array.isArray(right) ? right : [right];
        return String(left).replace(new RegExp(String(args[0] ?? ''), 'g'), String(args[1] ?? ''));
      }
      case '-split': {
        const args = Array.isArray(right) ? right : [right];
        const parts = String(left).split(new RegExp(String(args[0] ?? '')));
        const limit = args[1] !== undefined ? Number(args[1]) : undefined;
        return limit !== undefined ? parts.slice(0, limit) : parts;
      }
      case '-join': return (Array.isArray(left) ? left : [left]).map(psValueToString).join(String(right));

      // -is / -isnot / -as handled above the switch (type extraction)

      default:
        throw new PSRuntimeError(`Unknown operator: ${op}`);
    }
  }

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

  private evalArray(node: PSArrayExpression, env: PSEnvironment): PSValue {
    const result: PSValue[] = [];
    for (const stmt of node.elements) {
      const val = this.execStatement(stmt, env);
      if (Array.isArray(val)) result.push(...val);
      else if (val !== null && val !== undefined) result.push(val);
    }
    return result;
  }

  private evalHashtable(node: PSHashtableExpression, env: PSEnvironment): PSValue {
    const result: Record<string, PSValue> = {};
    for (const pair of node.pairs) {
      const key = psValueToString(this.evalExpr(pair.key, env));
      result[key] = this.evalExpr(pair.value, env);
    }
    return result;
  }

  private evalSubExpr(node: PSSubExpressionExpression, env: PSEnvironment): PSValue {
    return this.execStatementList(node.body, env);
  }

  private evalRange(node: PSRangeExpression, env: PSEnvironment): PSValue {
    const start = this.evalExpr(node.start, env) as number;
    const end   = this.evalExpr(node.end,   env) as number;
    const arr: number[] = [];
    if (start <= end) for (let i = start; i <= end; i++) arr.push(i);
    else              for (let i = start; i >= end; i--) arr.push(i);
    return arr;
  }

  private evalMember(node: PSMemberExpression, env: PSEnvironment): PSValue {
    const obj    = this.evalExpr(node.object, env);
    const member = typeof node.member === 'string'
      ? node.member.toLowerCase()
      : psValueToString(this.evalExpr(node.member as PSExpression, env)).toLowerCase();

    // ScriptBlock.GetNewClosure() — needs env to capture variables at call site
    if (this.isScriptBlock(obj) && member === 'getnewclosure') {
      const block = obj as PSScriptBlock;
      const snapshot = env.snapshot();
      return () => {
        // Return a copy of the ScriptBlock tagged with the captured variable snapshot
        return { ...block, __closure__: snapshot } as unknown as PSValue;
      };
    }

    return this.getMember(obj, member);
  }

  private evalStaticMember(node: PSStaticMemberExpression, env: PSEnvironment): PSValue {
    const tname = node.typeName.toLowerCase();
    if (tname === 'environment' || tname === 'system.environment') {
      const dyn = this.buildEnvironmentType();
      return this.getMember(dyn as PSValue, node.member.toLowerCase());
    }
    const typeObj = STATIC_TYPES[tname]
      // Generic list fallback: List[T] for any T
      ?? (tname.match(/^(system\.collections\.generic\.list|collections\.generic\.list)\[.+\]$/)
          ? STATIC_TYPES['list'] : undefined)
      // Dictionary fallback
      ?? (tname.match(/^(system\.collections\.generic\.dictionary|collections\.generic\.dictionary)\[.+\]$/)
          ? { new: () => ({}) as PSValue } : undefined);
    if (typeObj) return this.getMember(typeObj as PSValue, node.member.toLowerCase());
    return null;
  }

  private evalIndex(node: PSIndexExpression, env: PSEnvironment): PSValue {
    const obj = this.evalExpr(node.object, env);
    const idx = this.evalExpr(node.index,  env);
    if (Array.isArray(obj)) {
      let i = idx as number;
      if (i < 0) i = obj.length + i;
      return obj[i] ?? null;
    }
    if (obj !== null && typeof obj === 'object')
      return (obj as Record<string, PSValue>)[String(idx)] ?? null;
    return null;
  }

  private evalInvocation(node: PSInvocationExpression, env: PSEnvironment): PSValue {
    const callee = this.evalExpr(node.callee, env);
    const args   = node.arguments.map(a => this.evalExpr(a, env));
    if (typeof callee === 'function')
      return (callee as (...a: PSValue[]) => PSValue)(...args);
    return null;
  }

  private evalCast(node: PSCastExpression, env: PSEnvironment): PSValue {
    const val = this.evalExpr(node.operand, env);
    return this.psCast(val, node.targetType);
  }

  private evalCommandExpr(node: PSCommandExpression, env: PSEnvironment): PSValue {
    if (node.name === '++' || node.name === '--') return null;
    const lname = node.name.toLowerCase();
    const fn = this.functions.get(lname);
    if (fn) return this.invokeScriptBlock(fn.block, {}, [], env, undefined);
    try { return this.dispatchCmdlet(lname, [], {}, undefined, env); }
    catch { return node.name; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3 — Statement executors
  // ═══════════════════════════════════════════════════════════════════════════

  private execIf(node: PSIfStatement, env: PSEnvironment): PSValue {
    if (this.isTruthy(this.evalExpr(node.condition, env)))
      return this.execScriptBlock(node.thenBody, env);
    for (const ei of node.elseifClauses) {
      if (this.isTruthy(this.evalExpr(ei.condition, env)))
        return this.execScriptBlock(ei.body, env);
    }
    if (node.elseBody) return this.execScriptBlock(node.elseBody, env);
    return null;
  }

  private execWhile(node: PSWhileStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    while (this.isTruthy(this.evalExpr(node.condition, env))) {
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break;
        if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) continue;
        throw e;
      }
    }
    return null;
  }

  private execDoWhile(node: PSDoWhileStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    do {
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break;
        if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) continue;
        throw e;
      }
    } while (this.isTruthy(this.evalExpr(node.condition, env)));
    return null;
  }

  private execDoUntil(node: PSDoUntilStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    do {
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break;
        if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) continue;
        throw e;
      }
    } while (!this.isTruthy(this.evalExpr(node.condition, env)));
    return null;
  }

  private execFor(node: PSForStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    if (node.init) this.execStatement(node.init, env);
    outer: while (!node.condition || this.isTruthy(this.evalExpr(node.condition, env))) {
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break outer;
        if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) { /* fall through */ }
        else throw e;
      }
      if (node.iterator) this.execStatement(node.iterator, env);
    }
    return null;
  }

  private execForeach(node: PSForeachStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    const varName    = node.variable.varName ?? node.variable.name;
    const collection = this.evalExpr(node.collection, env);
    const items: PSValue[] = Array.isArray(collection) ? collection
      : collection !== null && collection !== undefined ? [collection] : [];

    for (const item of items) {
      env.set(varName, item);
      try { this.execScriptBlock(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break;
        if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) continue;
        throw e;
      }
    }
    return null;
  }

  private execSwitch(node: PSSwitchStatement, env: PSEnvironment): PSValue {
    const subject = this.evalExpr(node.subject, env);
    let matched = false;
    const values: PSValue[] = [];

    // Run a clause body collecting all emitted values, even across a `break`.
    // Returns true when a `break` was encountered (caller should stop iterating).
    const runClause = (body: PSScriptBlock): boolean => {
      const stmtList = body.body ?? { statements: [] as PSStatement[] };
      const before = this.outputLines.length;
      for (const stmt of stmtList.statements) {
        const linesBefore = this.outputLines.length;
        let result: PSValue = null;
        let broke = false;
        try {
          result = this.execStatement(stmt, env);
        } catch (e) {
          if (e instanceof BreakSignal) { broke = true; }
          else { this.outputLines.splice(before); throw e; }
        }
        const didEmit = this.outputLines.length > linesBefore;
        if (!didEmit && result !== null && result !== undefined
            && stmt.type !== 'AssignmentStatement'
            && stmt.type !== 'FunctionDefinition') {
          if (Array.isArray(result)) values.push(...result);
          else values.push(result);
        }
        for (let i = linesBefore; i < this.outputLines.length; i++) {
          values.push(this.outputLines[i]);
        }
        if (broke) { this.outputLines.splice(before); return true; }
      }
      this.outputLines.splice(before);
      return false;
    };

    for (const clause of node.clauses) {
      const test = this.evalExpr(clause.pattern, env);
      if (this.switchMatch(subject, test)) {
        matched = true;
        if (runClause(clause.body)) break;
      }
    }
    if (!matched && node.defaultBody) {
      runClause(node.defaultBody);
    }
    if (values.length === 0) return null;
    return values.length === 1 ? values[0] : values;
  }

  private switchMatch(subject: PSValue, test: PSValue): boolean {
    if (typeof subject === 'string' && typeof test === 'string')
      return subject.toLowerCase() === test.toLowerCase();
    return subject === test;
  }

  private execTry(node: PSTryStatement, env: PSEnvironment): PSValue {
    let result: PSValue = null;
    try {
      result = this.execScriptBlock(node.tryBody, env);
    } catch (e) {
      const errRecord = this.makeErrorRecord(e);
      // Append to $Error list (PowerShell accumulates all errors)
      const errList = (this.global.get('Error') as PSValue[]) ?? [];
      this.global.set('Error', [errRecord, ...errList]);

      if (node.catchClauses.length > 0) {
        env.set('_', errRecord);
        // Find typed catch clause matching or fall through to untyped
        const matchingClause = node.catchClauses.find(c => {
          if (c.types.length === 0) return false;
          // Check if the error type matches
          const msg = e instanceof Error ? e.message : String(e);
          return c.types.some(t => {
            const tn = (t as unknown as { typeName?: string; value?: string }).typeName
              ?? (t as unknown as { value?: string }).value ?? String(t);
            return msg.includes(tn) || tn.includes('Exception') || tn.toLowerCase().includes('argument');
          });
        }) ?? node.catchClauses.find(c => c.types.length === 0) ?? node.catchClauses[0];
        result = this.execScriptBlock(matchingClause.body, env);
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
    return {
      Message: msg,
      Exception: { Message: msg } as Record<string, PSValue>,
      CategoryInfo: { Category: 'NotSpecified' } as Record<string, PSValue>,
      FullyQualifiedErrorId: 'RuntimeException',
    } as Record<string, PSValue>;
  }

  private execFunctionDef(node: PSFunctionDefinition, env: PSEnvironment): PSValue {
    const isFilter = node.kind === 'filter';
    this.functions.set(node.name.toLowerCase(), { block: node.body, isFilter });
    env.set(node.name, node.name as PSValue);
    return null;
  }

  private execClassDef(node: PSClassDefinition, _env: PSEnvironment): PSValue {
    const lname = node.name.toLowerCase();
    this.userClasses.set(lname, node);
    // Register static type entry with ::new() and static methods
    const self = this;
    const staticEntry: Record<string, PSValue> = {
      new: (...args: PSValue[]) => self.instantiateClass(node, args),
    };
    for (const m of node.members) {
      if (m.type === 'MethodDefinition' && m.modifiers.includes('static')) {
        const method = m as PSMethodDefinition;
        staticEntry[method.name.toLowerCase()] = (...args: PSValue[]) =>
          self.invokeClassMethod(node, method, null, args);
      }
    }
    STATIC_TYPES[lname] = staticEntry;
    return null;
  }

  private instantiateClass(cls: PSClassDefinition, args: PSValue[]): PSValue {
    const instance: Record<string, PSValue> = { __type__: cls.name };
    // Initialize base class properties first
    if (cls.baseClass) {
      const base = this.userClasses.get(cls.baseClass.toLowerCase());
      if (base) this.initClassProperties(instance, base);
    }
    this.initClassProperties(instance, cls);
    // Invoke constructor if args given or a constructor exists
    const ctorName = cls.name.toLowerCase();
    const ctor = cls.members.find(m =>
      m.type === 'MethodDefinition' && m.name.toLowerCase() === ctorName
    ) as PSMethodDefinition | undefined;
    if (ctor) this.invokeClassMethod(cls, ctor, instance, args);
    return instance as PSValue;
  }

  private initClassProperties(instance: Record<string, PSValue>, cls: PSClassDefinition): void {
    for (const m of cls.members) {
      if (m.type === 'PropertyDeclaration') {
        const prop = m as PSPropertyDeclaration;
        const initVal = prop.initializer ? this.evalExpr(prop.initializer, this.global) : null;
        if (!(prop.name in instance)) instance[prop.name] = initVal;
      }
    }
  }

  private invokeClassMethod(
    cls: PSClassDefinition,
    method: PSMethodDefinition,
    instance: Record<string, PSValue> | null,
    args: PSValue[],
  ): PSValue {
    const env = this.global.createChild();
    if (instance) env.set('this', instance as PSValue);
    for (let i = 0; i < method.parameters.length; i++) {
      const pname = method.parameters[i].name.varName
        ?? (method.parameters[i].name as { name?: string }).name ?? '';
      env.set(pname, args[i] ?? null);
    }
    try {
      return this.execStatementList(method.body, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
  }

  private execReturn(node: PSReturnStatement, env: PSEnvironment): PSValue {
    const val = node.value ? this.evalExpr(node.value, env) : null;
    throw new ReturnSignal(val);
  }

  private execThrow(node: PSThrowStatement, env: PSEnvironment): PSValue {
    const val = node.value ? this.evalExpr(node.value, env) : new PSRuntimeError('ScriptHalted');
    if (val instanceof Error) throw val;
    throw new Error(String(val));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 4 — Pipeline engine + cmdlet dispatch
  // ═══════════════════════════════════════════════════════════════════════════

  execPipeline(node: PSPipeline, env: PSEnvironment): PSValue {
    if (node.commands.length === 0) return null;
    if (node.commands.length === 1) return this.execCommand(node.commands[0], env, undefined);

    let pipeInput: PSValue = undefined;
    let result:    PSValue = null;
    for (const cmd of node.commands) {
      result    = this.execCommand(cmd, env, pipeInput);
      pipeInput = result;
    }
    return result;
  }

  private execCommand(node: PSCommand, env: PSEnvironment, pipeInput: PSValue): PSValue {
    const nameNode = node.name;

    // $x++ / $x-- encoded as AssignmentStatement in command-name position
    if (nameNode.type === 'AssignmentStatement')
      return this.execAssignment(nameNode as unknown as PSAssignmentStatement, env);

    // ++$x / --$x
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
    }

    // [Type] cast: TypeLiteral in command-name position
    if (nameNode.type === 'TypeLiteral') {
      const typeName = (nameNode as { typeName: string }).typeName;
      const arg = node.arguments[0] ? this.evalExpr(node.arguments[0], env) : null;
      return this.psCast(arg, typeName);
    }

    // VariableExpression: check if it holds a scriptblock → invoke it
    if (nameNode.type === 'VariableExpression') {
      const varVal = this.evalVariable(nameNode as PSVariableExpression, env);
      if (this.isScriptBlock(varVal)) {
        const positional: PSValue[] = [];
        const named: Record<string, PSValue> = {};
        for (const p of node.parameters)
          named[p.name.toLowerCase()] = p.value ? this.evalExpr(p.value, env) : true;
        for (const a of node.arguments)
          positional.push(this.evalExpr(a, env));
        return this.invokeScriptBlock(varVal as PSScriptBlock, named, positional, env, pipeInput);
      }
      // Variable holds a non-scriptblock (array pipeline source, etc.)
      return varVal;
    }

    // ScriptBlock in name position. Invoke only when the parser flagged it
    // via `& { ... }`, or when it has parameters / arguments / pipe input;
    // a bare `{ ... }` reaching this point (e.g. as an array element) is a
    // ScriptBlock VALUE that must not be auto-invoked.
    if (nameNode.type === 'ScriptBlock') {
      const marked = (nameNode as unknown as Record<string, unknown>).__invoke__ === true;
      if (!marked && node.parameters.length === 0 && node.arguments.length === 0 && pipeInput === undefined)
        return nameNode as unknown as PSValue;
      const positional: PSValue[] = [];
      const named: Record<string, PSValue> = {};
      for (const p of node.parameters)
        named[p.name.toLowerCase()] = p.value ? this.evalExpr(p.value, env) : true;
      for (const a of node.arguments)
        positional.push(this.evalExpr(a, env));
      return this.invokeScriptBlock(nameNode as unknown as PSScriptBlock, named, positional, env, pipeInput);
    }

    // Pure-value expressions evaluate directly (not as cmdlet names).
    // If binary-operator parameters are present (e.g. `"hello" -match "..."` in pipeline
    // context where the parser couldn't parse it as a binary expression), apply them in order.
    // Note: operator params like -match have value=null; their right side is a positional arg.
    if (this.isPureValueNode(nameNode, env)) {
      let val = this.evalExpr(nameNode, env);
      if (node.parameters.length > 0 && node.parameters.every(p => PS_OPERATOR_PARAMS.has(p.name.toLowerCase()))) {
        const positionalQueue = node.arguments.map(a => this.evalExpr(a, env));
        for (const p of node.parameters) {
          const right = p.value
            ? this.evalExpr(p.value, env)
            : (positionalQueue.shift() ?? null);
          val = this.applyBinaryOpByName(`-${p.name.toLowerCase()}`, val, right, env);
        }
        return val;
      }
      return val;
    }

    const rawName = this.resolveCommandName(nameNode, env);
    const lname   = rawName.toLowerCase();

    const positional: PSValue[] = [];
    const named: Record<string, PSValue> = {};

    for (const p of node.parameters)
      named[p.name.toLowerCase()] = p.value ? this.evalExpr(p.value, env) : true;

    for (const a of node.arguments) {
      // Handle splatting: @varname expands a hashtable as named params or an array as positional
      if ((a as unknown as { type: string }).type === 'SplatExpression') {
        const splatName = (a as unknown as { name: string }).name;
        const splatVal = env.get(splatName);
        if (splatVal && typeof splatVal === 'object' && !Array.isArray(splatVal)) {
          // Hashtable → named params
          for (const [k, v] of Object.entries(splatVal as Record<string, PSValue>))
            named[k.toLowerCase()] = v;
        } else if (Array.isArray(splatVal)) {
          // Array → positional args
          positional.push(...(splatVal as PSValue[]));
        }
      } else {
        positional.push(this.evalExpr(a, env));
      }
    }

    // & (call operator) — first positional arg is the target
    if (lname === '&' || lname === '.') {
      const dotSource = lname === '.';
      const target = positional.shift() ?? null;
      if (this.isScriptBlock(target)) {
        if (dotSource) return this.dotSourceScriptBlock(target as PSScriptBlock, env);
        return this.invokeScriptBlock(target as PSScriptBlock, named, positional, env, pipeInput);
      }
      const tname = psValueToString(target ?? '').toLowerCase();
      // Dot-source a registered script file
      if (dotSource) {
        let scriptContent = this.scriptRegistry.get(tname)
          ?? this.scriptRegistry.get(tname.replace(/^.*[/\\]/, '')); // try basename
        // Fall back to the device filesystem so `. C:\Scripts\fn.ps1` works
        // for files created via Set-Content / New-Item.
        if (!scriptContent && this.providers.filesystem) {
          try { scriptContent = this.providers.filesystem.readFile(psValueToString(target ?? '')); }
          catch { /* no such file */ }
        }
        if (scriptContent) {
          const ast = this.parseCached(scriptContent);
          // Dot-source binds param() in the caller scope (no child env) so
          // `. script.ps1 -X foo` leaves $X visible to subsequent statements.
          if (ast.paramBlock) {
            const remaining = [...positional];
            for (const p of ast.paramBlock.parameters) {
              const pname = (p.name as { varName?: string; name?: string }).varName
                         ?? (p.name as { name?: string }).name ?? '';
              const pkey = pname.toLowerCase();
              if (named[pkey] !== undefined) env.set(pname, named[pkey]);
              else if (remaining.length > 0) env.set(pname, remaining.shift()!);
              else if (p.defaultValue) env.set(pname, this.evalExpr(p.defaultValue, env));
              else env.set(pname, null);
            }
          }
          return this.aggregateCaptured(this.runBlockCapture(ast.body, env));
        }
        // No registered script — silently return null (file not found in simulator)
        return null;
      }
      const tfn = this.functions.get(tname);
      if (tfn) {
        return this.callUserFunction(tfn, named, positional, env, pipeInput);
      }
      // `& C:\path\to\script.ps1 args...` — invoke a script file as if it
      // were a function. Param block / pipeline behave like a normal call.
      if (/\.ps1$/i.test(tname) && this.providers.filesystem) {
        let scriptContent: string | undefined;
        try { scriptContent = this.providers.filesystem.readFile(psValueToString(target ?? '')); }
        catch { scriptContent = undefined; }
        if (scriptContent) {
          const ast = this.parseCached(scriptContent);
          const block: PSScriptBlock = {
            type: 'ScriptBlock',
            paramBlock: ast.paramBlock ?? null,
            beginBlock: null,
            processBlock: null,
            endBlock: null,
            body: ast.body,
            position: ast.position,
          } as PSScriptBlock;
          return this.invokeScriptBlock(block, named, positional, env, pipeInput);
        }
      }
      return this.dispatchCmdlet(tname, positional, named, pipeInput, env);
    }

    // User-defined function
    const fn = this.functions.get(lname);
    if (fn) return this.callUserFunction(fn, named, positional, env, pipeInput);

    // Script-file invocation: `C:\foo\bar.ps1 -X y` (with or without a leading
    // `&`, since parseCommandName silently consumes the ampersand). Loads the
    // file from the device filesystem and invokes it like a function.
    if (/\.ps1$/i.test(lname) && this.providers.filesystem) {
      let scriptContent: string | undefined;
      try { scriptContent = this.providers.filesystem.readFile(rawName); }
      catch { scriptContent = undefined; }
      if (scriptContent) {
        const ast = this.parseCached(scriptContent);
        const block: PSScriptBlock = {
          type: 'ScriptBlock',
          paramBlock: ast.paramBlock ?? null,
          beginBlock: null,
          processBlock: null,
          endBlock: null,
          body: ast.body,
          position: ast.position,
        } as PSScriptBlock;
        return this.invokeScriptBlock(block, named, positional, env, pipeInput);
      }
    }

    // Registry dispatch
    return this.dispatchCmdlet(lname, positional, named, pipeInput, env);
  }

  /**
   * Execute a statement list and return all pipeline-emitted values.
   * Unlike execStatementList (which returns last result), this collects output
   * from every non-assignment statement, mirroring what execute() does at top level.
   */
  private runBlockCapture(node: PSStatementList, env: PSEnvironment): PSValue[] {
    const captured: PSValue[] = [];
    const before = this.outputLines.length;
    for (const stmt of node.statements) {
      const linesBefore = this.outputLines.length;
      const result = this.execStatement(stmt, env);
      const didEmit = this.outputLines.length > linesBefore;
      // Non-assignment, non-definition statements that didn't emit via cmdlet → collect value
      if (!didEmit && result !== null && result !== undefined
          && stmt.type !== 'AssignmentStatement'
          && stmt.type !== 'FunctionDefinition') {
        if (Array.isArray(result)) captured.push(...result);
        else captured.push(result);
      }
      // Values emitted via outputLines (from cmdlets) → promote to PSValue
      for (let i = linesBefore; i < this.outputLines.length; i++) {
        captured.push(this.outputLines[i]);
      }
    }
    // Remove the lines we captured (they'll be re-emitted via the return value)
    this.outputLines.splice(before);
    return captured;
  }

  /**
   * Invoke a user-defined function, handling Begin/Process/End blocks,
   * filter semantics, $input, and ValueFromPipeline parameter binding.
   */
  private callUserFunction(
    fn: { block: PSScriptBlock; isFilter: boolean },
    named: Record<string, PSValue>,
    positional: PSValue[],
    env: PSEnvironment,
    pipeInput: PSValue,
  ): PSValue {
    const { block, isFilter } = fn;
    const hasNamedBlocks = !!(block.beginBlock || block.processBlock || block.endBlock);
    const pipeItems: PSValue[] = pipeInput !== undefined && pipeInput !== null
      ? (Array.isArray(pipeInput) ? pipeInput : [pipeInput])
      : [];

    // Check param block for ValueFromPipeline / ValueFromPipelineByPropertyName
    let pipeParamName: string | null = null;
    let pipeByPropertyName: string | null = null;
    if (block.paramBlock) {
      for (const p of block.paramBlock.parameters) {
        const pname = p.name.varName ?? (p.name as { name?: string }).name ?? '';
        for (const attr of p.attributes) {
          if (attr.name.toLowerCase() === 'parameter') {
            // namedArgs covers [Parameter(ValueFromPipeline=$true)]
            // positionalArgs covers [Parameter(ValueFromPipeline)] (bareword, no =$true)
            const vfpNamed = attr.namedArgs['ValueFromPipeline'] ?? attr.namedArgs['valuefrompipeline'];
            const vfpPositional = attr.positionalArgs.some(a => {
              const ce = a as { type?: string; name?: string };
              return ce.type === 'CommandExpression' && ce.name?.toLowerCase() === 'valuefrompipeline';
            });
            const vfbpnNamed = attr.namedArgs['ValueFromPipelineByPropertyName'] ?? attr.namedArgs['valuefrompipelinebypropertyname'];
            const vfbpnPositional = attr.positionalArgs.some(a => {
              const ce = a as { type?: string; name?: string };
              return ce.type === 'CommandExpression' && ce.name?.toLowerCase() === 'valuefrompipelinebypropertyname';
            });
            if (vfpNamed || vfpPositional) pipeParamName = pname;
            if (vfbpnNamed || vfbpnPositional) pipeByPropertyName = pname;
          }
        }
      }
    }

    // Resolve aliases and validate params
    const resolvedNamed = { ...named };
    if (block.paramBlock) {
      for (const p of block.paramBlock.parameters) {
        const pname = p.name.varName ?? (p.name as { name?: string }).name ?? '';
        const pkey = pname.toLowerCase();
        for (const attr of p.attributes) {
          if (attr.name.toLowerCase() === 'alias') {
            for (const aliasExpr of attr.positionalArgs) {
              const alias = String((aliasExpr as { value?: unknown }).value ?? '').toLowerCase();
              if (resolvedNamed[alias] !== undefined && resolvedNamed[pkey] === undefined)
                resolvedNamed[pkey] = resolvedNamed[alias];
            }
          }
        }
        const isMandatory = p.attributes.some(a => {
          if (a.name.toLowerCase() !== 'parameter') return false;
          const mv = a.namedArgs['Mandatory'] ?? a.namedArgs['mandatory'];
          return mv !== null && mv !== undefined && (mv as { value?: unknown }).value !== false;
        });
        if (isMandatory && resolvedNamed[pkey] === undefined && positional.length === 0
            && pipeParamName?.toLowerCase() !== pkey)
          throw new PSRuntimeError(`Missing mandatory parameter: ${pname}`);

        for (const attr of p.attributes) {
          if (attr.name.toLowerCase() === 'validaterange' && resolvedNamed[pkey] !== undefined) {
            const min = (attr.positionalArgs[0] as { value?: number })?.value ?? 0;
            const max = (attr.positionalArgs[1] as { value?: number })?.value ?? Infinity;
            const val = Number(resolvedNamed[pkey]);
            if (val < min || val > max)
              throw new PSRuntimeError(`Validation error: ${pname} must be between ${min} and ${max}`);
          }
          if (attr.name.toLowerCase() === 'validateset' && resolvedNamed[pkey] !== undefined) {
            const allowed = attr.positionalArgs.map(a => String((a as { value?: unknown }).value ?? ''));
            const val = String(resolvedNamed[pkey]);
            if (!allowed.some(a => a.toLowerCase() === val.toLowerCase()))
              throw new PSRuntimeError(`Validation error: ${pname} must be one of [${allowed.join(', ')}]`);
          }
        }
      }
    }

    // For functions with named blocks (begin/process/end) or filter keyword
    if (hasNamedBlocks || isFilter) {
      const childEnv = env.createChild();
      if (block.paramBlock) {
        const remaining = [...positional];
        for (const p of block.paramBlock.parameters) {
          const pname = p.name.varName ?? (p.name as { name?: string }).name ?? '';
          const pkey = pname.toLowerCase();
          if (resolvedNamed[pkey] !== undefined) childEnv.set(pname, resolvedNamed[pkey]);
          else if (remaining.length > 0) childEnv.set(pname, remaining.shift()!);
          else if (p.defaultValue) childEnv.set(pname, this.evalExpr(p.defaultValue, env));
          else childEnv.set(pname, null);
        }
        childEnv.set('args', positional);
      }
      childEnv.set('input', pipeItems);

      const results: PSValue[] = [];

      try {
        // begin block — side effects only, not collected
        if (block.beginBlock) this.execStatementList(block.beginBlock, childEnv);

        const procBlock = block.processBlock ?? (isFilter ? block.body : null);
        if (procBlock) {
          if (pipeItems.length === 0) {
            results.push(...this.runBlockCapture(procBlock, childEnv));
          } else {
            for (const item of pipeItems) {
              childEnv.set('_', item);
              childEnv.set('PSItem', item);
              if (pipeParamName) childEnv.set(pipeParamName, item);
              if (pipeByPropertyName && item && typeof item === 'object' && !Array.isArray(item)) {
                const rec = item as Record<string, PSValue>;
                const key = Object.keys(rec).find(k => k.toLowerCase() === pipeByPropertyName!.toLowerCase()) ?? pipeByPropertyName;
                childEnv.set(pipeByPropertyName, rec[key] ?? null);
              }
              try { results.push(...this.runBlockCapture(procBlock, childEnv)); }
              catch (e) {
                if (e instanceof ReturnSignal) { results.push(...this.toArray(e.value)); break; }
                if (e instanceof BreakSignal) break;
                throw e;
              }
            }
          }
        } else if (!hasNamedBlocks && block.body) {
          childEnv.set('input', pipeItems);
          results.push(...this.runBlockCapture(block.body, childEnv));
        }

        // end block — collects its output
        if (block.endBlock) results.push(...this.runBlockCapture(block.endBlock, childEnv));
      } catch (e) {
        if (e instanceof ReturnSignal) results.push(...this.toArray(e.value));
        else throw e;
      }

      if (results.length === 0) return null;
      return results.length === 1 ? results[0] : results;
    }

    // Plain function — check if $input should be set (when pipe input is available)
    const namedForInvoke = { ...resolvedNamed };
    if (pipeParamName && pipeItems.length > 0) {
      const paramVal = pipeItems.length === 1 ? pipeItems[0] : pipeItems;
      namedForInvoke[pipeParamName.toLowerCase()] = paramVal;
    }

    // If the function has no named blocks but has pipe input, check if it uses $input
    if (pipeItems.length > 0 && !pipeParamName) {
      // Provide $input in the child env
      const childEnv = env.createChild();
      if (block.paramBlock) {
        const remaining = [...positional];
        for (const p of block.paramBlock.parameters) {
          const pname = p.name.varName ?? (p.name as { name?: string }).name ?? '';
          const pkey = pname.toLowerCase();
          if (namedForInvoke[pkey] !== undefined) childEnv.set(pname, namedForInvoke[pkey]);
          else if (remaining.length > 0) childEnv.set(pname, remaining.shift()!);
          else if (p.defaultValue) childEnv.set(pname, this.evalExpr(p.defaultValue, env));
          else childEnv.set(pname, null);
        }
        childEnv.set('args', positional);
      }
      childEnv.set('input', pipeItems);
      if (block.body) {
        const results = this.runBlockCapture(block.body, childEnv);
        if (results.length === 0) return null;
        return results.length === 1 ? results[0] : results;
      }
    }

    return this.invokeScriptBlock(block, namedForInvoke, positional, env, pipeInput);
  }

  private isScriptBlock(val: PSValue): boolean {
    return val !== null && typeof val === 'object' && !Array.isArray(val)
      && (val as Record<string, unknown>).type === 'ScriptBlock';
  }

  private resolveCommandName(nameNode: PSExpression, env: PSEnvironment): string {
    if (nameNode.type === 'LiteralExpression')
      return String((nameNode as PSLiteralExpression).value);
    if (nameNode.type === 'CommandExpression')
      return (nameNode as PSCommandExpression).name;
    if (nameNode.type === 'VariableExpression')
      return psValueToString(this.evalVariable(nameNode as PSVariableExpression, env));
    return psValueToString(this.evalExpr(nameNode, env));
  }

  /**
   * Dispatches a cmdlet invocation through the registry.
   * Builds a CmdletContext and calls ICmdlet.execute().
   * Throws PSRuntimeError if the cmdlet is not found.
   */
  private dispatchCmdlet(
    name: string,
    positional: PSValue[],
    named: Record<string, PSValue>,
    pipeInput: PSValue,
    env: PSEnvironment,
  ): PSValue {
    // Extract common parameters before dispatch
    const errorVarName  = named['errorvariable']  ? psValueToString(named['errorvariable'])  : null;
    const errorAction   = named['erroraction']    ? psValueToString(named['erroraction']).toLowerCase() : null;
    const silentlyCont  = errorAction === 'silentlycontinue' || errorAction === 'ignore';

    // Remove common params from named so cmdlets don't see them
    const cmdletNamed = { ...named };
    delete cmdletNamed['errorvariable'];
    delete cmdletNamed['erroraction'];
    delete cmdletNamed['warningaction'];
    delete cmdletNamed['informationaction'];
    delete cmdletNamed['verbose'];
    delete cmdletNamed['debug'];
    delete cmdletNamed['whatif'];
    delete cmdletNamed['confirm'];
    delete cmdletNamed['outvariable'];

    const cmdlet = this.registry.resolve(name);
    if (!cmdlet) {
      this.global.set('?', false);
      if (errorVarName) {
        const errObj = { Exception: { Message: `The term '${name}' is not recognized` }, CategoryInfo: {} } as Record<string, PSValue>;
        this.global.set(errorVarName, errObj);
      }
      if (silentlyCont) return null;
      throw new PSRuntimeError(
        `The term '${name}' is not recognized as a cmdlet, function, script file, or operable program.`);
    }

    const emittedValues: PSValue[] = [];
    const prevErrCount = this.errorObjects.length;
    const ctx = this.buildCmdletContext(positional, cmdletNamed, pipeInput, env, emittedValues, silentlyCont);
    let result: PSValue;
    try {
      result = cmdlet.execute(ctx);
      this.global.set('?', true);
    } catch (err) {
      this.global.set('?', false);
      if (errorVarName) {
        const msg = err instanceof Error ? err.message : String(err);
        this.global.set(errorVarName, { Exception: { Message: msg }, CategoryInfo: {} } as Record<string, PSValue>);
      }
      if (silentlyCont) return null;
      throw err;
    }

    // Capture new error objects into -ErrorVariable
    if (errorVarName && this.errorObjects.length > prevErrCount) {
      const newErrs = this.errorObjects.slice(prevErrCount);
      this.global.set(errorVarName, newErrs.length === 1 ? newErrs[0] : newErrs);
    }

    // Output emitted via ctx.emit() is appended to the output stream
    for (const v of emittedValues) {
      if (Array.isArray(v)) {
        for (const item of v) this.outputLines.push(psValueToString(item));
      } else {
        this.outputLines.push(psValueToString(v));
      }
    }

    return result;
  }

  /**
   * Builds a CmdletContext for a single cmdlet invocation.
   * The `emittedValues` array is filled by ctx.emit() and later appended
   * to outputLines by the caller (dispatchCmdlet).
   */
  private buildCmdletContext(
    positional: PSValue[],
    named: Record<string, PSValue>,
    pipeInput: PSValue,
    env: PSEnvironment,
    emittedValues: PSValue[],
    silentlyContinue: boolean = false,
  ): CmdletContext {
    const self = this;

    const runtimeRef: IRuntimeRef = {
      execute:            (code) => self.execute(code),
      executeInteractive: (code) => self.executeInteractive(code),
      executeForValue:    (code) => self.executeForValue(code),
      getVariable:        (name) => self.global.get(name),
      setVariable:        (name, val) => self.global.set(name, val),
      invokeScriptBlock:  (block, namedV, posV, env2, $under) =>
        self.invokeScriptBlock(block, namedV, posV, env2, $under),
      callCmdlet: (name, pos, namedP, pipe, env2) =>
        self.dispatchCmdlet(name, pos, namedP, pipe, env2),
      listCmdlets: () =>
        self.registry.cmdlets().map(c => ({
          name: c.name,
          aliases: c.aliases,
          displayName: c.displayName,
          module: c.module,
          description: c.description,
        })),
      listEnvVars: () => self.providers.environment?.list() ?? [],
    };

    return {
      positional,
      named,
      pipeInput,
      env,
      runtime:   runtimeRef,
      providers: self.providers,

      emit: (val: PSValue) => emittedValues.push(val),

      emitError: (msg: string) => {
        // Always record the error object (so $Error and -ErrorVariable
        // see it). Suppress the visible "ERROR:" line when the caller
        // used -ErrorAction SilentlyContinue / Ignore.
        if (!silentlyContinue) self.outputLines.push(`ERROR: ${msg}`);
        self.errorObjects.push({
          Exception: { Message: msg },
          CategoryInfo: { Category: 'NotSpecified' },
          TargetObject: null,
        } as Record<string, PSValue>);
      },

      invokeBlock: (
        block: PSScriptBlock,
        dollarUnderscore?: PSValue,
        namedVars: Record<string, PSValue> = {},
        args: PSValue[] = [],
      ) => self.invokeScriptBlock(block, namedVars, args, env, dollarUnderscore),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 5 — Helper utilities
  // ═══════════════════════════════════════════════════════════════════════════

  psCast(val: PSValue, typeName: string): PSValue {
    const t = typeName.replace(/^\[|\]$/g, '').toLowerCase();
    switch (t) {
      case 'int': case 'int32': case 'long': case 'int64': return parseInt(String(val), 10);
      case 'double': case 'float': case 'single': case 'decimal': return parseFloat(String(val));
      case 'string':  return psValueToString(val);
      case 'bool': case 'boolean': return this.isTruthy(val);
      case 'char':    return String(val).charAt(0);
      case 'array':   return Array.isArray(val) ? val : [val];
      case 'xml': {
        const xmlStr = String(val ?? '');
        const parseXML = (s: string): Record<string, PSValue> => {
          const node: Record<string, PSValue> = {
            OuterXml: s,
            InnerText: s.replace(/<[^>]*>/g, '').trim(),
          };
          const childRe = /<([\w:.-]+)(?:\s[^>]*)?>([^]*?)<\/\1>/g;
          let m: RegExpExecArray | null;
          while ((m = childRe.exec(s)) !== null) {
            const [, tag, content] = m;
            node[tag] = /<[\w:.-]/.test(content)
              ? parseXML(content) as unknown as PSValue
              : content;
          }
          return node;
        };
        return parseXML(xmlStr) as unknown as PSValue;
      }
      case 'regex': case 'system.text.regularexpressions.regex':
        // [regex]"pattern" — return a regex-like object
        return { __pattern__: String(val), IsMatch: (s: PSValue) => new RegExp(String(val)).test(String(s)) } as unknown as PSValue;
      case 'guid': case 'system.guid':
        return String(val) as PSValue;
      case 'datetime': case 'system.datetime':
        return new Date(String(val)) as unknown as PSValue;
      case 'timespan': case 'system.timespan': {
        const ms = typeof val === 'number' ? val : Number(val);
        return { __type: 'TimeSpan', TotalMilliseconds: ms, TotalSeconds: ms/1000, TotalMinutes: ms/60000, TotalHours: ms/3600000, TotalDays: ms/86400000, Days: Math.floor(ms/86400000), Hours: Math.floor((ms%86400000)/3600000), Minutes: Math.floor((ms%3600000)/60000), Seconds: Math.floor((ms%60000)/1000), Milliseconds: ms%1000 } as unknown as PSValue;
      }
      case 'version': case 'system.version': {
        const parts = String(val).split('.').map(Number);
        return { Major: parts[0]??0, Minor: parts[1]??0, Build: parts[2]??-1, Revision: parts[3]??-1, ToString: () => String(val) } as unknown as PSValue;
      }
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
    // Date + TimeSpan → new Date offset by the timespan (with PS-style properties)
    if (left instanceof Date) {
      const ms = right instanceof Date
        ? right.getTime()
        : typeof right === 'object' && right !== null
          ? Number((right as Record<string, PSValue>)['TotalMilliseconds'] ?? 0)
          : Number(right);
      const result = new Date(left.getTime() + ms);
      return Object.assign(result, {
        Year: result.getFullYear(), Month: result.getMonth() + 1, Day: result.getDate(),
        Hour: result.getHours(), Minute: result.getMinutes(), Second: result.getSeconds(),
        Millisecond: result.getMilliseconds(), DayOfWeek: result.getDay(), Ticks: result.getTime(),
      }) as unknown as PSValue;
    }
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
    const regex = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(regex, caseSensitive ? '' : 'i').test(str);
  }

  private psMatch(str: string, pattern: string, caseSensitive: boolean, env: PSEnvironment): boolean {
    const re = new RegExp(pattern, caseSensitive ? '' : 'i');
    const m  = str.match(re);
    if (m) {
      const matches: Record<string, PSValue> = { '0': m[0] };
      // Numbered groups
      m.slice(1).forEach((g, i) => { matches[String(i + 1)] = g ?? null; });
      // Named captures from groups (?<name>...)
      if (m.groups) {
        for (const [key, val] of Object.entries(m.groups)) {
          matches[key] = val ?? null;
        }
      }
      // $Matches is a global automatic variable
      this.global.set('Matches', matches);
    } else {
      this.global.set('Matches', null);
    }
    return !!m;
  }

  psIs(val: PSValue, right: PSValue): boolean {
    const t = String(right).replace(/^\[|\]$/g, '').toLowerCase();
    switch (t) {
      case 'string':                     return typeof val === 'string';
      case 'int': case 'int32':
      case 'double': case 'float':       return typeof val === 'number';
      case 'bool': case 'boolean':       return typeof val === 'boolean';
      case 'array':                      return Array.isArray(val);
      case 'null':                       return val === null;
      case 'hashtable': case 'object':   return val !== null && typeof val === 'object' && !Array.isArray(val);
      default:                           return false;
    }
  }

  getMember(obj: PSValue, member: string): PSValue {
    if (obj === null || obj === undefined) return null;
    if (typeof obj === 'string')  return this.getStringMember(obj, member);

    // ArrayList IS an array with a __list__ sentinel — handle list-style methods first
    if (Array.isArray(obj) && (obj as Record<string, unknown>)['__list__'] !== undefined) {
      const list = obj as PSValue[];
      switch (member) {
        case 'add':      return (v: PSValue) => { list.push(v); return null; };
        case 'remove':   return (v: PSValue) => { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); return null; };
        case 'removeat': return (i: PSValue) => { list.splice(Number(i), 1); return null; };
        case 'count': case 'length': return list.length;
        case 'item':     return (i: PSValue) => list[Number(i)] ?? null;
        case 'toarray':  return [...list];
        case 'insert':   return (i: PSValue, v: PSValue) => { list.splice(Number(i), 0, v); return null; };
        case 'clear':    return () => { list.splice(0); return null; };
        case 'contains': return (v: PSValue) => list.some(e => this.psEq(e, v, false));
        case 'indexof':  return (v: PSValue) => list.findIndex(e => this.psEq(e, v, false));
        case 'sort':     return () => { list.sort(); return null; };
      }
    }

    if (Array.isArray(obj))       return this.getArrayMember(obj, member);

    // JS Date objects — expose PS-style properties and methods
    if (obj instanceof Date) return this.getDateMember(obj, member);

    if (typeof obj === 'object') {
      const rec = obj as Record<string, PSValue>;

      // Direct property wins over synthetic collection members. This keeps
      // `(... | Measure-Object).Count` returning the Count *property* (e.g.
      // 240) instead of the hashtable key-count (the 6 fields of the
      // result object). Real PowerShell resolves declared properties
      // before the generic ICollection.Count / .Keys / .Values members.
      const directKey = Object.keys(rec).find(k => k.toLowerCase() === member);
      if (directKey !== undefined) {
        const shadowing = member === 'count' || member === 'keys'
          || member === 'values' || member === 'clear' || member === 'add'
          || member === 'remove' || member === 'clone';
        if (typeof rec[directKey] === 'function' || shadowing) return rec[directKey];
      }

      // Hashtable/dictionary methods
      switch (member) {
        case 'remove':       return (k: PSValue) => { delete rec[String(k)]; return null; };
        case 'containskey':  return (k: PSValue) => String(k) in rec || Object.keys(rec).some(x => x.toLowerCase() === String(k).toLowerCase());
        case 'containsvalue':return (v: PSValue) => Object.values(rec).some(x => this.psEq(x, v, false));
        case 'add':          return (k: PSValue, v: PSValue) => { rec[String(k)] = v; return null; };
        case 'getenumerator':return () => Object.entries(rec).map(([k, v]) => ({ Key: k, Value: v }) as Record<string, PSValue>);
        case 'values':       return Object.values(rec);
        case 'clone':        return { ...rec };
        case 'clear':        return () => { for (const k of Object.keys(rec)) delete rec[k]; return null; };
        case 'count':        return Object.keys(rec).length;
        case 'keys':         return Object.keys(rec);
      }

      // ArrayList/List-style methods
      if (Array.isArray(rec['__list__'])) {
        const list = rec['__list__'] as PSValue[];
        switch (member) {
          case 'add':    return (v: PSValue) => { list.push(v); return null; };
          case 'remove': return (v: PSValue) => { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); return null; };
          case 'removeat': return (i: PSValue) => { list.splice(Number(i), 1); return null; };
          case 'count':  case 'length': return list.length;
          case 'item':   return (i: PSValue) => list[Number(i)] ?? null;
          case 'toarray': return [...list];
          case 'insert': return (i: PSValue, v: PSValue) => { list.splice(Number(i), 0, v); return null; };
        }
      }

      // Queue-style (FIFO)
      if (rec['__type__'] === 'Queue') {
        const q = rec['__items__'] as PSValue[];
        switch (member) {
          case 'enqueue': return (v: PSValue) => { q.push(v); return null; };
          case 'dequeue': return () => q.shift() ?? null;
          case 'peek':    return () => q[0] ?? null;
          case 'count':   return q.length;
        }
      }

      // Stack-style (LIFO)
      if (rec['__type__'] === 'Stack') {
        const s = rec['__items__'] as PSValue[];
        switch (member) {
          case 'push':  return (v: PSValue) => { s.push(v); return null; };
          case 'pop':   return () => s.pop() ?? null;
          case 'peek':  return () => s[s.length - 1] ?? null;
          case 'count': return s.length;
        }
      }

      // User-defined class: look up methods and inherited members
      const typeName = rec['__type__'];
      if (typeof typeName === 'string') {
        const cls = this.userClasses.get(typeName.toLowerCase());
        if (cls) {
          // Search class hierarchy for matching method
          const method = this.findClassMethod(cls, member);
          if (method) {
            return (...args: PSValue[]) => this.invokeClassMethod(cls, method, rec, args);
          }
        }
      }

      const key = Object.keys(rec).find(k => k.toLowerCase() === member) ?? member;
      const val = rec[key];
      if (val !== undefined) return val;
    }
    return null;
  }

  private findClassMethod(cls: PSClassDefinition, memberLower: string): PSMethodDefinition | null {
    for (const m of cls.members) {
      if (m.type === 'MethodDefinition' && m.name.toLowerCase() === memberLower)
        return m as PSMethodDefinition;
    }
    if (cls.baseClass) {
      const base = this.userClasses.get(cls.baseClass.toLowerCase());
      if (base) return this.findClassMethod(base, memberLower);
    }
    return null;
  }

  private validateClassProperty(cls: PSClassDefinition, propName: string, value: PSValue): void {
    const prop = cls.members.find(m =>
      m.type === 'PropertyDeclaration' && m.name.toLowerCase() === propName.toLowerCase()
    ) as PSPropertyDeclaration | undefined;
    if (!prop) return;
    for (const attr of prop.attributes) {
      const aname = attr.name.toLowerCase();
      if (aname === 'validaterange') {
        const min = Number(attr.args[0]);
        const max = Number(attr.args[1]);
        const v   = Number(value);
        if (v < min || v > max)
          throw new PSRuntimeError(`Cannot validate argument on parameter '${propName}'. The ${v} argument is not in the range [${min}, ${max}].`);
      } else if (aname === 'validateset') {
        const allowed = attr.args.map(String);
        if (!allowed.some(a => a.toLowerCase() === String(value).toLowerCase()))
          throw new PSRuntimeError(`Cannot validate argument on parameter '${propName}'. "${value}" is not in the set "${allowed.join('", "')}".`);
      } else if (aname === 'validatepattern') {
        const pattern = String(attr.args[0] ?? '');
        if (!new RegExp(pattern, 'i').test(String(value)))
          throw new PSRuntimeError(`Cannot validate argument on parameter '${propName}'. "${value}" does not match the pattern "${pattern}".`);
      }
    }
  }

  private getDateMember(d: Date, member: string): PSValue {
    switch (member) {
      case 'year':        return d.getFullYear();
      case 'month':       return d.getMonth() + 1;
      case 'day':         return d.getDate();
      case 'hour':        return d.getHours();
      case 'minute':      return d.getMinutes();
      case 'second':      return d.getSeconds();
      case 'millisecond': return d.getMilliseconds();
      case 'dayofweek':   return d.getDay();
      case 'dayofyear':   return Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000);
      case 'ticks':       return d.getTime() * 10000;
      case 'date':        return new Date(d.getFullYear(), d.getMonth(), d.getDate()) as unknown as PSValue;
      case 'tostring':    return () => d.toISOString();
      case 'tolongdatestring': return () => d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      case 'toshortdatestring': return () => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
      case 'adddays':     return (n: PSValue) => { const r = new Date(d); r.setDate(r.getDate() + Number(n)); return r as unknown as PSValue; };
      case 'addhours':    return (n: PSValue) => { const r = new Date(d); r.setHours(r.getHours() + Number(n)); return r as unknown as PSValue; };
      case 'addminutes':  return (n: PSValue) => { const r = new Date(d); r.setMinutes(r.getMinutes() + Number(n)); return r as unknown as PSValue; };
      case 'addseconds':  return (n: PSValue) => { const r = new Date(d); r.setSeconds(r.getSeconds() + Number(n)); return r as unknown as PSValue; };
      case 'addmonths':   return (n: PSValue) => { const r = new Date(d); r.setMonth(r.getMonth() + Number(n)); return r as unknown as PSValue; };
      case 'addyears':    return (n: PSValue) => { const r = new Date(d); r.setFullYear(r.getFullYear() + Number(n)); return r as unknown as PSValue; };
      case 'subtract':    return (ts: PSValue) => {
        const ms = (ts as Record<string, PSValue>)?.['TotalMilliseconds'];
        return d.getTime() - (ms !== undefined ? Number(ms) : 0);
      };
      default: return null;
    }
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
      default: {
        // PowerShell array member enumeration: access member on each element,
        // unwrap to scalar if only one result.
        const mapped = arr.map(el => this.getMember(el, member)).filter(v => v !== null && v !== undefined);
        if (mapped.length === 0) return null;
        return mapped.length === 1 ? mapped[0] : mapped;
      }
    }
  }

  toArray(val: PSValue): PSValue[] {
    if (val === null || val === undefined) return [];
    return Array.isArray(val) ? val : [val];
  }

  stringArgs(pos: PSValue[], named: Record<string, PSValue>, key: string): string[] {
    const src = named[key] ?? (pos.length > 0 ? pos : null);
    if (!src) return [];
    return (Array.isArray(src) ? src : [src]).map(v => psValueToString(v));
  }

  /**
   * Apply a binary operator by name (e.g. '-match', '-eq') to two already-evaluated values.
   * Used when a pure-value command has binary-operator parameters in pipeline context.
   */
  private applyBinaryOpByName(op: string, left: PSValue, right: PSValue, env: PSEnvironment): PSValue {
    switch (op) {
      case '-eq':  return this.psEq(left, right, false);
      case '-ne':  return !this.psEq(left, right, false);
      case '-ceq': return this.psEq(left, right, true);
      case '-cne': return !this.psEq(left, right, true);
      case '-gt':  return (left as number) > (right as number);
      case '-lt':  return (left as number) < (right as number);
      case '-ge':  return (left as number) >= (right as number);
      case '-le':  return (left as number) <= (right as number);
      case '-like':     return this.psLike(String(left), String(right), false);
      case '-notlike':  return !this.psLike(String(left), String(right), false);
      case '-match':    return this.psMatch(String(left), String(right), false, env);
      case '-notmatch': return !this.psMatch(String(left), String(right), false, env);
      case '-cmatch':   return this.psMatch(String(left), String(right), true, env);
      case '-cnotmatch':return !this.psMatch(String(left), String(right), true, env);
      case '-contains': return (Array.isArray(left) ? left : []).some(e => this.psEq(e, right, false));
      case '-notcontains': return !(Array.isArray(left) ? left : []).some(e => this.psEq(e, right, false));
      case '-in':   return (Array.isArray(right) ? right : []).some(e => this.psEq(e, left, false));
      case '-notin':return !(Array.isArray(right) ? right : []).some(e => this.psEq(e, left, false));
      case '-is':    return this.psIs(left, String(right));
      case '-isnot': return !this.psIs(left, String(right));
      case '-as':    return this.psCast(left, String(right).replace(/^\[|\]$/g, ''));
      case '-replace': {
        const args = Array.isArray(right) ? right : [right];
        const repl2 = args[1] ?? '';
        if (this.isScriptBlock(repl2)) {
          return String(left).replace(new RegExp(String(args[0] ?? ''), 'gi'), (match) => {
            const matchObj = { Value: match, Groups: [match] as PSValue[], Length: match.length } as unknown as PSValue;
            return psValueToString(this.invokeScriptBlock(repl2 as PSScriptBlock, {}, [], env, matchObj));
          });
        }
        return String(left).replace(new RegExp(String(args[0] ?? ''), 'gi'), String(repl2));
      }
      case '-and': return this.isTruthy(left) ? right : false;
      case '-or':  return this.isTruthy(left) ? left : right;
      case '-not': return !this.isTruthy(right);
      case '-band': return (left as number) & (right as number);
      case '-bor':  return (left as number) | (right as number);
      case '-bxor': return (left as number) ^ (right as number);
      case '-shl':  return (left as number) << (right as number);
      case '-shr':  return (left as number) >> (right as number);
      default: return left;
    }
  }

  /** Extracts the type name string from a [TypeName] node (TypeLiteral or CastExpression wrapping an empty operand). */
  private extractTypeName(node: PSExpression): string {
    if (node.type === 'TypeLiteral')
      return (node as unknown as { typeName: string }).typeName;
    if (node.type === 'CastExpression')
      return (node as PSCastExpression).targetType;
    return psValueToString(this.evalExpr(node, this.global)).replace(/^\[|\]$/g, '');
  }

  private isPureValueNode(node: PSExpression, _env?: PSEnvironment): boolean {
    switch (node.type) {
      case 'ArrayExpression': case 'HashtableExpression': case 'RangeExpression':
      case 'BinaryExpression': case 'UnaryExpression': case 'MemberExpression':
      case 'StaticMemberExpression': case 'IndexExpression': case 'InvocationExpression':
      case 'CastExpression': case 'SubExpression': case 'PipelineExpression':
      case 'ScriptBlock':
        return true;
      case 'LiteralExpression': {
        const k = (node as PSLiteralExpression).kind;
        return k === 'number' || k === 'boolean' || k === 'null'
            || k === 'string' || k === 'expandable';
      }
      case 'VariableExpression': return true;
      default: return false;
    }
  }
}
