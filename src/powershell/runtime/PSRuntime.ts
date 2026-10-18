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

import { simulationNowMs } from '@/network/core/SystemClock';

import { PSLexer }  from '@/powershell/lexer/PSLexer';
import { PSParser } from '@/powershell/parser/PSParser';
import { PS_OPERATOR_PARAMS } from '@/powershell/lexer/PSToken';
import { PSEnvironment, PSValue, seedBuiltins } from '@/powershell/runtime/PSEnvironment';
import { expandString, psValueToString } from '@/powershell/runtime/PSExpansion';
import {
  type ProcessPolicyPort, PROCESS_POLICY_VARIABLE,
  effectiveExecutionPolicy, scriptRefusal,
} from '@/powershell/executionPolicy';
import { isTimeSpan, makeTimeSpan, timeSpanMember, timeSpanStatics } from '@/powershell/runtime/dotnetTimeSpan';
import { booleanMember, boxedNumberMember, charMember, numberMember } from '@/powershell/runtime/dotnetNumber';
import { formatDotNetDate } from '@/powershell/runtime/dotnetDateFormat';
import { adoptMachineDates, dateMember, dateTimeStatics, likeDate, parseDateTime, timeZoneInfoStatics } from '@/powershell/runtime/dotnetDateTime';
import { CmdletRegistry } from '@/powershell/runtime/PSCmdletRegistry';
import { nullProviders } from '@/powershell/providers/NullProviders';
import { PSRuntimeError, RUNTIME_EXCEPTION } from './PSRuntimeError';
import { stringMember } from './semantics/DotNetString';
import { formatString } from './semantics/CompositeFormat';
import { EnumType, PSEnumValue, builtinEnums, enumMember } from './semantics/PSEnum';
import { bindParameters, unboundParameterValue, type BinderHost } from './semantics/PSParameterBinder';
import { exceptionMatches, exceptionShortName, resolveExceptionType, makeExceptionObject, defaultExceptionMessage } from './semantics/PSExceptions';
import { PSChar, PSNumber, ArithmeticFault, compareNumbers, numericKindOf, type NumericKind } from './semantics/PSNumber';
import { PSConversionError, castToChar, castToNumeric, truthiness, type ConversionOptions } from './semantics/PSConvert';
import { bitwise, multiply, negateValue, numericArithmetic } from './semantics/PSOperators';
import { PASS_THROUGH_CMDLETS, unboxDeep } from './semantics/PSUnbox';
import { mathStatics } from './semantics/MathStatics';
import { languageCompare, languageEquals, type CompareContext } from './semantics/PSCompare';
import { compileRegex, regexReplace, regexSplit } from './semantics/PSRegex';
import { splitWithPredicate, splitWithPredicateFromEnd } from './semantics/PSSplit';
import { makeTypeObject } from './semantics/PSTypeObject';
import { ARRAY_ELEMENT_TYPE, describeScalarType, isScalarInstance, parseTypeName, specEquals, stripTypeBrackets, tagArray, typeSpecName, type TypeSpec } from './semantics/PSTypes';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { NativeCommandNeedsAsync, nativeArgv, isNativeProgramName, nativeOutputValue, type NativeResult } from '@/powershell/nativeAsync';
import { formatDefault, hasDefaultColumns, type PSObject } from '@/network/devices/windows/PSPipeline';
import type { PSProviders } from '@/powershell/providers/PSProviders';
import { wildcardMatches, escapeWildcard, unescapeWildcard, hasWildcard } from '@/powershell/runtime/PSWildcard';
import type { ICmdlet, ParameterValueKind } from '@/powershell/cmdlets/ICmdlet';
import type { CmdletContext, IRuntimeRef } from '@/powershell/cmdlets/CmdletContext';
import type {
  PSProgram, PSStatementList, PSStatement,
  PSPipelineStatement, PSAssignmentStatement,
  PSIfStatement, PSWhileStatement, PSDoWhileStatement, PSDoUntilStatement,
  PSForStatement, PSForeachStatement, PSSwitchStatement, PSTryStatement,
  PSFunctionDefinition, PSReturnStatement, PSExitStatement, PSThrowStatement,
  PSPipeline, PSCommand, PSCommandParameter,
  PSExpression, PSLiteralExpression, PSVariableExpression,
  PSBinaryExpression, PSUnaryExpression, PSRangeExpression,
  PSArrayExpression, PSHashtableExpression, PSSubExpressionExpression,
  PSMemberExpression, PSStaticMemberExpression, PSIndexExpression,
  PSInvocationExpression, PSCastExpression, PSCommandExpression,
  PSScriptBlock, PSPipelineExpression,
  PSClassDefinition, PSEnumDefinition, PSPipelineChainStatement, PSTernaryExpression, PSMethodDefinition, PSPropertyDeclaration,
  PSBreakStatement, PSContinueStatement, PSTrapStatement,
} from '@/powershell/parser/PSASTNode';

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1 — Types, signals, and setup
// ═══════════════════════════════════════════════════════════════════════════════

/** Thrown by return statements to unwind the call stack. */
export class ReturnSignal   { constructor(public readonly value: PSValue) {} }
/** `exit [<code>]` — unwinds to the script boundary, not just the function. */
export class ExitSignal     { constructor(public readonly code: number) {} }
/** Thrown by break statements inside loops. Carries optional label for labeled loops. */
export class BreakSignal    { constructor(public readonly label?: string) {} }
/** Thrown by continue statements inside loops. Carries optional label for labeled loops. */
export class ContinueSignal { constructor(public readonly label?: string) {} }

export { PSRuntimeError } from './PSRuntimeError';

function pipelineTarget(pipeInput: PSValue): string | null {
  const first = Array.isArray(pipeInput) ? pipeInput[0] : pipeInput;
  if (first === null || first === undefined) return null;
  if (typeof first === 'string') return first;
  if (typeof first === 'object') {
    const record = first as Record<string, PSValue>;
    for (const key of ['Name', 'DisplayName', 'FullName', 'ProcessName', 'DriveLetter', 'Number']) {
      if (record[key] !== undefined) return psValueToString(record[key]);
    }
  }
  return null;
}

// ─── Static type map ([math], [system.math]) ─────────────────────────────────

const STATIC_TYPES: Record<string, Record<string, PSValue>> = {
  math: mathStatics(),

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

  string: {
    format:           (...args: PSValue[]) => {
      const [fmt, ...rest] = args;
      return String(fmt).replace(/\{(\d+)(?:,(-?\d+))?(?::([^}]+))?\}/g,
        (_m, idx, pad, _spec) => {
          const v = rest[Number.parseInt(String(idx), 10)];
          let body = v === null || v === undefined ? '' : String(v);
          if (pad !== undefined) {
            const w = Number.parseInt(String(pad), 10);
            const need = Math.abs(w) - body.length;
            if (need > 0) body = w < 0 ? body + ' '.repeat(need) : ' '.repeat(need) + body;
          }
          return body;
        }) as PSValue;
    },
    isnullorempty:    (s: PSValue) => (s === null || s === undefined || String(s) === '') as PSValue,
    isnullorwhitespace: (s: PSValue) => (s === null || s === undefined || String(s).trim() === '') as PSValue,
    join:             (sep: PSValue, ...parts: PSValue[]) => {
      const list = parts.length === 1 && Array.isArray(parts[0]) ? parts[0] as PSValue[] : parts;
      return list.map(String).join(String(sep)) as PSValue;
    },
    concat:           (...parts: PSValue[]) => parts.map(String).join('') as PSValue,
    compare:          (a: PSValue, b: PSValue) => {
      const sa = String(a), sb = String(b);
      return (sa < sb ? -1 : sa > sb ? 1 : 0) as PSValue;
    },
    empty:            '' as PSValue,
  } as Record<string, PSValue>,

  int32: {
    parse:    (s: PSValue) => {
      const n = Number.parseInt(String(s), 10);
      if (!Number.isFinite(n)) throw new Error(`Cannot convert '${s}' to int`);
      return n as PSValue;
    },
    tryparse: (s: PSValue) => Number.isFinite(Number.parseInt(String(s), 10)) as PSValue,
    minvalue: -2147483648 as PSValue,
    maxvalue:  2147483647 as PSValue,
  } as Record<string, PSValue>,

  int64: {
    parse:    (s: PSValue) => {
      const n = Number(BigInt(String(s)));
      return n as PSValue;
    },
    // Un Int64 ne tient PAS dans un `number` JavaScript : ecrits en
    // litteraux numeriques, ces deux bornes s'affichaient
    // `9223372036854776000` — arrondies au seizieme chiffre, une valeur
    // qu'un eleve recopie et qui est fausse. `PSValue` n'admet pas
    // `bigint` ; la chaine affiche la borne EXACTE, comme PowerShell.
    minvalue: '-9223372036854775808' as PSValue,
    maxvalue: '9223372036854775807' as PSValue,
  } as Record<string, PSValue>,

  double: {
    parse:    (s: PSValue) => {
      const n = Number.parseFloat(String(s));
      if (!Number.isFinite(n)) throw new Error(`Cannot convert '${s}' to double`);
      return n as PSValue;
    },
    nan:      Number.NaN as PSValue,
    epsilon:  Number.EPSILON as PSValue,
    minvalue: -Number.MAX_VALUE as PSValue,
    maxvalue:  Number.MAX_VALUE as PSValue,
  } as Record<string, PSValue>,

  convert: {
    tostring:  (v: PSValue) => String(v ?? '') as PSValue,
    toint32:   (v: PSValue) => Number.parseInt(String(v), 10) as PSValue,
    toint64:   (v: PSValue) => Number(BigInt(String(v))) as PSValue,
    todouble:  (v: PSValue) => Number.parseFloat(String(v)) as PSValue,
    toboolean: (v: PSValue) => (v !== null && v !== undefined && v !== false && v !== 0 && v !== '') as PSValue,
    tobase64string: (v: PSValue) => Buffer.from(Array.isArray(v) ? Uint8Array.from(v as number[]) : String(v)).toString('base64') as PSValue,
    frombase64string: (v: PSValue) => Buffer.from(String(v), 'base64').toString() as PSValue,
  } as Record<string, PSValue>,

  environment: {
    machinename:        'WIN-LOCAL' as PSValue,
    username:           'Administrator' as PSValue,
    osversion:          { Platform: 'Win32NT', VersionString: 'Microsoft Windows NT 10.0.19041.0' } as unknown as PSValue,
    currentdirectory:   'C:\\' as PSValue,
    newline:            '\r\n' as PSValue,
    tickcount:          () => simulationNowMs() as PSValue,
    getenvironmentvariable: (name: PSValue) => process.env[String(name)] ?? null as PSValue,
  } as Record<string, PSValue>,
} as Record<string, Record<string, PSValue>>;
const INPUT_CURSOR = '__inputCursor__';

const SPLIT_SIMPLE_MATCH = 1;
const SPLIT_REGEX_MATCH = 2;
const SPLIT_IGNORE_PATTERN_WHITESPACE = 8;
const SPLIT_MULTILINE = 16;
const SPLIT_SINGLELINE = 32;
const SPLIT_IGNORE_CASE = 64;
const SPLIT_EXPLICIT_CAPTURE = 128;

const KNOWN_TYPE_NAMES: ReadonlySet<string> = new Set([
  'null', 'void', 'type', 'switch', 'hashtable', 'ordered', 'pscustomobject', 'psobject', 'scriptblock', 'timespan',
  'datetime', 'datetimeoffset', 'version', 'xml', 'regex', 'guid', 'uri', 'ipaddress', 'securestring', 'pscredential',
  'psmoduleinfo', 'cmdletinfo', 'commandinfo', 'wildcardpattern', 'adsi', 'wmi', 'wmiclass', 'wmisearcher', 'cimsession',
  'math', 'convert', 'environment', 'console', 'array', 'string', 'char', 'bool', 'object', 'enum', 'exception',
  'errorrecord', 'nullstring', 'dbnull', 'bigint', 'biginteger', 'datetimeoffset', 'mailaddress', 'arraylist',
  'stringbuilder', 'cultureinfo', 'ipendpoint', 'physicaladdress', 'pspropertyinfo', 'pslistmodifier', 'powershell',
  'runspace', 'initialsessionstate', 'psvariable', 'alias', 'x500distinguishedname', 'x509certificate', 'x509certificate2',
  'byte', 'sbyte', 'int', 'int16', 'int32', 'int64', 'uint16', 'uint32', 'uint64', 'uint', 'ushort', 'ulong', 'long',
  'short', 'float', 'single', 'double', 'decimal', 'boolean', 'nullable', 'collections', 'delegate', 'attribute',
]);

STATIC_TYPES['wildcardpattern'] = {
  escape: (s: PSValue) => escapeWildcard(String(s)),
  unescape: (s: PSValue) => unescapeWildcard(String(s)),
  containswildcardcharacters: (s: PSValue) => hasWildcard(String(s)),
} as Record<string, PSValue>;
STATIC_TYPES['system.management.automation.wildcardpattern'] = STATIC_TYPES['wildcardpattern'];
STATIC_TYPES['system.math'] = STATIC_TYPES['math'];
STATIC_TYPES['system.text.regularexpressions.regex'] = STATIC_TYPES['regex'];
STATIC_TYPES['system.guid'] = STATIC_TYPES['guid'];
STATIC_TYPES['io.path'] = STATIC_TYPES['system.io.path'];
STATIC_TYPES['path'] = STATIC_TYPES['system.io.path'];
STATIC_TYPES['system.string'] = STATIC_TYPES['string'];
STATIC_TYPES['system.int32'] = STATIC_TYPES['int32'];
STATIC_TYPES['int'] = STATIC_TYPES['int32'];
STATIC_TYPES['system.int64'] = STATIC_TYPES['int64'];
STATIC_TYPES['long'] = STATIC_TYPES['int64'];
STATIC_TYPES['system.double'] = STATIC_TYPES['double'];
STATIC_TYPES['system.convert'] = STATIC_TYPES['convert'];
STATIC_TYPES['security.principal.windowsbuiltinrole'] = {
  administrator: 'Administrator', user: 'User', guest: 'Guest', poweruser: 'PowerUser',
  accountoperator: 'AccountOperator', systemoperator: 'SystemOperator', printoperator: 'PrintOperator',
  backupoperator: 'BackupOperator', replicator: 'Replicator',
} as Record<string, PSValue>;
STATIC_TYPES['system.security.principal.windowsbuiltinrole'] = STATIC_TYPES['security.principal.windowsbuiltinrole'];
STATIC_TYPES['system.environment'] = STATIC_TYPES['environment'];

// ─── Collection type factories ────────────────────────────────────────────────

const makeArrayList = (): PSValue => {
  const arr: PSValue[] = [];
  (arr as unknown as Record<string, PSValue>)['__list__'] = arr as unknown as PSValue;
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
  private readonly lexer: PSLexer;
  private readonly parser: PSParser;
  readonly edition: 'desktop' | 'core';
  private readonly conversion: ConversionOptions;
  readonly global: PSEnvironment;
  private outputLines: string[] = [];
  private warningLines = 0;
  private nativeReplay: { results: NativeResult[]; cursor: number } | null = null;
  private interactive: {
    statements: PSStatement[]; traps: PSTrapStatement[];
    index: number; mark: number; results: NativeResult[];
  } | null = null;

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
  private emittedSince(lines: number, warnings: number): boolean {
    return this.outputLines.length - lines > this.warningLines - warnings;
  }

  private renderValue(result: PSValue): void {
    if (result instanceof PSNumber || result instanceof PSChar) {
      this.outputLines.push(psValueToString(result));
      return;
    }
    if (result instanceof Date) {
      this.outputLines.push(formatDotNetDate(result, 'dddd, MMMM d, yyyy h:mm:ss tt'));
      return;
    }
    if (Array.isArray(result)) {
      // Array of plain objects (all elements are non-null records with at
      // least one string-keyed field) → table format.
      const arr = result as PSValue[];
      if (arr.length > 0 && arr.every(v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof PSNumber) && !(v instanceof PSChar))) {
        const formatted = formatDefault(arr as unknown as PSObject[]);
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
        && (this.allScalarValues(result as Record<string, unknown>)
            || hasDefaultColumns(result as unknown as PSObject))) {
      const formatted = formatDefault([result as unknown as PSObject]);
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
      // TimeSpan values (`{ __type: 'TimeSpan', TotalMilliseconds, ... }`,
      // e.g. Get-ADDefaultDomainPasswordPolicy's MaxPasswordAge) are a value
      // type like Date — allow them through to table/list formatting rather
      // than falling back to the `Key=Value; ...` inline form.
      if (isTimeSpan(v)) continue;
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
    const ast    = this.parser.parse(tokens, code);
    if (this.astCache.size >= PSRuntime.AST_CACHE_LIMIT) {
      // Drop the oldest entry (first key in iteration order).
      const oldest = this.astCache.keys().next().value;
      if (oldest !== undefined) this.astCache.delete(oldest);
    }
    this.astCache.set(code, ast);
    return ast;
  }

  /** User-defined functions survive between execute() calls. */
  private readonly functions = new Map<string, { block: PSScriptBlock; isFilter: boolean; declaredName: string }>();
  private readonly functionSources = new Map<string, string>();

  /** User-defined PowerShell classes. */
  private readonly userClasses = new Map<string, PSClassDefinition>();
  private readonly enums = builtinEnums();

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

  historyHook: (() => readonly string[]) | null = null;

  listHistory(): readonly string[] {
    return this.historyHook?.() ?? [];
  }

  private scriptRequirementRefusal(path: string, content: string): string | null {
    if (!/^\s*#requires\b[^\r\n]*-RunAsAdministrator/im.test(content)) return null;
    const user = this.lookupEnvironment('USERNAME');
    if (this.providers.users?.isAdmin(user) ?? true) return null;
    const leaf = path.replace(/^.*[\\/]/, '');
    return `The script '${leaf}' cannot be run because it contains a "#requires" statement for running as Administrator. `
      + 'The current Windows PowerShell session is not running as Administrator. '
      + 'Start Windows PowerShell by using the Run as Administrator option, and then try running the script again.';
  }

  private scriptPolicyRefusal(path: string, content: string): string | null {
    const port: ProcessPolicyPort = {
      read: () => {
        const v = this.global.get(PROCESS_POLICY_VARIABLE);
        return v === undefined || v === null || v === '' ? null : String(v);
      },
      write: (value: string | null) => {
        this.global.set(PROCESS_POLICY_VARIABLE, value === null ? '' : value);
      },
    };
    const { policy } = effectiveExecutionPolicy(this.providers, port);
    return scriptRefusal(policy, path) ?? this.scriptRequirementRefusal(path, content);
  }

  constructor(
    registry: CmdletRegistry,
    providers: PSProviders = nullProviders(),
    globalEnv?: PSEnvironment,
    edition: 'desktop' | 'core' = 'desktop',
  ) {
    this.registry  = registry;
    this.providers = providers;
    this.edition   = edition;
    this.conversion = { core: edition === 'core' };
    this.lexer     = new PSLexer({ core: edition === 'core' });
    this.parser    = new PSParser({ core: edition === 'core' });
    this.global    = globalEnv ?? new PSEnvironment();
    if (!globalEnv) {
      seedBuiltins(this.global, edition);
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
    this.seedVersionTableFromRegistry();
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
      if (c.coreOnly === true && this.edition === 'desktop') continue;
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

  /**
   * The kind of value a cmdlet's parameter takes, for `-Param <Tab>`.
   * `null` when the cmdlet declares nothing for it — the shell then keeps
   * its default rather than guessing.
   */
  getParameterValueKind(command: string, parameter: string): ParameterValueKind | null {
    const declared = this.registry.resolve(command.toLowerCase())?.parameterValues;
    if (!declared) return null;
    const wanted = parameter.replace(/^-/, '').toLowerCase();
    for (const [name, kind] of Object.entries(declared)) {
      if (name.toLowerCase() === wanted) return kind;
    }
    return null;
  }

  /** The live values behind a kind, read from this machine's own providers. */
  getParameterValues(kind: ParameterValueKind): string[] {
    switch (kind) {
      case 'interfaceAlias':
        return (this.providers.network?.getAdapters() ?? []).map(a => a.name);
      case 'interfaceIndex':
        return (this.providers.network?.getAdapters() ?? []).map(a => String(a.ifIndex));
      case 'addressFamily':
        return ['IPv4', 'IPv6'];
      case 'serviceName':
        return (this.providers.services?.listServices() ?? []).map(s => s.name);
      case 'processName':
        return [...new Set((this.providers.processes?.listProcesses() ?? []).map(p => p.name))];
      case 'localUser':
        return (this.providers.users?.listUsers() ?? []).map(u => u.name);
      case 'firewallProfile':
        return (this.providers.network?.getFirewallProfiles() ?? []).map(p => p.name);
      case 'path':
      case 'directory':
        return [];
    }
  }

  getPositionalValueKind(command: string): ParameterValueKind | null {
    const declared = this.registry.resolve(command.toLowerCase())?.parameterValues;
    if (!declared) return null;
    for (const [name, kind] of Object.entries(declared)) {
      if (name.toLowerCase() === 'path' || name.toLowerCase() === 'filepath') return kind;
    }
    return null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Execute a PowerShell script. Pipeline output is collected and returned as a string. */
  execute(code: string): string {
    this.outputLines = [];
    this.indexFunctionSources(code);
    const ast = this.parseCached(code);
    try {
      this.execTopLevel(ast.body.statements, this.global);
    } catch (e) {
      // `exit` outside any script stops the remaining statements and
      // records the code. It is an end, not an error, so what was already
      // written stays written.
      if (!(e instanceof ExitSignal)) throw e;
      this.global.set('LASTEXITCODE', e.code);
    }
    return this.outputLines.join('\n');
  }

  private applyDefaultParams(
    fnName: string,
    named: Record<string, PSValue>,
    env: PSEnvironment,
  ): Record<string, PSValue> {
    const table = env.get('PSDefaultParameterValues') as Record<string, PSValue> | undefined;
    if (!table || typeof table !== 'object') return named;
    const result = { ...named };
    for (const [key, value] of Object.entries(table)) {
      const sep = key.indexOf(':');
      if (sep < 0) continue;
      const cmdPattern = key.slice(0, sep);
      const paramName = key.slice(sep + 1).toLowerCase();
      if (!this.matchCmdPattern(cmdPattern, fnName)) continue;
      if (result[paramName] === undefined) result[paramName] = value;
    }
    return result;
  }

  private matchCmdPattern(pattern: string, name: string): boolean {
    const p = pattern.toLowerCase();
    const n = name.toLowerCase();
    if (!p.includes('*') && !p.includes('?')) return p === n;
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(n);
  }

  private indexFunctionSources(code: string): void {
    const re = /\bfunction\s+([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const name = m[1].toLowerCase();
      const openAt = m.index + m[0].length - 1;
      let depth = 1, i = openAt + 1, inStr: string | null = null, esc = false;
      while (i < code.length && depth > 0) {
        const ch = code[i];
        if (esc) { esc = false; i++; continue; }
        if (inStr) {
          if (ch === '\\') esc = true;
          else if (ch === inStr) inStr = null;
        } else if (ch === '"' || ch === "'") { inStr = ch; }
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      if (depth === 0) {
        this.functionSources.set(name, code.slice(openAt, i));
      }
    }
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
      const warningsBefore = this.warningLines;
      const result = this.execStatement(stmt, env);
      const emitted = this.emittedSince(before, warningsBefore);
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
        if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ExitSignal) throw e;
        const trap = traps[0];
        env.set('_', e instanceof Error ? e : new Error(String(e)));
        try {
          this.runTrapBody(trap.body, env);
        } catch (te) {
          if (te instanceof ContinueSignal && !te.label) continue;
          if (te instanceof BreakSignal    && !te.label) return;
          throw te;
        }
      }
    }
  }

  private runTrapBody(block: PSScriptBlock, env: PSEnvironment): void {
    if (!block.body) return;
    for (const s of block.body.statements) {
      const before = this.outputLines.length;
      const warningsBefore = this.warningLines;
      const r = this.execStatement(s, env);
      const emitted = this.emittedSince(before, warningsBefore);
      if (!emitted && r !== null && r !== undefined
          && s.type !== 'AssignmentStatement'
          && s.type !== 'FunctionDefinition') {
        this.renderValue(r);
      }
    }
  }

  /**
   * REPL variant: bare expressions that produce a value without explicitly
   * writing to the pipeline (e.g. `$x`, `2+3`) are echoed to output.
   */
  executeInteractive(code: string): string {
    this.beginInteractive(code);
    return this.resumeInteractive();
  }

  beginInteractive(code: string): void {
    this.outputLines = [];
    const ast = this.parseCached(code);
    const traps: PSTrapStatement[] = [];
    const statements: PSStatement[] = [];
    for (const statement of ast.body.statements) {
      if (statement.type === 'TrapStatement') traps.push(statement as PSTrapStatement);
      else statements.push(statement);
    }
    this.interactive = { statements, traps, index: 0, mark: 0, results: [] };
  }

  provideNativeResult(result: NativeResult): void {
    this.interactive?.results.push(result);
  }

  resumeInteractive(): string {
    const run = this.interactive;
    if (run === null) return '';
    while (run.index < run.statements.length) {
      const statement = run.statements[run.index];
      this.outputLines.length = run.mark;
      this.nativeReplay = { results: run.results, cursor: 0 };
      try {
        this.runInteractiveStatement(statement, this.global);
      } catch (e) {
        if (e instanceof NativeCommandNeedsAsync) {
          if (this.nativeReplay !== null && this.nativeReplay.cursor < run.results.length) {
            this.interactive = null;
            this.nativeReplay = null;
            throw this.notFound(e.command);
          }
          throw e;
        }
        if (!this.trapInteractive(run, e)) { this.interactive = null; this.nativeReplay = null; throw e; }
        if (run.index < 0) break;
      }
      run.index++;
      run.results = [];
      run.mark = this.outputLines.length;
    }
    this.interactive = null;
    this.nativeReplay = null;
    return this.outputLines.join('\n');
  }

  private runInteractiveStatement(stmt: PSStatement, env: PSEnvironment): void {
    const wasEmpty = this.outputLines.length;
    const warningsBefore = this.warningLines;
    const result = this.execStatement(stmt, env);
    const didOutput = this.emittedSince(wasEmpty, warningsBefore);
    if (!didOutput && stmt.type !== 'AssignmentStatement' && result !== null && result !== undefined) {
      this.renderValue(result);
    }
  }

  private trapInteractive(run: NonNullable<PSRuntime['interactive']>, e: unknown): boolean {
    if (run.traps.length === 0) return false;
    if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ExitSignal) return false;
    this.global.set('_', e instanceof Error ? e : new Error(String(e)));
    try {
      this.runTrapBody(run.traps[0].body, this.global);
    } catch (trapSignal) {
      if (trapSignal instanceof ContinueSignal && !trapSignal.label) return true;
      if (trapSignal instanceof BreakSignal && !trapSignal.label) { run.index = -1; return true; }
      throw trapSignal;
    }
    return true;
  }

  /** Execute code and return the last produced PSValue (without stringification). Used by IEX. */
  executeForValue(code: string): PSValue {
    const tokens = this.lexer.tokenize(code);
    const ast    = this.parser.parse(tokens, code);
    let last: PSValue = null;
    for (const stmt of ast.body.statements) {
      last = this.execStatement(stmt, this.global);
    }
    return last;
  }

  getVariable(name: string): PSValue {
    return this.locationVariable(name) ?? this.global.get(name);
  }
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
        if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ExitSignal) throw e;
        const trap = traps[0];
        env.set('_', e instanceof Error ? e : new Error(String(e)));
        try {
          this.runTrapBody(trap.body, env);
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
    let result: PSValue;
    switch (node.type) {
      case 'PipelineStatement':   result = this.execPipelineStmt(node as PSPipelineStatement, env); break;
      case 'AssignmentStatement': result = this.execAssignment(node as PSAssignmentStatement, env); break;
      case 'IfStatement':         result = this.execIf(node as PSIfStatement, env); break;
      case 'WhileStatement':      result = this.execWhile(node as PSWhileStatement, env); break;
      case 'DoWhileStatement':    result = this.execDoWhile(node as PSDoWhileStatement, env); break;
      case 'DoUntilStatement':    result = this.execDoUntil(node as PSDoUntilStatement, env); break;
      case 'ForStatement':        result = this.execFor(node as PSForStatement, env); break;
      case 'ForeachStatement':    result = this.execForeach(node as PSForeachStatement, env); break;
      case 'SwitchStatement':     result = this.execSwitch(node as PSSwitchStatement, env); break;
      case 'TryStatement':        result = this.execTry(node as PSTryStatement, env); break;
      case 'FunctionDefinition':  result = this.execFunctionDef(node as PSFunctionDefinition, env); break;
      case 'PipelineChain':       return this.execPipelineChain(node as PSPipelineChainStatement, env);
      case 'ClassDefinition':     result = this.execClassDef(node as PSClassDefinition, env); break;
      case 'EnumDefinition':      result = this.execEnumDef(node as PSEnumDefinition, env); break;
      case 'ReturnStatement':     return this.execReturn(node as PSReturnStatement, env);
      case 'ExitStatement':       return this.execExit(node as PSExitStatement, env);
      case 'BreakStatement':      throw new BreakSignal((node as PSBreakStatement).label ?? undefined);
      case 'ContinueStatement':   throw new ContinueSignal((node as PSContinueStatement).label ?? undefined);
      case 'ThrowStatement':      return this.execThrow(node as PSThrowStatement, env);
      case 'TrapStatement':       return null; // collected by execStatementList
      default:                    return null;
    }
    // Track pipeline voidability for runBlockCapture. Assignments and
    // `$x++`/`$x+=1` are voidable in PowerShell; an if/loop/switch/try is
    // voidable iff the last inner statement it ran was — so for those we
    // PRESERVE the flag the recursive execStatement already set.
    switch (node.type) {
      case 'AssignmentStatement':
        this.lastStmtVoid = true; break;
      case 'PipelineStatement': {
        const p = node as PSPipelineStatement;
        this.lastStmtVoid = p.pipeline.commands.length === 1
          && p.pipeline.commands[0].parameters.length === 0
          && p.pipeline.commands[0].arguments.length === 0
          && (p.pipeline.commands[0].name as { type?: string })?.type === 'AssignmentStatement';
        break;
      }
      case 'IfStatement':      case 'WhileStatement':   case 'DoWhileStatement':
      case 'DoUntilStatement': case 'ForStatement':     case 'ForeachStatement':
      case 'SwitchStatement':  case 'TryStatement':
        break; // preserve inner statement's voidability
      default:
        this.lastStmtVoid = false;
    }
    return result;
  }

  /** Set by execStatement: was the last executed statement voidable
   *  (assignment / `$x++`)? Consumed only at the runBlockCapture boundary. */
  private lastStmtVoid = false;

  // ── Assignment ─────────────────────────────────────────────────────────────

  private execAssignment(node: PSAssignmentStatement, env: PSEnvironment): PSValue {
    if (node.operator === '??=') {
      const current = this.evalExpr(node.target as PSExpression, env);
      if (current !== null && current !== undefined) return current;
      return this.execAssignment({ ...node, operator: '=' }, env);
    }
    const rhs = this.evalExpr(node.value, env);
    if (node.destructuringTargets !== undefined) return this.destructure(node.destructuringTargets, rhs, env);

    // `$null = <expr>` (and, less commonly, `$true =`/`$false =`) is the
    // idiomatic PowerShell way to discard a cmdlet's return value — the
    // parser resolves these automatic variables to LiteralExpression nodes
    // (see parsePrimaryExpression), so the assignment target here never
    // carries a variable name to write to. Real PowerShell silently
    // discards the write rather than erroring or actually mutating $null.
    if (node.target.type === 'LiteralExpression') return rhs;

    if (node.target.type === 'IndexExpression' || node.target.type === 'MemberExpression') {
      const result = this.computeAssignResult(node, rhs, env);
      this.writeTarget(node.target, result, env);
      return result;
    }

    const target = node.target as PSVariableExpression;
    const varName = target.varName ?? (target as unknown as { name: string }).name;
    const scope = target.scope;
    if (node.typeConstraints !== undefined) env.constrain(varName, node.typeConstraints);
    const constrained = (value: PSValue): PSValue => {
      const types = env.constraintOf(varName);
      if (types === undefined) return value;
      let converted = value;
      for (let i = types.length - 1; i >= 0; i--) converted = this.psCast(converted, types[i]);
      return converted;
    };

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

    if (node.operator === '=') { const stored = constrained(rhs); writeVar(varName, stored); return stored; }

    const readCurrent = (): PSValue => {
      if (scope === 'env') return this.providers.environment?.get(varName) ?? '';
      if (scope === 'global' || scope === 'script') return env.getGlobal(varName);
      return env.get(varName);
    };
    const current = readCurrent() ?? 0;
    const result = constrained(this.applyCompound(node.operator, current, rhs));
    updateVar(varName, result);
    return node.postfix === true ? current : result;
  }

  private destructure(targets: PSVariableExpression[], value: PSValue, env: PSEnvironment): PSValue {
    const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
    targets.forEach((target, index) => {
      const name = target.varName ?? (target as unknown as { name: string }).name;
      const assigned = index === targets.length - 1 && values.length > targets.length
        ? values.slice(index)
        : values[index] ?? null;
      env.set(name, assigned as PSValue);
    });
    return value;
  }

  private applyCompound(op: PSAssignmentStatement['operator'], current: PSValue, rhs: PSValue): PSValue {
    switch (op) {
      case '+=': return this.applyPlus(current, rhs);
      case '-=': return this.arithmetic('-', current, rhs);
      case '*=': return this.applyMultiply(current, rhs);
      case '/=': return this.arithmetic('/', current, rhs);
      case '%=': return this.arithmetic('%', current, rhs);
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
    if (node.redirections.length === 0) {
      return this.execPipeline(node.pipeline, env);
    }
    // The pipeline's success stream is whatever it emits to outputLines
    // (Write-Output etc. emit there during execution). Snapshot first so a
    // stdout redirect can divert that stream to the file instead of the
    // console — real PowerShell: `echo x > f.txt` prints nothing.
    const before = this.outputLines.length;
    const result = this.execPipeline(node.pipeline, env);
    const emitted = this.outputLines.slice(before);
    let stdoutRedirected = false;

    for (const redir of node.redirections) {
      if (!redir.target) continue;
      const filePath = psValueToString(this.evalExpr(redir.target, env));
      if (!filePath) continue;
      const fs = this.providers.filesystem;
      if (!fs) continue;

      const isStdout = redir.op === '>' || redir.op === '>>'
        || redir.op === '*>' || redir.op === '*>>';
      const isAppend = redir.op === '>>' || redir.op === '2>>' || redir.op === '*>>';

      // Prefer the actual emitted stream; fall back to the return value
      // for cmdlets that return without emitting.
      const lines = emitted.length > 0
        ? emitted
        : (Array.isArray(result)
            ? (result as PSValue[]).map(v => psValueToString(v))
            : result === null || result === undefined ? [] : [psValueToString(result)]);
      // PowerShell terminates the redirected content with a newline, so
      // successive `>>` appends land on their own lines.
      const content = lines.length ? lines.join('\n') + '\n' : '';

      if (isAppend) fs.appendFile(filePath, content);
      else          fs.writeFile(filePath, content);

      if (isStdout) stdoutRedirected = true;
    }

    // Remove the diverted lines from the console stream.
    if (stdoutRedirected) {
      this.outputLines.length = before;
      return null;
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
   * Run a script block's body directly in `scopeEnv` (no fresh child scope)
   * with `$_`/`$PSItem` bound. ForEach-Object uses this so its
   * -Begin/-Process/-End blocks (and every -Process iteration) share one
   * scope — `$acc=0; … $acc+=$_` accumulates as it does in real PowerShell.
   * The previous `$_`/`$PSItem` are saved and restored so the binding does
   * not leak past the loop.
   */
  invokeBlockInScope(
    block: PSScriptBlock,
    scopeEnv: PSEnvironment,
    dollarUnderscore: PSValue,
  ): PSValue {
    const prevU = scopeEnv.has('_') ? scopeEnv.get('_') : undefined;
    const prevI = scopeEnv.has('PSItem') ? scopeEnv.get('PSItem') : undefined;
    scopeEnv.set('_', dollarUnderscore);
    scopeEnv.set('PSItem', dollarUnderscore);
    try {
      if (block.beginBlock)   this.execStatementList(block.beginBlock,   scopeEnv);
      if (block.processBlock) this.execStatementList(block.processBlock, scopeEnv);
      if (block.endBlock)     this.execStatementList(block.endBlock,     scopeEnv);
      if (!block.body) return null;
      return this.aggregateCaptured(this.runBlockCapture(block.body, scopeEnv));
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    } finally {
      if (prevU === undefined) scopeEnv.delete('_');     else scopeEnv.set('_', prevU);
      if (prevI === undefined) scopeEnv.delete('PSItem'); else scopeEnv.set('PSItem', prevI);
    }
  }

  /**
   * Build a dynamic `[Environment]` / `[System.Environment]` static type that
   * delegates to the device-backed environment provider. Constructed per call
   * (cheap, just closures) so it always reflects the current provider state.
   */
  private lookupEnvironment(name: string): string {
    const provider = this.providers.environment;
    if (provider) {
      const v = provider.get(name);
      if (v !== undefined && v !== null) return String(v);
    }
    if (this.envVarHook) {
      const v = this.envVarHook(name);
      if (v !== null) return v;
    }
    return process.env[name.toUpperCase()] ?? '';
  }

  private currentWindowsIdentity(): Record<string, PSValue> {
    const name = this.lookupEnvironment('USERNAME');
    const domain = this.lookupEnvironment('USERDOMAIN');
    const users = this.providers.users;
    const account = users?.getUser(name) ?? null;
    const groups = (users?.listGroups() ?? [])
      .filter(group => group.members.some(member => member.toLowerCase() === name.toLowerCase()));
    return {
      Name: `${domain}\\${name}`,
      IsAuthenticated: true,
      IsAnonymous: false,
      IsGuest: name.toLowerCase() === 'guest',
      IsSystem: false,
      AuthenticationType: 'NTLM',
      ImpersonationLevel: 'None',
      User: { Value: account?.sid ?? '' },
      Groups: [{ Value: 'S-1-1-0' }, ...groups.map(group => ({ Value: group.sid }))],
    } as unknown as Record<string, PSValue>;
  }

  private static readonly BUILTIN_ROLE_GROUPS: Readonly<Record<string, string>> = {
    administrator: 'Administrators', user: 'Users', guest: 'Guests', poweruser: 'Power Users',
    accountoperator: 'Account Operators', systemoperator: 'Server Operators', printoperator: 'Print Operators',
    backupoperator: 'Backup Operators', replicator: 'Replicator',
  };

  private static readonly BUILTIN_RID_GROUPS: Readonly<Record<number, string>> = {
    544: 'Administrators', 545: 'Users', 546: 'Guests', 547: 'Power Users', 548: 'Account Operators',
    549: 'Server Operators', 550: 'Print Operators', 551: 'Backup Operators', 552: 'Replicator',
  };

  private windowsPrincipalOf(identity: PSValue): Record<string, PSValue> {
    const full = String((identity as Record<string, PSValue> | null)?.['Name'] ?? '');
    const name = full.includes('\\') ? full.slice(full.lastIndexOf('\\') + 1) : full;
    const users = this.providers.users;
    const isMember = (role: PSValue): boolean => {
      const raw = typeof role === 'number'
        ? PSRuntime.BUILTIN_RID_GROUPS[role] ?? ''
        : String(role ?? '').replace(/^.*\\/, '');
      const group = PSRuntime.BUILTIN_ROLE_GROUPS[raw.toLowerCase()] ?? raw;
      if (group === '') return false;
      if (group.toLowerCase() === 'administrators') return users?.isAdmin(name) ?? false;
      const known = (users?.listGroups() ?? []).find(candidate => candidate.name.toLowerCase() === group.toLowerCase());
      return known?.members.some(member => member.toLowerCase() === name.toLowerCase()) ?? false;
    };
    return { Identity: identity, IsInRole: isMember } as unknown as Record<string, PSValue>;
  }

  private buildEnvironmentType(): Record<string, PSValue> {
    const lookup = (name: string): string => this.lookupEnvironment(name);
    const provider = this.providers.environment;
    // Property-style entries are eager scalars (computed at access time so the
    // freshest provider state is used). Method-style entries are functions
    // that the runtime invokes through InvocationExpression.
    return {
      username:               lookup('USERNAME') as PSValue,
      machinename:            lookup('COMPUTERNAME') as PSValue,
      userdomainname:         lookup('USERDOMAIN') as PSValue,
      osversion:              { Platform: 'Win32NT', Version: '10.0.22631' } as Record<string, PSValue>,
      newline:                '\r\n' as PSValue,
      currentdirectory:       'C:\\' as PSValue,
      processorcount:         (Number(lookup('NUMBER_OF_PROCESSORS')) || 1) as PSValue,
      tickcount:              simulationNowMs() as PSValue,
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
        // Real Windows expands %VAR% in "Shell Folders" values (they're
        // stored as REG_EXPAND_SZ) at read time, not when the GPO writes
        // them — same convention here.
        const expand = (raw: string) => raw.replace(/%([^%]+)%/g, (m, name: string) => lookup(name) || m);
        const shellFolder = (valueName: string): string | null => {
          const reg = this.providers.registry;
          const vals = reg?.getItemPropertyValues?.(
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders');
          const raw = vals?.[valueName];
          return raw !== undefined ? expand(String(raw)) : null;
        };
        if (which.includes('desktop'))                                  return shellFolder('Desktop') ?? `${lookup('USERPROFILE')}\\Desktop`;
        if (which.includes('mydocuments') || which === 'personal')      return shellFolder('Personal') ?? `${lookup('USERPROFILE')}\\Documents`;
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

  /**
   * A `.ps1` invoked as a command. This is where `exit` stops: it ends
   * the script and sets $LASTEXITCODE, and the caller carries on — which
   * is what separates a script from a function, where `exit` would keep
   * unwinding.
   */
  private runScriptFile(
    block: PSScriptBlock,
    namedArgs: Record<string, PSValue>,
    positionalArgs: PSValue[],
    parentEnv: PSEnvironment,
    pipelineInput?: PSValue,
  ): PSValue {
    const captured: PSValue[] = [];
    try {
      const value = this.invokeScriptBlock(
        block, namedArgs, positionalArgs, parentEnv, pipelineInput, captured);
      this.global.set('LASTEXITCODE', 0);
      return value;
    } catch (e) {
      if (e instanceof ExitSignal) {
        this.global.set('LASTEXITCODE', e.code);
        return this.aggregateCaptured(captured);
      }
      throw e;
    }
  }

  invokeScriptBlock(
    block: PSScriptBlock,
    namedArgs: Record<string, PSValue>,
    positionalArgs: PSValue[],
    parentEnv: PSEnvironment,
    pipelineInput?: PSValue,
    captured: PSValue[] = [],
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

    this.bindParametersInto(childEnv, block, namedArgs, positionalArgs, parentEnv, null);

    try {
      if (block.beginBlock)   this.execStatementList(block.beginBlock,   childEnv);
      if (block.processBlock) this.execStatementList(block.processBlock, childEnv);
      if (block.endBlock)     this.execStatementList(block.endBlock,     childEnv);
      if (block.body) return this.aggregateCaptured(this.runBlockCapture(block.body, childEnv, captured));
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
    // The parser also fabricates 'AssignmentStatement' / 'StatementExpression'
    // pseudo-nodes force-cast to PSExpression (see PSParser.ts) for contexts
    // like `$x = 1` used as an expression — hence the loose cast here.
    switch (node.type as PSExpression['type'] | 'AssignmentStatement' | 'StatementExpression') {
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
      case 'TernaryExpression': {
        const ternary = node as PSTernaryExpression;
        return this.isTruthy(this.evalExpr(ternary.condition, env))
          ? this.evalExpr(ternary.whenTrue, env) : this.evalExpr(ternary.whenFalse, env);
      }
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

  expandInterpolation(raw: string): string {
    return this.expandDoubleQuotedString(raw, this.global);
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
      // Unset on the device → $null (never the Node.js host environment).
      return null;
    }
    if (scope === 'global' || scope === 'script') return env.getGlobal(varName);
    if (scope === 'local')                        return env.get(varName) ?? null;
    return env.get(varName) ?? null;
  }

  private seedVersionTableFromRegistry(): void {
    const values = this.providers.registry?.getItemPropertyValues?.(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion');
    if (!values) return;
    const table = this.global.get('PSVersionTable') as Record<string, PSValue> | undefined;
    if (!table) return;
    const currentVersion = String(values['CurrentVersion'] ?? '10.0');
    const build = String(values['CurrentBuildNumber'] ?? '');
    if (!build) return;
    if (this.edition === 'core') {
      table['OS'] = `Microsoft Windows ${currentVersion}.${build}`;
      return;
    }
    table['BuildVersion'] = `${currentVersion}.${build}.1`;
  }

  private locationVariable(name: string): PSValue | undefined {
    const fs = this.providers.filesystem;
    if (!fs) return undefined;
    const lower = name.toLowerCase();
    if (lower !== 'pwd' && lower !== 'executioncontext') return undefined;
    const foreign = this.global.get('__psLocation__');
    const cwd = foreign !== undefined && foreign !== null && psValueToString(foreign) !== ''
      ? psValueToString(foreign)
      : fs.getCwd();
    const location = { Path: cwd, ProviderPath: cwd, Provider: 'FileSystem' } as Record<string, PSValue>;
    if (lower === 'pwd') return location;
    return { SessionState: { Path: { CurrentLocation: location } } } as unknown as PSValue;
  }

  private evalVariable(node: PSVariableExpression, env: PSEnvironment): PSValue {
    const name = node.varName ?? node.name;

    if (node.scope !== 'env') {
      const derived = this.locationVariable(name);
      if (derived !== undefined) return derived;
    }

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
      // Unset on the device → $null (never the Node.js host environment).
      return null;
    }

    const val = env.get(name);
    return val === undefined ? null : val;
  }

  private evalBinary(node: PSBinaryExpression, env: PSEnvironment): PSValue {
    const op = node.operator.toLowerCase();

    if (op === '-and') {
      return this.isTruthy(this.evalExpr(node.left, env)) && this.isTruthy(this.evalExpr(node.right, env));
    }
    if (op === '-or') {
      return this.isTruthy(this.evalExpr(node.left, env)) || this.isTruthy(this.evalExpr(node.right, env));
    }
    if (op === '??') {
      const left = this.evalExpr(node.left, env);
      return left !== null && left !== undefined ? left : this.evalExpr(node.right, env);
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
    return this.applyOperator(op, left, right, env);
  }

  private applyOperator(op: string, left: PSValue, right: PSValue, env: PSEnvironment): PSValue {
    switch (op) {
      case '+':  return this.applyPlus(left, right);
      case '-':
        if (left instanceof Date && right instanceof Date) return this.dateDifference(left, right);
        if (left instanceof Date) return likeDate(left, left.getTime() - Number(right)) as unknown as PSValue;
        return this.arithmetic('-', left, right);
      case '*':  return this.applyMultiply(left, right);
      case '/':  return this.arithmetic('/', left, right);
      case '%':  return this.arithmetic('%', left, right);
      case '-and': return this.isTruthy(left) && this.isTruthy(right);
      case '-or':  return this.isTruthy(left) || this.isTruthy(right);
      case '-xor': return this.isTruthy(left) !== this.isTruthy(right);
      case '-band': case '-bor': case '-bxor': case '-shl': case '-shr':
      {
        const combined = this.guarded(() => bitwise(op, left, right));
        const enumOperand = left instanceof PSEnumValue ? left : right instanceof PSEnumValue ? right : null;
        return enumOperand !== null && op !== '-shl' && op !== '-shr' ? enumOperand.definition.fromNumber(Number(combined)) : combined;
      }
      case '-join': return (Array.isArray(left) ? left : [left]).map(psValueToString).join(psValueToString(right));
      case '-f': {
        const args = Array.isArray(right) ? right : [right];
        return formatString(psValueToString(left), args);
      }
      case '-is':    return this.psIs(left, String(right));
      case '-isnot': return !this.psIs(left, String(right));
      case '-as':    return this.psCast(left, stripTypeBrackets(String(right)));
      default:       return this.namedOperator(op, left, right, env);
    }
  }

  private namedOperator(op: string, left: PSValue, right: PSValue, env: PSEnvironment): PSValue {
    const parsed = /^-([ci]?)(eq|ne|gt|ge|lt|le|notlike|like|notmatch|match|notcontains|contains|notin|in|replace|split)$/.exec(op);
    if (parsed === null) throw new PSRuntimeError(`Unknown operator: ${op}`);
    const ignoreCase = parsed[1] !== 'c';
    const base = parsed[2];
    switch (base) {
      case 'contains': return this.collectionHas(left, right, ignoreCase);
      case 'notcontains': return !this.collectionHas(left, right, ignoreCase);
      case 'in': return this.collectionHas(right, left, ignoreCase);
      case 'notin': return !this.collectionHas(right, left, ignoreCase);
      case 'replace': return this.replaceOperator(left, right, ignoreCase, env);
      case 'split': return this.splitOperator(left, right, ignoreCase, env);
      default: break;
    }
    if (Array.isArray(left)) {
      return left.filter(item => this.scalarComparison(base, item, right, ignoreCase, env, false)) as PSValue;
    }
    return this.scalarComparison(base, left, right, ignoreCase, env, true);
  }

  private scalarComparison(
    base: string, left: PSValue, right: PSValue, ignoreCase: boolean, env: PSEnvironment, recordMatches: boolean,
  ): boolean {
    switch (base) {
      case 'eq': return this.psEq(left, right, !ignoreCase);
      case 'ne': return !this.psEq(left, right, !ignoreCase);
      case 'gt': return this.guarded(() => languageCompare(left, right, ignoreCase, this.compareContext())) > 0;
      case 'ge': return this.guarded(() => languageCompare(left, right, ignoreCase, this.compareContext())) >= 0;
      case 'lt': return this.guarded(() => languageCompare(left, right, ignoreCase, this.compareContext())) < 0;
      case 'le': return this.guarded(() => languageCompare(left, right, ignoreCase, this.compareContext())) <= 0;
      case 'like': return this.psLike(psValueToString(left), psValueToString(right), !ignoreCase);
      case 'notlike': return !this.psLike(psValueToString(left), psValueToString(right), !ignoreCase);
      case 'match': return this.psMatch(psValueToString(left), psValueToString(right), !ignoreCase, env, recordMatches);
      default: return !this.psMatch(psValueToString(left), psValueToString(right), !ignoreCase, env, recordMatches);
    }
  }

  private compareContext(): CompareContext {
    return { toDate: (text) => { try { return parseDateTime(text, this.providers) as Date; } catch { return null; } } };
  }

  private collectionHas(collection: PSValue, item: PSValue, ignoreCase: boolean): boolean {
    const items = Array.isArray(collection) ? collection : collection === null || collection === undefined ? [] : [collection];
    return items.some(element => languageEquals(element, item, ignoreCase, this.compareContext()));
  }

  private replaceOperator(left: PSValue, right: PSValue, ignoreCase: boolean, env: PSEnvironment): PSValue {
    if (Array.isArray(left)) return left.map(item => this.replaceOperator(item, right, ignoreCase, env));
    const args = Array.isArray(right) ? right : [right];
    const pattern = psValueToString(args[0] ?? '');
    const replacement = args[1] ?? '';
    const options = { ignoreCase };
    if (this.isScriptBlock(replacement) || typeof replacement === 'function') {
      const call = this.isScriptBlock(replacement)
        ? (m: PSValue) => this.invokeScriptBlock(replacement as PSScriptBlock, {}, [m], env, m)
        : replacement as (...a: PSValue[]) => PSValue;
      return regexReplace(psValueToString(left), pattern, (match) => {
        const groups = match.groups as Record<string, string> | undefined;
        const matchObject = {
          Value: match[0], Length: match[0].length, Index: match.index, Success: true,
          Groups: [...match] as PSValue[], ...(groups ?? {}),
        } as unknown as PSValue;
        return psValueToString(call(matchObject));
      }, options);
    }
    return regexReplace(psValueToString(left), pattern, psValueToString(replacement), options);
  }

  private splitOperator(left: PSValue, right: PSValue, ignoreCase: boolean, env: PSEnvironment): PSValue {
    if (Array.isArray(left)) return left.flatMap(item => this.splitOperator(item, right, ignoreCase, env) as PSValue[]);
    const args = Array.isArray(right) ? right : [right];
    if (args.length === 0) throw new PSRuntimeError(`The argument to operator '-split' is not valid: ${psValueToString(right)}.`);
    const text = psValueToString(left);
    const delimiter = args[0];
    const limit = args[1] === undefined || args[1] === null ? 0 : Number(args[1] instanceof PSNumber ? args[1].toNumber() : args[1]);
    let flags = 0;
    const optionArgument = args[2];
    if (optionArgument !== undefined && optionArgument !== null && psValueToString(optionArgument) !== '') {
      flags = this.splitOptionFlags(optionArgument);
      if (this.isScriptBlock(delimiter)) {
        throw new PSRuntimeError('Options are not allowed on the -split operator with a predicate.', 'System.Management.Automation.ParseException');
      }
      if (ignoreCase) flags |= SPLIT_IGNORE_CASE;
    } else if (ignoreCase) {
      flags = SPLIT_IGNORE_CASE;
    }
    if (this.isScriptBlock(delimiter)) {
      const block = delimiter as PSScriptBlock;
      const test = (character: string, whole: string, index: number): boolean =>
        this.isTruthy(this.invokeScriptBlock(block, {}, [whole, index], env, character));
      return limit >= 0 ? splitWithPredicate(text, test, limit) : splitWithPredicateFromEnd(text, test, limit);
    }
    if ((flags & (SPLIT_SIMPLE_MATCH | SPLIT_REGEX_MATCH)) === 0) flags |= SPLIT_REGEX_MATCH;
    if ((flags & SPLIT_SIMPLE_MATCH) !== 0 && (flags & ~(SPLIT_SIMPLE_MATCH | SPLIT_IGNORE_CASE)) !== 0) {
      throw new PSRuntimeError('The combination of options with the -split operator is not valid.', 'System.Management.Automation.ParseException');
    }
    return regexSplit(text, psValueToString(delimiter ?? ''), limit, {
      ignoreCase: (flags & SPLIT_IGNORE_CASE) !== 0,
      simpleMatch: (flags & SPLIT_SIMPLE_MATCH) !== 0,
      multiline: (flags & SPLIT_MULTILINE) !== 0,
      singleline: (flags & SPLIT_SINGLELINE) !== 0,
      extended: (flags & SPLIT_IGNORE_PATTERN_WHITESPACE) !== 0,
      explicitCapture: (flags & SPLIT_EXPLICIT_CAPTURE) !== 0,
    });
  }

  private splitOptionFlags(argument: PSValue): number {
    const type = this.enums.get('splitoptions');
    if (type === undefined) return 0;
    return this.guarded(() => type.parse(psValueToString(argument)).numeric);
  }

  private evalUnary(node: PSUnaryExpression, env: PSEnvironment): PSValue {
    const val = this.evalExpr(node.operand, env);
    switch (node.operator) {
      case '-':    return this.guarded(() => negateValue(val));
      case '+':    return val;
      case '-not': return !this.isTruthy(val);
      case '!':    return !this.isTruthy(val);
      case '-bnot':return ~(val as number);
      // Unary comma: a single-element array wrapping the operand —
      // even when the operand is itself an array (`(,@(1,2,3)).Count`
      // is 1, not 3).
      case ',':    return [val];
      case '-join': return (Array.isArray(val) ? val : [val]).map(psValueToString).join('');
      case '-split': {
        const pieces = (Array.isArray(val) ? val : [val]).flatMap(item => {
          const trimmed = psValueToString(item).trim();
          return trimmed === '' ? [''] : trimmed.split(/\s+/);
        });
        return pieces;
      }
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
    const startValue = this.evalExpr(node.start, env);
    const endValue   = this.evalExpr(node.end,   env);
    if (this.edition === 'core') {
      const asChar = (value: PSValue): number | null => {
        if (value instanceof PSChar) return value.code;
        return typeof value === 'string' && value.length === 1 && !/\d/.test(value) ? value.charCodeAt(0) : null;
      };
      const first = asChar(startValue);
      const last = asChar(endValue);
      if (first !== null && last !== null) {
        const chars: PSValue[] = [];
        if (first <= last) for (let i = first; i <= last; i++) chars.push(new PSChar(i) as PSValue);
        else for (let i = first; i >= last; i--) chars.push(new PSChar(i) as PSValue);
        return chars;
      }
    }
    const toInt = (value: PSValue): number => Number(this.guarded(() => castToNumeric('int32', value, this.conversion)));
    const start = toInt(startValue);
    const end   = toInt(endValue);
    const arr: number[] = [];
    if (start <= end) for (let i = start; i <= end; i++) arr.push(i);
    else              for (let i = start; i >= end; i--) arr.push(i);
    return arr;
  }

  private typeLiteralObject(typeName: string): PSValue {
    const known: Record<string, [string, string]> = {
      ordered: ['OrderedDictionary', 'System.Collections.Specialized.OrderedDictionary'],
      hashtable: ['Hashtable', 'System.Collections.Hashtable'],
      pscustomobject: ['PSCustomObject', 'System.Management.Automation.PSCustomObject'],
      psobject: ['PSObject', 'System.Management.Automation.PSObject'],
      regex: ['Regex', 'System.Text.RegularExpressions.Regex'],
      datetime: ['DateTime', 'System.DateTime'],
      timespan: ['TimeSpan', 'System.TimeSpan'],
    };
    const lower = typeName.toLowerCase();
    const mapped = known[lower];
    if (mapped !== undefined) return makeTypeObject(mapped[0], mapped[1]);
    const enumType = this.enums.get(lower);
    if (enumType !== undefined) return makeTypeObject(enumType.name, enumType.name);
    const spec = parseTypeName(typeName);
    if (spec.kind === 'named') {
      const short = typeName.slice(typeName.lastIndexOf('.') + 1);
      return makeTypeObject(short, typeName);
    }
    const described = typeSpecName(spec);
    return makeTypeObject(described.name, described.fullName);
  }

  private evalMember(node: PSMemberExpression, env: PSEnvironment): PSValue {
    if (node.object.type === 'TypeLiteral' && typeof node.member === 'string') {
      return this.getMember(this.typeLiteralObject((node.object as unknown as { typeName: string }).typeName), node.member.toLowerCase());
    }
    const obj    = this.evalExpr(node.object, env);
    if (node.nullConditional === true && (obj === null || obj === undefined)) return null;
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

    if (this.isScriptBlock(obj) && (member === 'invoke' || member === 'invokereturnasis')) {
      const block = obj as PSScriptBlock;
      return (...args: PSValue[]) => this.invokeScriptBlock(block, {}, args, env, undefined);
    }

    const intrinsic = this.intrinsicCollectionMethod(obj, member, env);
    if (intrinsic !== null) return intrinsic;

    const found = this.getMember(obj, member);
    if ((found === null || found === undefined) && member.startsWith('get_')) {
      return () => this.getMember(obj, member.slice('get_'.length));
    }
    return found;
  }

  private intrinsicCollectionMethod(obj: PSValue, member: string, env: PSEnvironment): PSValue {
    if (member !== 'where' && member !== 'foreach') return null;
    if (obj === null || obj === undefined) return null;
    if (!Array.isArray(obj) && typeof obj === 'object' && !(obj instanceof PSNumber) && !(obj instanceof PSChar)
        && Object.keys(obj as object).some(key => key.toLowerCase() === member)) return null;
    const items = Array.isArray(obj) ? obj : [obj];
    if (member === 'where') {
      return (condition: PSValue, mode?: PSValue, count?: PSValue): PSValue =>
        this.whereMethod(items, condition, mode === undefined ? 'default' : psValueToString(mode).toLowerCase(),
          count === undefined ? 0 : Number(count), env);
    }
    return (action: PSValue, ...args: PSValue[]): PSValue => this.forEachMethod(items, action, args, env);
  }

  private whereMethod(items: PSValue[], condition: PSValue, mode: string, count: number, env: PSEnvironment): PSValue {
    const test = (item: PSValue): boolean =>
      this.isTruthy(this.invokeScriptBlock(condition as PSScriptBlock, {}, [], env, item));
    const limit = count > 0 ? count : Number.POSITIVE_INFINITY;
    switch (mode) {
      case 'first': return items.filter(test).slice(0, limit);
      case 'last': return items.filter(test).slice(-limit);
      case 'skipuntil': {
        const at = items.findIndex(test);
        return at < 0 ? [] : items.slice(at, at + limit);
      }
      case 'until': {
        const at = items.findIndex(test);
        return (at < 0 ? items : items.slice(0, at)).slice(0, limit);
      }
      case 'split': {
        const kept: PSValue[] = [];
        const rest: PSValue[] = [];
        for (const item of items) (kept.length < limit && test(item) ? kept : rest).push(item);
        return [kept, rest];
      }
      default: return items.filter(test).slice(0, limit);
    }
  }

  private forEachMethod(items: PSValue[], action: PSValue, args: PSValue[], env: PSEnvironment): PSValue {
    const out: PSValue[] = [];
    for (const item of items) {
      let produced: PSValue;
      if (this.isScriptBlock(action)) {
        produced = this.invokeScriptBlock(action as PSScriptBlock, {}, args, env, item);
      } else if (typeof action === 'string') {
        const member = this.getMember(item, action.toLowerCase());
        produced = typeof member === 'function' ? (member as (...a: PSValue[]) => PSValue)(...args) : member;
      } else {
        produced = item;
      }
      if (Array.isArray(produced)) out.push(...produced);
      else if (produced !== null && produced !== undefined) out.push(produced);
    }
    return out;
  }

  private enumTypeOf(argument: PSValue): EnumType {
    const type = this.enums.get(stripTypeBrackets(String(argument)).toLowerCase());
    if (type === undefined) throw new PSRuntimeError(`Cannot find type [${stripTypeBrackets(String(argument))}]: verify that the assembly containing this type is loaded.`);
    return type;
  }

  private enumStatics(member: string): PSValue {
    switch (member) {
      case 'getnames': return ((type: PSValue) => this.enumTypeOf(type).names()) as unknown as PSValue;
      case 'getvalues': return ((type: PSValue) => [...this.enumTypeOf(type).members()]) as unknown as PSValue;
      case 'getname': return ((type: PSValue, value: PSValue) => this.enumTypeOf(type).fromNumber(Number(value)).memberName) as unknown as PSValue;
      case 'isdefined': return ((type: PSValue, value: PSValue) => {
        const definition = this.enumTypeOf(type);
        return typeof value === 'string' ? definition.member(value) !== undefined : definition.members().some(m => m.numeric === Number(value));
      }) as unknown as PSValue;
      case 'parse': return ((type: PSValue, text: PSValue) => this.guarded(() => this.enumTypeOf(type).parse(String(text)))) as unknown as PSValue;
      default: return null;
    }
  }

  private evalStaticMember(node: PSStaticMemberExpression, env: PSEnvironment): PSValue {
    const tname = node.typeName.toLowerCase();
    if (tname === 'environment' || tname === 'system.environment') {
      const dyn = this.buildEnvironmentType();
      return this.getMember(dyn as PSValue, node.member.toLowerCase());
    }
    if (tname === 'timezoneinfo' || tname === 'system.timezoneinfo') {
      return this.getMember(timeZoneInfoStatics(this.providers) as PSValue, node.member.toLowerCase());
    }
    if (tname === 'timespan' || tname === 'system.timespan') {
      return this.getMember(timeSpanStatics() as PSValue, node.member.toLowerCase());
    }
    if (tname === 'datetime' || tname === 'system.datetime') {
      return this.getMember(dateTimeStatics(this.providers) as PSValue, node.member.toLowerCase());
    }
    if (tname === 'security.principal.windowsidentity' || tname === 'system.security.principal.windowsidentity') {
      return this.getMember({ getcurrent: () => this.currentWindowsIdentity() } as unknown as PSValue, node.member.toLowerCase());
    }
    const enumType = this.enums.get(tname);
    if (enumType !== undefined) return enumType.member(node.member) ?? null;
    if (tname === 'enum' || tname === 'system.enum') return this.enumStatics(node.member.toLowerCase());
    const exceptionType = resolveExceptionType(node.typeName);
    if (exceptionType !== null && node.member.toLowerCase() === 'new') {
      return ((message?: PSValue) => makeExceptionObject(exceptionType, message === undefined || message === null ? defaultExceptionMessage(exceptionType) : String(message))) as unknown as PSValue;
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
    if (node.nullConditional === true && (obj === null || obj === undefined)) return null;
    const idx = this.evalExpr(node.index,  env);
    if (typeof obj === 'string') return this.indexSequence([...obj].map(ch => new PSChar(ch.charCodeAt(0)) as PSValue), idx);
    if (Array.isArray(obj)) return this.indexSequence(obj, idx);
    if (obj !== null && typeof obj === 'object') {
      const rec = obj as Record<string, PSValue>;
      if (Array.isArray(idx)) {
        return (idx as PSValue[]).map(k => rec[String(k)] ?? null);
      }
      return rec[String(idx)] ?? null;
    }
    return null;
  }

  private indexSequence(items: PSValue[], idx: PSValue): PSValue {
    const position = (key: PSValue): number => {
      const raw = typeof key === 'number' || key instanceof PSNumber ? key : this.guarded(() => castToNumeric('int32', key, this.conversion));
      const n = Math.trunc(Number(raw instanceof PSNumber ? raw.toNumber() : raw));
      return n < 0 ? items.length + n : n;
    };
    if (Array.isArray(idx)) {
      const out: PSValue[] = [];
      for (const key of idx) {
        const i = position(key);
        if (i >= 0 && i < items.length) out.push(items[i]);
        else out.push(null);
      }
      return out;
    }
    const i = position(idx);
    return i >= 0 && i < items.length ? items[i] : null;
  }

  private evalInvocation(node: PSInvocationExpression, env: PSEnvironment): PSValue {
    const calleeNode = node.callee as PSMemberExpression;
    if (calleeNode.type === 'MemberExpression' && calleeNode.nullConditional === true) {
      const target = this.evalExpr(calleeNode.object, env);
      if (target === null || target === undefined) return null;
    }
    const callee = this.evalExpr(node.callee, env);
    const args   = node.arguments.map(a => this.evalExpr(a, env));
    if (typeof callee === 'function')
      return (callee as (...a: PSValue[]) => PSValue)(...args);
    if (calleeNode.type === 'MemberExpression') this.rejectMissingMethod(calleeNode, env);
    return null;
  }

  private rejectMissingMethod(callee: PSMemberExpression, env: PSEnvironment): void {
    const target = this.evalExpr(callee.object, env);
    if (target === null || target === undefined) {
      throw new PSRuntimeError('You cannot call a method on a null-valued expression.', 'System.Management.Automation.RuntimeException');
    }
    const name = typeof callee.member === 'string' ? callee.member : psValueToString(this.evalExpr(callee.member, env));
    const typeName = this.describeType(target)?.fullName ?? 'System.Object';
    throw new PSRuntimeError(`Method invocation failed because [${typeName}] does not contain a method named '${name}'.`, 'System.Management.Automation.RuntimeException');
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
      return this.emittedBy(node.thenBody, env);
    for (const ei of node.elseifClauses) {
      if (this.isTruthy(this.evalExpr(ei.condition, env)))
        return this.emittedBy(ei.body, env);
    }
    if (node.elseBody) return this.emittedBy(node.elseBody, env);
    return null;
  }

  private emittedBy(block: PSScriptBlock, env: PSEnvironment): PSValue {
    if (block.beginBlock)   this.execStatementList(block.beginBlock,   env);
    if (block.processBlock) this.execStatementList(block.processBlock, env);
    if (block.endBlock)     this.execStatementList(block.endBlock,     env);
    if (!block.body) return null;
    return this.aggregateCaptured(this.runBlockCapture(block.body, env));
  }

  private emitLoop(run: (collected: PSValue[]) => void): PSValue {
    const collected: PSValue[] = [];
    try {
      run(collected);
    } catch (e) {
      for (const value of collected) this.outputLines.push(psValueToString(value));
      throw e;
    }
    return this.aggregateCaptured(collected);
  }

  private runLoopBody(block: PSScriptBlock, env: PSEnvironment, collected: PSValue[]): void {
    if (block.body) this.runBlockCapture(block.body, env, collected);
  }

  private execWhile(node: PSWhileStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    return this.emitLoop(collected => {
      while (this.isTruthy(this.evalExpr(node.condition, env))) {
        try { this.runLoopBody(node.body, env, collected); }
        catch (e) {
          if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break;
          if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) continue;
          throw e;
        }
      }
    });
  }

  private execDoWhile(node: PSDoWhileStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    return this.emitLoop(collected => {
      do {
        try { this.runLoopBody(node.body, env, collected); }
        catch (e) {
          if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break;
          if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) continue;
          throw e;
        }
      } while (this.isTruthy(this.evalExpr(node.condition, env)));
    });
  }

  private execDoUntil(node: PSDoUntilStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    return this.emitLoop(collected => {
      do {
        try { this.runLoopBody(node.body, env, collected); }
        catch (e) {
          if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break;
          if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) continue;
          throw e;
        }
      } while (!this.isTruthy(this.evalExpr(node.condition, env)));
    });
  }

  private execFor(node: PSForStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    if (node.init) this.execStatement(node.init, env);
    return this.emitLoop(collected => {
      outer: while (!node.condition || this.isTruthy(this.evalExpr(node.condition, env))) {
        try { this.runLoopBody(node.body, env, collected); }
        catch (e) {
          if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break outer;
          if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) { /* fall through */ }
          else throw e;
        }
        if (node.iterator) this.execStatement(node.iterator, env);
      }
    });
  }

  private execForeach(node: PSForeachStatement, env: PSEnvironment): PSValue {
    const myLabel = node.label;
    const varName    = node.variable.varName ?? node.variable.name;
    const collection = this.evalExpr(node.collection, env);
    const items: PSValue[] = Array.isArray(collection) ? collection
      : collection !== null && collection !== undefined ? [collection] : [];

    return this.emitLoop(collected => {
      for (const item of items) {
        env.set(varName, item);
        try { this.runLoopBody(node.body, env, collected); }
        catch (e) {
          if (e instanceof BreakSignal    && (!e.label || e.label === myLabel)) break;
          if (e instanceof ContinueSignal && (!e.label || e.label === myLabel)) continue;
          throw e;
        }
      }
    });
  }

  private execSwitch(node: PSSwitchStatement, env: PSEnvironment): PSValue {
    let subject = this.evalExpr(node.subject, env);
    const flags = (node.flags ?? []).map(f => f.toLowerCase());
    const useRegex = flags.includes('regex');
    const useWildcard = flags.includes('wildcard');
    const caseSensitive = flags.includes('casesensitive');
    const fromFile = flags.includes('file');

    if (fromFile) {
      const content = typeof subject === 'string' ? (this.providers.filesystem?.readFile(subject) ?? '') : '';
      subject = content.split(/\r?\n/).filter(Boolean);
    }
    const subjects: PSValue[] = Array.isArray(subject) ? subject : [subject];

    let matched = false;
    const values: PSValue[] = [];

    const runClause = (body: PSScriptBlock): boolean => {
      const stmtList = body.body ?? { statements: [] as PSStatement[] };
      const before = this.outputLines.length;
      for (const stmt of stmtList.statements) {
        const linesBefore = this.outputLines.length;
        const warningsBefore = this.warningLines;
        let result: PSValue = null;
        let broke = false;
        try {
          result = this.execStatement(stmt, env);
        } catch (e) {
          if (e instanceof BreakSignal) { broke = true; }
          else { this.outputLines.splice(before); throw e; }
        }
        const didEmit = this.emittedSince(linesBefore, warningsBefore);
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

    for (const subjVal of subjects) {
      let anyClauseMatched = false;
      env.set('_', subjVal);
      env.set('PSItem', subjVal);
      for (const clause of node.clauses) {
        const test = this.evalExpr(clause.pattern, env);
        if (this.switchMatch(subjVal, test, { useRegex, useWildcard, caseSensitive }, env)) {
          matched = true;
          anyClauseMatched = true;
          if (runClause(clause.body)) return values.length === 1 ? values[0] : values.length === 0 ? null : values;
        }
      }
      if (!anyClauseMatched && node.defaultBody) {
        runClause(node.defaultBody);
      }
    }
    if (values.length === 0) return null;
    return values.length === 1 ? values[0] : values;
  }

  private switchMatch(
    subject: PSValue,
    test: PSValue,
    opts: { useRegex: boolean; useWildcard: boolean; caseSensitive: boolean },
    env: PSEnvironment,
  ): boolean {
    if (typeof test === 'function') {
      try {
        const r = (test as (...a: PSValue[]) => PSValue)(subject);
        return this.isTruthy(r);
      } catch { return false; }
    }
    if (this.isScriptBlock(test)) {
      try {
        return this.isTruthy(this.invokeBlockInScope(test as unknown as PSScriptBlock, env, subject));
      } catch { return false; }
    }
    const s = String(subject);
    const t = String(test);
    if (opts.useRegex) {
      try {
        const re = new RegExp(t, opts.caseSensitive ? '' : 'i');
        const m = re.exec(s);
        if (!m) return false;
        const matches: Record<string, PSValue> = { 0: m[0] };
        for (let i = 1; i < m.length; i++) matches[i] = m[i];
        if (m.groups) for (const [k, v] of Object.entries(m.groups)) matches[k] = v ?? '';
        env.set('matches', matches);
        return true;
      } catch { return false; }
    }
    if (opts.useWildcard) {
      const re = new RegExp('^' + t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
        opts.caseSensitive ? '' : 'i');
      return re.test(s);
    }
    if (typeof subject === 'string' && typeof test === 'string') {
      return opts.caseSensitive ? subject === test : subject.toLowerCase() === test.toLowerCase();
    }
    return this.guarded(() => this.psEq(subject, test, opts.caseSensitive));
  }

  private execTry(node: PSTryStatement, env: PSEnvironment): PSValue {
    const renderBody = (body: PSScriptBlock): PSValue => {
      if (!body.body) return null;
      let last: PSValue = null;
      for (const s of body.body.statements) {
        const before = this.outputLines.length;
        const warningsBefore = this.warningLines;
        last = this.execStatement(s, env);
        const emitted = this.emittedSince(before, warningsBefore);
        if (!emitted && last !== null && last !== undefined
            && s.type !== 'AssignmentStatement'
            && s.type !== 'FunctionDefinition') {
          this.renderValue(last);
        }
      }
      return last;
    };
    let result: PSValue = null;
    try {
      result = renderBody(node.tryBody);
    } catch (e) {
      // Control-flow signals (return / break / continue / exit) are not
      // errors and must not be caught by `catch` — they propagate out of
      // the try, with `finally` still running on the way. Mirrors
      // PowerShell semantics.
      if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ExitSignal) {
        if (node.finallyBody) renderBody(node.finallyBody);
        throw e;
      }
      const errRecord = this.makeErrorRecord(e);
      const errList = (this.global.get('Error') as PSValue[]) ?? [];
      this.global.set('Error', [errRecord, ...errList]);

      if (node.catchClauses.length > 0) {
        env.set('_', errRecord);
        const actualType = e instanceof PSRuntimeError ? e.exceptionType : RUNTIME_EXCEPTION;
        const matchingClause = node.catchClauses.find(c => {
          if (c.types.length === 0) return false;
          return c.types.some(t => {
            const tn = (t as unknown as { typeName?: string; value?: string }).typeName
              ?? (t as unknown as { value?: string }).value ?? String(t);
            return exceptionMatches(actualType, tn);
          });
        }) ?? node.catchClauses.find(c => c.types.length === 0);
        if (matchingClause === undefined) {
          if (node.finallyBody) renderBody(node.finallyBody);
          throw e;
        }
        result = renderBody(matchingClause.body);
      } else {
        if (node.finallyBody) renderBody(node.finallyBody);
        throw e;
      }
    }
    if (node.finallyBody) renderBody(node.finallyBody);
    return null;
  }

  private makeErrorRecord(e: unknown): Record<string, PSValue> {
    const msg = e instanceof Error ? e.message : String(e);
    const typeName = e instanceof PSRuntimeError ? e.exceptionType : RUNTIME_EXCEPTION;
    const exception = makeExceptionObject(typeName, msg);
    return {
      Message: msg,
      Exception: exception,
      CategoryInfo: { Category: 'NotSpecified' } as Record<string, PSValue>,
      FullyQualifiedErrorId: exceptionShortName(typeName),
    } as Record<string, PSValue>;
  }

  private execFunctionDef(node: PSFunctionDefinition, env: PSEnvironment): PSValue {
    const isFilter = node.kind === 'filter';
    this.functions.set(node.name.toLowerCase(), { block: node.body, isFilter, declaredName: node.name });
    env.set(node.name, node.name as PSValue);
    return null;
  }

  private execPipelineChain(node: PSPipelineChainStatement, env: PSEnvironment): PSValue {
    const outputs: PSValue[] = [];
    const collect = (value: PSValue): void => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) outputs.push(...value);
      else outputs.push(value);
    };
    collect(this.execStatement(node.left, env));
    const succeeded = this.isTruthy(env.get('?') ?? true);
    if (node.operator === '&&' ? succeeded : !succeeded) collect(this.execStatement(node.right, env));
    if (outputs.length === 0) return null;
    return outputs.length === 1 ? outputs[0] : outputs;
  }

  private execEnumDef(node: PSEnumDefinition, env: PSEnvironment): PSValue {
    const flags = node.attributes?.some(a => a.name.toLowerCase() === 'flags') === true;
    const baseSpec = node.baseType === null ? null : parseTypeName(node.baseType);
    const underlying: NumericKind = baseSpec !== null && baseSpec.kind === 'numeric' ? baseSpec.numeric : 'int32';
    const type = new EnumType(node.name, underlying, flags);
    let next = 0;
    for (const member of node.members) {
      const declared = member.value === null ? null : this.evalExpr(member.value, env);
      const value = declared === null ? next : Number(declared);
      type.add(member.name, value);
      next = flags && declared === null && next === 0 ? 1 : (flags && declared === null ? next * 2 : value + 1);
    }
    this.enums.set(node.name.toLowerCase(), type);
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

  private execExit(node: PSExitStatement, env: PSEnvironment): PSValue {
    const raw = node.value ? this.evalExpr(node.value, env) : 0;
    const code = Number(psValueToString(raw));
    throw new ExitSignal(Number.isFinite(code) ? code : 0);
  }

  private execThrow(node: PSThrowStatement, env: PSEnvironment): PSValue {
    const val = node.value ? this.evalExpr(node.value, env) : new PSRuntimeError('ScriptHalted');
    if (val instanceof Error) throw val;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const rec = val as Record<string, PSValue>;
      const carrier = typeof rec['Exception'] === 'object' && rec['Exception'] !== null ? rec['Exception'] as Record<string, PSValue> : rec;
      if (typeof carrier['__type__'] === 'string') {
        const thrown = new PSRuntimeError(String(carrier['Message'] ?? ''), carrier['__type__'] as string);
        thrown.thrownFromThrowStatement = true;
        throw thrown;
      }
    }
    const thrown = new PSRuntimeError(String(val));
    thrown.thrownFromThrowStatement = true;
    throw thrown;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 4 — Pipeline engine + cmdlet dispatch
  // ═══════════════════════════════════════════════════════════════════════════

  execPipeline(node: PSPipeline, env: PSEnvironment): PSValue {
    if (node.commands.length === 0) return null;
    if (node.commands.length === 1) return this.execCommand(node.commands[0], env, undefined);

    let pipeInput: PSValue = undefined;
    let result:    PSValue = null;
    for (let i = 0; i < node.commands.length; i++) {
      const printedByThisStage = this.outputLines.length;
      result = this.execCommand(node.commands[i], env, pipeInput);
      const isLast = i === node.commands.length - 1;
      const valueIsConsumed = !isLast && result !== null && result !== undefined;
      if (valueIsConsumed) this.outputLines.splice(printedByThisStage);
      pipeInput = result;
    }
    return result;
  }

  private execCommand(node: PSCommand, env: PSEnvironment, pipeInput: PSValue): PSValue {
    const nameNode = node.name;

    // $x++ / $x-- encoded as AssignmentStatement in command-name position
    if ((nameNode.type as string) === 'AssignmentStatement') {
      this.execAssignment(nameNode as unknown as PSAssignmentStatement, env);
      return null;
    }

    // ++$x / --$x
    if (nameNode.type === 'CommandExpression') {
      const ce = nameNode as PSCommandExpression;
      if ((ce.name === '++' || ce.name === '--') && node.arguments.length > 0) {
        const varNode = node.arguments[0] as PSVariableExpression;
        const vname = varNode.varName ?? varNode.name;
        const cur = (env.get(vname) as PSValue) ?? 0;
        const newVal = this.arithmetic(ce.name === '++' ? '+' : '-', cur, 1);
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
        const called = (nameNode as unknown as Record<string, unknown>).__callop__ === true;
        if (!called && node.parameters.length === 0 && node.arguments.length === 0 && pipeInput === undefined) return varVal;
        const positional: PSValue[] = [];
        const named: Record<string, PSValue> = {};
        for (const p of node.parameters)
          { this.noteTypedParameter(p); named[p.name.toLowerCase()] = p.value ? this.evalExpr(p.value, env) : true; }
        for (const a of node.arguments)
          positional.push(this.evalExpr(a, env));
        return this.invokeScriptBlock(varVal as PSScriptBlock, named, positional, env, pipeInput);
      }
      // Variable holds a non-scriptblock (array pipeline source, etc.).
      // Under `&` it names what to run — `& $path` on a variable holding
      // a script path must run the script, not echo the path — so that
      // case carries on to command resolution below.
      if (!(nameNode as unknown as Record<string, unknown>).__callop__) return varVal;
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
        { this.noteTypedParameter(p); named[p.name.toLowerCase()] = p.value ? this.evalExpr(p.value, env) : true; }
      for (const a of node.arguments)
        positional.push(this.evalExpr(a, env));
      return this.invokeScriptBlock(nameNode as unknown as PSScriptBlock, named, positional, env, pipeInput);
    }

    // Pure-value expressions evaluate directly (not as cmdlet names).
    // If binary-operator parameters are present (e.g. `"hello" -match "..."` in pipeline
    // context where the parser couldn't parse it as a binary expression), apply them in order.
    // Note: operator params like -match have value=null; their right side is a positional arg.
    const calledWithOperator = (nameNode as unknown as Record<string, unknown>).__callop__ === true;
    if (!calledWithOperator && this.isPureValueNode(nameNode, env)) {
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
    this.typedCommandNames.set(lname, rawName);

    const positional: PSValue[] = [];
    const named: Record<string, PSValue> = {};

    for (const p of node.parameters)
      { this.noteTypedParameter(p); named[p.name.toLowerCase()] = p.value ? this.evalExpr(p.value, env) : true; }

    const argumentSpans: number[] = [];
    for (const a of node.arguments) {
      const before = positional.length;
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
      argumentSpans.push(positional.length - before);
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
          const refusal = this.scriptPolicyRefusal(rawName, scriptContent);
          if (refusal) throw new PSRuntimeError(refusal);
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
          {
            const captured: PSValue[] = [];
            try {
              this.runBlockCapture(ast.body, env, captured);
              this.global.set('LASTEXITCODE', 0);
            } catch (e) {
              if (!(e instanceof ExitSignal)) throw e;
              this.global.set('LASTEXITCODE', e.code);
            }
            return this.aggregateCaptured(captured);
          }
        }
        // No registered script — silently return null (file not found in simulator)
        return null;
      }
      const tfn = this.functions.get(tname);
      if (tfn) {
        return this.callUserFunction(tfn, this.applyDefaultParams(tname, named, env), positional, env, pipeInput);
      }
      // `& C:\path\to\script.ps1 args...` — invoke a script file as if it
      // were a function. Param block / pipeline behave like a normal call.
      if (/\.ps1$/i.test(tname) && this.providers.filesystem) {
        let scriptContent: string | undefined;
        try { scriptContent = this.providers.filesystem.readFile(psValueToString(target ?? '')); }
        catch { scriptContent = undefined; }
        if (scriptContent) {
          const refusal = this.scriptPolicyRefusal(rawName, scriptContent);
          if (refusal) throw new PSRuntimeError(refusal);
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
          return this.runScriptFile(block, named, positional, env, pipeInput);
        }
      }
      return this.dispatchCmdlet(tname, positional, named, pipeInput, env, this.rawArguments(node, named, positional, argumentSpans, true));
    }

    // User-defined function
    const fn = this.functions.get(lname);
    if (fn) return this.callUserFunction(fn, this.applyDefaultParams(lname, named, env), positional, env, pipeInput);

    // Script-file invocation: `C:\foo\bar.ps1 -X y` (with or without a leading
    // `&`, since parseCommandName silently consumes the ampersand). Loads the
    // file from the device filesystem and invokes it like a function.
    if (/\.ps1$/i.test(lname) && this.providers.filesystem) {
      let scriptContent: string | undefined;
      try { scriptContent = this.providers.filesystem.readFile(rawName); }
      catch { scriptContent = undefined; }
      if (scriptContent) {
        const refusal = this.scriptPolicyRefusal(rawName, scriptContent);
        if (refusal) throw new PSRuntimeError(refusal);
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
        return this.runScriptFile(block, named, positional, env, pipeInput);
      }
    }

    // Registry dispatch
    return this.dispatchCmdlet(lname, positional, named, pipeInput, env, this.rawArguments(node, named, positional, argumentSpans));
  }

  private pipelineText(pipeInput: PSValue): string | null {
    if (pipeInput === null || pipeInput === undefined) return null;
    return (Array.isArray(pipeInput) ? pipeInput : [pipeInput]).map(item => psValueToString(item)).join('\n');
  }

  takeNativeResult(): NativeResult | null {
    const replay = this.nativeReplay;
    if (replay === null || replay.cursor >= replay.results.length) return null;
    return replay.results[replay.cursor++];
  }

  acceptNativeResult(result: NativeResult): PSValue {
    if (result.notRecognized === true) {
      this.global.set('?', false);
      const missing = new PSRuntimeError(result.output);
      missing.commandName = /^The term '([^']*)'/.exec(result.output)?.[1];
      throw missing;
    }
    this.setLastExitCode(result.exitCode);
    return nativeOutputValue(result.output);
  }

  setLastExitCode(code: number): void {
    this.global.set('LASTEXITCODE', code);
    this.global.set('?', code === 0);
  }

  private rawArguments(
    node: PSCommand, named: Record<string, PSValue>, positional: readonly PSValue[], spans: readonly number[],
    skipTarget = false,
  ): string[] | undefined {
    if (node.sequence === undefined) return undefined;
    const argv: string[] = [];
    let argumentIndex = 0;
    let positionalIndex = 0;
    let skipping = skipTarget;
    for (const item of node.sequence) {
      if (item.type === 'CommandParameter') {
        const parameter = item as PSCommandParameter;
        argv.push(`-${parameter.text ?? parameter.name}`);
        if (parameter.value !== null) {
          const value = named[parameter.name.toLowerCase()];
          for (const element of Array.isArray(value) ? value : [value]) argv.push(psValueToString(element));
        }
        continue;
      }
      const span = spans[argumentIndex++] ?? 0;
      if (skipping) { skipping = false; continue; }
      for (let taken = 0; taken < span; taken++) {
        const value = positional[positionalIndex++];
        for (const element of Array.isArray(value) ? value : [value]) argv.push(psValueToString(element));
      }
    }
    return argv;
  }

  /**
   * Execute a statement list and return all pipeline-emitted values.
   * Unlike execStatementList (which returns last result), this collects output
   * from every non-assignment statement, mirroring what execute() does at top level.
   */
  private runBlockCapture(
    node: PSStatementList, env: PSEnvironment, captured: PSValue[] = [],
  ): PSValue[] {
    const before = this.outputLines.length;
    const printed: string[] = [];
    try {
      this.captureStatements(node, env, captured, printed);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        if (printed.length > 0) this.outputLines.splice(before, 0, ...printed);
        throw e;
      }
      this.promoteOutputLinesEvenWhenUnwinding(before, captured, printed);
      throw e;
    }
    this.promoteOutputLinesEvenWhenUnwinding(before, captured, printed);
    return captured;
  }

  private promoteOutputLinesEvenWhenUnwinding(
    from: number, captured: PSValue[], printed: string[],
  ): void {
    for (let i = from; i < this.outputLines.length; i++) {
      captured.push(this.outputLines[i]);
      printed.push(this.outputLines[i]);
    }
    this.outputLines.splice(from);
  }

  private captureStatements(
    node: PSStatementList, env: PSEnvironment, captured: PSValue[], printed: string[],
  ): void {
    for (const stmt of node.statements) {
      const linesBefore = this.outputLines.length;
      const result = this.execStatement(stmt, env);
      const didEmit = this.outputLines.length > linesBefore;
      // `$c++` / `$c += 1` (even nested in an if/loop whose taken branch
      // ends in one) are voidable in PowerShell — they must not feed the
      // pipeline. execStatement tracks this via lastStmtVoid.
      const isVoidAssign = this.lastStmtVoid;
      // Non-assignment, non-definition statements that didn't emit via cmdlet → collect value
      if (!didEmit && result !== null && result !== undefined
          && !isVoidAssign
          && stmt.type !== 'AssignmentStatement'
          && stmt.type !== 'FunctionDefinition') {
        if (Array.isArray(result)) captured.push(...result);
        else captured.push(result);
      }
      this.promoteOutputLinesEvenWhenUnwinding(linesBefore, captured, printed);
    }
  }

  private bindParametersInto(
    target: PSEnvironment,
    block: PSScriptBlock,
    named: Record<string, PSValue>,
    positional: readonly PSValue[],
    evaluationEnv: PSEnvironment,
    pipelineParameter: string | null,
  ): void {
    if (!block.paramBlock) {
      target.set('args', [...positional]);
      return;
    }
    const declarations = block.paramBlock.parameters;
    const host: BinderHost = {
      evaluate: expression => this.evalExpr(expression, evaluationEnv),
      cast: (value, typeName) => this.psCast(value, typeName),
      invokeScript: (script, argument) => this.invokeScriptBlock(script as PSScriptBlock, {}, [], evaluationEnv, argument),
      equal: (left, right, ignoreCase) => this.psEq(left, right, !ignoreCase),
      scriptText: script => (script as PSScriptBlock).sourceText ?? '',
      spell: key => this.typedParameterName(key),
    };
    const attributes = block.paramBlock.attributes;
    const outcome = bindParameters(declarations, attributes, named, positional, host, {
      pipelineParameter,
      supportsShouldProcess: false,
    });
    for (const declaration of declarations) {
      const name = declaration.name.varName ?? (declaration.name as { name?: string }).name ?? '';
      const key = name.toLowerCase();
      if (outcome.values.has(key)) {
        target.set(name, outcome.values.get(key) as PSValue);
        continue;
      }
      const typeName = declaration.paramType === null ? null : stripTypeBrackets(declaration.paramType).toLowerCase();
      if (declaration.defaultValue) {
        const initial = this.evalExpr(declaration.defaultValue, evaluationEnv);
        target.set(name, typeName === null || typeName === 'switch' ? initial : this.psCast(initial, typeName));
      } else {
        target.set(name, unboundParameterValue(typeName));
      }
    }
    target.set('args', outcome.extra);
    target.set('PSBoundParameters', outcome.bound as PSValue);
  }

  /**
   * Invoke a user-defined function, handling Begin/Process/End blocks,
   * filter semantics, $input, and ValueFromPipeline parameter binding.
   */
  private callUserFunction(
    fn: { block: PSScriptBlock; isFilter: boolean; declaredName?: string },
    named: Record<string, PSValue>,
    positional: PSValue[],
    env: PSEnvironment,
    pipeInput: PSValue,
  ): PSValue {
    try {
      return this.callUserFunctionBody(fn, named, positional, env, pipeInput);
    } catch (error) {
      if (error instanceof PSRuntimeError && error.commandName === undefined && !error.thrownFromThrowStatement) {
        error.commandName = fn.declaredName;
      }
      throw error;
    }
  }

  private callUserFunctionBody(
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

    let pipeParamName: string | null = null;
    const pipeByPropertyNames: string[] = [];
    if (block.paramBlock) {
      for (const p of block.paramBlock.parameters) {
        const pname = p.name.varName ?? (p.name as { name?: string }).name ?? '';
        for (const attr of p.attributes) {
          if (attr.name.toLowerCase() === 'parameter') {
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
            if (vfbpnNamed || vfbpnPositional) pipeByPropertyNames.push(pname);
          }
        }
      }
    }

    const resolvedNamed = { ...named };

    // For functions with named blocks (begin/process/end) or filter keyword
    if (hasNamedBlocks || isFilter) {
      const childEnv = env.createChild();
      this.bindParametersInto(childEnv, block, resolvedNamed, positional, env, pipeParamName);
      childEnv.set('input', this.asInputEnumerator(pipeItems));

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
              if (pipeByPropertyNames.length > 0 && item && typeof item === 'object' && !Array.isArray(item)) {
                const rec = item as Record<string, PSValue>;
                for (const pn of pipeByPropertyNames) {
                  const key = Object.keys(rec).find(k => k.toLowerCase() === pn.toLowerCase()) ?? pn;
                  childEnv.set(pn, rec[key] ?? null);
                }
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
          childEnv.set('input', this.asInputEnumerator(pipeItems));
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
      this.bindParametersInto(childEnv, block, namedForInvoke, positional, env, null);
      childEnv.set('input', this.asInputEnumerator(pipeItems));
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
  private pipelineItemsFor(
    cmdlet: { pipelineByPropertyName?: true; pipelineByValue?: string; parameters?: readonly string[] },
    named: Record<string, PSValue>,
    pipeInput: PSValue,
  ): Array<Record<string, PSValue>> | null {
    if (cmdlet.pipelineByPropertyName !== true && cmdlet.pipelineByValue === undefined) return null;
    if (pipeInput === undefined || pipeInput === null) return null;
    const items = (Array.isArray(pipeInput) ? pipeInput : [pipeInput])
      .filter((v): v is Record<string, PSValue> => v !== null && typeof v === 'object' && !Array.isArray(v));
    if (items.length === 0) return null;
    if (cmdlet.pipelineByValue !== undefined) {
      const key = cmdlet.pipelineByValue.toLowerCase();
      if (named[key] !== undefined) return null;
      return items.map(item => ({ ...named, [key]: item }));
    }
    const declared = new Map(((cmdlet.parameters ?? []) as readonly string[]).map(p => [p.toLowerCase(), p]));
    const bound = items.map(item => {
      const merged = { ...named };
      for (const [property, value] of Object.entries(item)) {
        const key = property.toLowerCase();
        if (declared.has(key) && merged[key] === undefined) merged[key] = value;
      }
      return merged;
    });
    const lie = bound.some(b => Object.keys(b).length > Object.keys(named).length);
    return lie ? bound : null;
  }

  private expandCommonParameterAliases(named: Record<string, PSValue>): Record<string, PSValue> {
    const aliases: Record<string, string> = {
      ea: 'erroraction', wa: 'warningaction', infa: 'informationaction', ev: 'errorvariable',
      wv: 'warningvariable', iv: 'informationvariable', ov: 'outvariable', ob: 'outbuffer',
      pv: 'pipelinevariable', vb: 'verbose', db: 'debug', wi: 'whatif', cf: 'confirm',
    };
    if (!Object.keys(named).some(key => aliases[key] !== undefined)) return named;
    const expanded: Record<string, PSValue> = {};
    for (const [key, value] of Object.entries(named)) expanded[aliases[key] ?? key] = value;
    return expanded;
  }

  private readonly typedCommandNames = new Map<string, string>();

  typedCommandName(lowerName: string): string {
    return this.typedCommandNames.get(lowerName) ?? lowerName;
  }

  private notFound(name: string): PSRuntimeError {
    const typed = this.typedCommandName(name);
    const error = new PSRuntimeError(commandNotFoundMessage(typed, this.edition === 'core'));
    error.commandName = typed;
    return error;
  }

  private readonly typedParameterNames = new Map<string, string>();

  private noteTypedParameter(parameter: { name: string; text?: string }): void {
    const typed = (parameter.text ?? parameter.name).replace(/^-/, '').replace(/:$/, '');
    this.typedParameterNames.set(parameter.name.toLowerCase(), typed);
  }

  private typedParameterName(key: string): string {
    return this.typedParameterNames.get(key) ?? key;
  }

  private rejectCoreOnlyParameters(cmdlet: ICmdlet, named: Record<string, PSValue>): void {
    if (this.edition === 'core' || cmdlet.coreOnlyParameters === undefined) return;
    for (const key of Object.keys(named)) {
      const hit = cmdlet.coreOnlyParameters.find(parameter => parameter.toLowerCase().startsWith(key));
      if (hit !== undefined && !(cmdlet.parameters ?? []).some(p => p.toLowerCase() === key && !cmdlet.coreOnlyParameters?.includes(p))) {
        throw new PSRuntimeError(
          `A parameter cannot be found that matches parameter name '${this.typedParameterName(key)}'.`,
          'System.Management.Automation.ParameterBindingException',
        );
      }
    }
  }

  private resolveParameterPrefixes(declaredNames: readonly string[] | undefined, named: Record<string, PSValue>): void {
    if (declaredNames === undefined) return;
    const declared = declaredNames.map(name => name.toLowerCase());
    for (const key of Object.keys(named)) {
      if (declared.includes(key)) continue;
      const candidates = declaredNames.filter(name => name.toLowerCase().startsWith(key));
      if (candidates.length === 1) {
        const target = candidates[0].toLowerCase();
        if (named[target] === undefined) {
          named[target] = named[key];
          delete named[key];
        }
      } else if (candidates.length > 1) {
        throw new PSRuntimeError(
          `Parameter cannot be processed because the parameter name '${this.typedParameterName(key)}' is ambiguous. Possible matches include:${candidates.map(c => ` -${c}`).join('')}.`,
          'System.Management.Automation.ParameterBindingException',
        );
      }
    }
  }

  private dispatchCmdlet(
    name: string,
    positional: PSValue[],
    named: Record<string, PSValue>,
    pipeInput: PSValue,
    env: PSEnvironment,
    nativeArguments?: string[],
  ): PSValue {
    named = this.expandCommonParameterAliases(named);
    // Extract common parameters before dispatch
    const errorVarName     = named['errorvariable']  ? psValueToString(named['errorvariable'])  : null;
    const explicitAction   = named['erroraction']    ? psValueToString(named['erroraction']).toLowerCase() : null;
    const prefAction       = psValueToString(env.get('ErrorActionPreference') ?? 'Continue').toLowerCase();
    const errorAction      = explicitAction ?? prefAction;
    const silentlyCont     = errorAction === 'silentlycontinue' || errorAction === 'ignore';
    const stopOnError      = errorAction === 'stop';

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

    const programStem = this.providers.network?.programStem(name) ?? null;
    const resolved = programStem === null ? this.registry.resolve(name) : this.registry.resolveProgram(programStem);
    const cmdlet = resolved && resolved.coreOnly === true && this.edition === 'desktop' ? undefined : resolved;
    if (cmdlet) {
      this.rejectCoreOnlyParameters(cmdlet, cmdletNamed);
      this.resolveParameterPrefixes(cmdlet.parameters as readonly string[] | undefined, cmdletNamed);
      const declared = new Set(
        ((cmdlet.parameters ?? []) as readonly string[]).map(p => p.toLowerCase()));
      for (const commun of ['whatif', 'confirm'] as const) {
        if (declared.has(commun) && named[commun] !== undefined) {
          cmdletNamed[commun] = named[commun];
        }
      }
    }
    if (!cmdlet) {
      const replayed = this.takeNativeResult();
      if (replayed !== null) return this.acceptNativeResult(replayed);
      this.global.set('?', false);
      if (errorVarName) {
        const errObj = { Exception: { Message: commandNotFoundMessage(this.typedCommandName(name), this.edition === 'core') }, CategoryInfo: {} } as Record<string, PSValue>;
        this.global.set(errorVarName, errObj);
      }
      if (silentlyCont) return null;
      if (programStem === null && !isNativeProgramName(name)) throw this.notFound(name);
      throw new NativeCommandNeedsAsync(
        programStem ?? name, nativeArguments ?? nativeArgv(positional, cmdletNamed), this.pipelineText(pipeInput));
    }

    if (named['whatif'] === true && cmdlet.supportsShouldProcess === true) {
      const label = cmdlet.displayName ?? this.titleCase(cmdlet.name);
      const target = cmdlet.whatIfTarget !== undefined
        ? cmdlet.whatIfTarget(this.buildCmdletContext(
            positional, cmdletNamed, pipeInput, env, [], silentlyCont, stopOnError, label))
        : psValueToString(cmdletNamed['name'] ?? positional[0] ?? pipelineTarget(pipeInput) ?? '');
      this.outputLines.push(`What if: Performing the operation "${label}" on target "${target}".`);
      return null;
    }

    if (cmdletNamed['?'] === true) {
      return this.dispatchCmdlet(
        'get-help', [cmdlet.displayName ?? this.titleCase(cmdlet.name)], {}, null, env);
    }

    const emittedValues: PSValue[] = [];
    const prevErrCount = this.errorObjects.length;
    const cmdletDisplayName = cmdlet.displayName ?? this.titleCase(cmdlet.name);
    const perItem = this.pipelineItemsFor(cmdlet, cmdletNamed, pipeInput);
    let result: PSValue;
    try {
      if (perItem) {
        const results: PSValue[] = [];
        for (const itemNamed of perItem) {
          const itemCtx = this.buildCmdletContext(
            positional, itemNamed, null, env, emittedValues, silentlyCont, stopOnError, cmdletDisplayName);
          const one = cmdlet.execute(itemCtx);
          if (one !== null && one !== undefined) results.push(one);
        }
        result = results.length === 0 ? null : (results.length === 1 ? results[0] : (results as PSValue));
      } else {
        const ctx = this.buildCmdletContext(
          positional, cmdletNamed, pipeInput, env, emittedValues, silentlyCont, stopOnError, cmdletDisplayName);
        result = cmdlet.execute(ctx);
      }
      this.global.set('?', true);
      result = adoptMachineDates(result, this.providers);
      for (let i = 0; i < emittedValues.length; i++) emittedValues[i] = adoptMachineDates(emittedValues[i], this.providers);
    } catch (err) {
      this.global.set('?', false);
      if (err instanceof PSRuntimeError && err.commandName === undefined && !err.thrownFromThrowStatement) err.commandName = cmdletDisplayName;
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
    stopOnError: boolean = false,
    cmdletDisplayName: string = 'Write-Error',
  ): CmdletContext {
    const self = this;
    positional = positional.map(unboxDeep);
    named = Object.fromEntries(Object.entries(named).map(([key, value]) => [key, unboxDeep(value)]));
    if (!PASS_THROUGH_CMDLETS.has(cmdletDisplayName.toLowerCase())) pipeInput = unboxDeep(pipeInput);

    const runtimeRef: IRuntimeRef = {
      execute:            (code) => self.execute(code),
      executeInteractive: (code) => self.executeInteractive(code),
      acceptNativeResult: (result) => self.acceptNativeResult(result),
      takeNativeResult: () => self.takeNativeResult(),
      executeForValue:    (code) => self.executeForValue(code),
      getVariable:        (name) => self.getVariable(name),
      setVariable:        (name, val) => self.global.set(name, val),
      invokeScriptBlock:  (block, namedV, posV, env2, $under) =>
        self.invokeScriptBlock(block, namedV, posV, env2, $under),
      invokeBlockInScope: (block, scopeEnv, $under) =>
        self.invokeBlockInScope(block, scopeEnv, $under),
      makeChildScope:     (env2) => env2.createChild(),
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
      getFunctionSource: (name) => self.functionSources.get(name.toLowerCase()) ?? null,
      listFunctions: () => [...self.functions.values()].map(f => f.declaredName),
      listHistory: () => self.listHistory(),
      getCommandParameters: (name) => self.getCommandParameters(name),
      psCast: (val, typeName) => self.psCast(val, typeName),
    };

    return {
      positional,
      named,
      pipeInput,
      env,
      runtime:   runtimeRef,
      providers: self.providers,

      emit: (val: PSValue) => emittedValues.push(val),

      emitWarning: (msg: string) => {
        self.outputLines.push(`WARNING: ${msg}`);
        self.warningLines++;
      },

      emitError: (rawMsg: string) => {
        // Many call sites already hand-embed "<Cmdlet> : " (mirroring the
        // legacy engine's hardcoded strings). Strip it so the canonical
        // prefix added below — derived once from the actually-dispatched
        // cmdlet — is never duplicated.
        let msg = rawMsg;
        for (;;) {
          const stripped = msg.replace(/^[A-Za-z][\w]*(?:-[A-Za-z][\w]*)+\s*:\s*/, '');
          if (stripped === msg) break;
          msg = stripped;
        }
        const category = 'NotSpecified';
        const exceptionType = 'WriteErrorException';
        const fullyQualifiedErrorId = 'Microsoft.PowerShell.Commands.WriteErrorException';
        const errObj = {
          Exception: { Message: msg },
          CategoryInfo: { Category: category },
          TargetObject: null,
          FullyQualifiedErrorId: fullyQualifiedErrorId,
        } as Record<string, PSValue>;
        self.errorObjects.push(errObj);
        const prevGlobalErrors = (env.get('Error') as PSValue[] | null) ?? [];
        env.set('Error', [errObj, ...prevGlobalErrors]);
        if (stopOnError) throw new PSRuntimeError(msg);
        if (!silentlyContinue) {
          if (self.edition === 'core') {
            self.outputLines.push(`${cmdletDisplayName}: ${msg}`);
          } else {
            self.outputLines.push(
              `${cmdletDisplayName} : ${msg}`,
              `    + CategoryInfo          : ${category}: (:) [${cmdletDisplayName}], ${exceptionType}`,
              `    + FullyQualifiedErrorId : ${fullyQualifiedErrorId}`,
            );
          }
        }
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
    const t = (typeName.startsWith('[') && typeName.endsWith(']') ? typeName.slice(1, -1) : typeName).toLowerCase();
    const enumType = this.enums.get(t);
    if (enumType !== undefined) return this.guarded(() => this.castEnum(enumType, val));
    const scalar = this.castScalar(val, parseTypeName(typeName));
    if (scalar !== undefined) return scalar;
    switch (t) {
      case 'xml': {
        const xmlStr = String(val ?? '');
        const parseAttrs = (attrsStr: string): Record<string, string> => {
          const attrs: Record<string, string> = {};
          const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
          let am: RegExpExecArray | null;
          while ((am = attrRe.exec(attrsStr)) !== null) attrs[am[1]] = am[2] ?? am[3];
          return attrs;
        };
        const parseXML = (s: string): Record<string, PSValue> => {
          const node: Record<string, PSValue> = {
            OuterXml: s,
            InnerText: s.replace(/<[^>]*>/g, '').trim(),
          };
          const childRe = /<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([^]*?)<\/\1>)/g;
          let m: RegExpExecArray | null;
          while ((m = childRe.exec(s)) !== null) {
            const [, tag, attrsStr, content] = m;
            const attrs = parseAttrs(attrsStr);
            const hasAttrs = Object.keys(attrs).length > 0;
            let childNode: PSValue;
            if (content === undefined) {
              childNode = hasAttrs ? (attrs as unknown as PSValue) : '';
            } else if (/<[\w:.-]/.test(content)) {
              childNode = parseXML(content) as unknown as PSValue;
            } else if (hasAttrs) {
              childNode = { ...attrs, '#text': content } as unknown as PSValue;
            } else {
              childNode = content;
            }
            if (node[tag] === undefined) node[tag] = childNode;
            else if (Array.isArray(node[tag])) (node[tag] as PSValue[]).push(childNode);
            else node[tag] = [node[tag], childNode];
          }
          return node;
        };
        return parseXML(xmlStr) as unknown as PSValue;
      }
      case 'regex': case 'system.text.regularexpressions.regex':
        // [regex]"pattern" — return a regex-like object
        return { __pattern__: String(val), IsMatch: (s: PSValue) => new RegExp(String(val)).test(String(s)) } as unknown as PSValue;
      case 'security.principal.windowsprincipal': case 'system.security.principal.windowsprincipal':
        return this.windowsPrincipalOf(val) as unknown as PSValue;
      case 'adsi': case 'system.directoryservices.directoryentry':
        return this.winNtEntry(psValueToString(val));
      case 'guid': case 'system.guid':
        return String(val) as PSValue;
      case 'datetime': case 'system.datetime':
        return (val instanceof Date ? val : parseDateTime(String(val), this.providers)) as unknown as PSValue;
      case 'timespan': case 'system.timespan': {
        if (isTimeSpan(val)) return val as PSValue;
        if (typeof val === 'string') return (timeSpanStatics().parse as (text: PSValue) => PSValue)(val);
        return makeTimeSpan(Number(val) / 10_000) as unknown as PSValue;
      }
      case 'version': case 'system.version': {
        const parts = String(val).split('.').map(Number);
        return { Major: parts[0]??0, Minor: parts[1]??0, Build: parts[2]??-1, Revision: parts[3]??-1, ToString: () => String(val) } as unknown as PSValue;
      }
      case 'ordered': {
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
          Object.defineProperty(val, '__ordered__', { value: true, enumerable: false, configurable: true });
        }
        return val;
      }
      case 'pscustomobject': case 'psobject':
      case 'system.management.automation.pscustomobject': {
        // Tag the object so Get-Member can report its members as
        // NoteProperty (a plain hashtable reports Property). Non-enumerable
        // so Object.keys / JSON.stringify / toEqual are unaffected.
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
          Object.defineProperty(val, '__pscustomobject__',
            { value: true, enumerable: false, configurable: true });
        }
        return val;
      }
      default:        return val;
    }
  }

  private castEnum(type: EnumType, val: PSValue): PSValue {
    if (val instanceof PSEnumValue && val.definition === type) return val;
    if (Array.isArray(val)) return val.map(item => this.castEnum(type, item));
    if (typeof val === 'string') return type.parse(val);
    return type.fromNumber(Number(val));
  }

  private castScalar(val: PSValue, spec: TypeSpec): PSValue | undefined {
    switch (spec.kind) {
      case 'numeric': return this.guarded(() => castToNumeric(spec.numeric, val, this.conversion));
      case 'char': return this.guarded(() => castToChar(val, this.conversion));
      case 'string': return psValueToString(val);
      case 'bool': return this.isTruthy(val);
      case 'object': return val;
      case 'array': return this.castArray(val, spec.element);
      default: return undefined;
    }
  }

  private castArray(val: PSValue, element: TypeSpec | null): PSValue {
    if (val === null || val === undefined) return val;
    let items: PSValue[];
    if (typeof val === 'string' && element !== null) items = [...val].map(ch => new PSChar(ch.charCodeAt(0)) as PSValue);
    else if (Array.isArray(val)) items = val;
    else items = [val];
    if (element === null) return Array.isArray(val) ? val : items;
    const converted = items.map(item => {
      const cast = this.castScalar(item, element);
      return cast === undefined ? item : cast;
    });
    return tagArray(converted, element);
  }

  private winNtEntry(path: string): PSValue {
    const match = /^WinNT:\/\/(?:[^/,]+\/)?([^/,]+)(?:,(\w+))?$/i.exec(path.trim());
    const users = this.providers.users;
    if (match === null || users === undefined || (match[2] !== undefined && match[2].toLowerCase() !== 'user')) {
      throw new PSRuntimeError('The WinNT path is not valid or does not name a user.');
    }
    const account = users.getUser(match[1]);
    if (account === null) throw new PSRuntimeError('The user name could not be found.');
    const failing = (method: string, argumentCount: number, message: string): never => {
      throw new PSRuntimeError(`Exception calling "${method}" with "${argumentCount}" argument(s): "${message}"`);
    };
    const changePassword = (oldPassword: PSValue, newPassword: PSValue): null => {
      const message = users.changePassword(account.name, psValueToString(oldPassword), psValueToString(newPassword));
      return message ? failing('ChangePassword', 2, message) : null;
    };
    const setPassword = (newPassword: PSValue): null => {
      const message = users.setUser(account.name, { password: psValueToString(newPassword) });
      return message ? failing('SetPassword', 1, message) : null;
    };
    return {
      Name: account.name,
      FullName: account.fullName,
      Description: account.description,
      ChangePassword: changePassword,
      SetPassword: setPassword,
      SetInfo: () => null,
      Invoke: (method: PSValue, ...args: PSValue[]) => {
        const name = psValueToString(method).toLowerCase();
        if (name === 'changepassword') return changePassword(args[0], args[1]);
        if (name === 'setpassword') return setPassword(args[0]);
        return failing('Invoke', args.length + 1, `The directory property cannot be found in the cache: ${psValueToString(method)}`);
      },
    } as unknown as PSValue;
  }

  isTruthy(val: PSValue): boolean {
    return truthiness(val);
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
      const result = likeDate(left, left.getTime() + ms);
      return Object.assign(result, {
        Year: result.getFullYear(), Month: result.getMonth() + 1, Day: result.getDate(),
        Hour: result.getHours(), Minute: result.getMinutes(), Second: result.getSeconds(),
        Millisecond: result.getMilliseconds(), DayOfWeek: result.getDay(), Ticks: result.getTime(),
      }) as unknown as PSValue;
    }
    if (typeof left === 'string')
      return left + psValueToString(right);
    if (left === null || left === undefined) return right ?? null;
    return this.arithmetic('+', left, right);
  }

  private applyMultiply(left: PSValue, right: PSValue): PSValue {
    return this.guarded(() => multiply(left, right));
  }

  private arithmetic(op: '+' | '-' | '*' | '/' | '%', left: PSValue, right: PSValue): PSValue {
    return this.guarded(() => numericArithmetic(op, left, right));
  }

  private guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof ArithmeticFault || error instanceof PSConversionError) {
        throw new PSRuntimeError(error.message, error.exceptionType);
      }
      throw error;
    }
  }

  private psEq(a: PSValue, b: PSValue, caseSensitive: boolean): boolean {
    return languageEquals(a, b, !caseSensitive, this.compareContext());
  }

  private psLike(str: string, pattern: string, caseSensitive: boolean): boolean {
    return wildcardMatches(pattern, str, caseSensitive);
  }

  private psMatch(str: string, pattern: string, caseSensitive: boolean, env: PSEnvironment, record = true): boolean {
    const match = compileRegex(pattern, { ignoreCase: !caseSensitive }).exec(str);
    if (match !== null && record) {
      const matches: Record<string, PSValue> = {};
      match.forEach((value, index) => { if (value !== undefined) matches[String(index)] = value; });
      if (match.groups) {
        for (const [key, value] of Object.entries(match.groups)) {
          if (value !== undefined) matches[key] = value;
        }
      }
      this.global.set('Matches', matches);
    } else if (record) {
      this.global.set('Matches', null);
    }
    return match !== null;
  }

  psIs(val: PSValue, right: PSValue): boolean {
    const enumType = this.enums.get(stripTypeBrackets(String(right)).toLowerCase());
    if (enumType !== undefined) return val instanceof PSEnumValue && val.definition === enumType;
    const spec = parseTypeName(String(right));
    const scalar = isScalarInstance(val, spec);
    if (scalar !== null) return scalar;
    const t = stripTypeBrackets(String(right)).toLowerCase();
    switch (t) {
      case 'null':                       return val === null;
      case 'datetime': case 'system.datetime': return val instanceof Date;
      case 'hashtable':                  return val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !(val instanceof PSNumber) && !(val instanceof PSChar);
      case 'pscustomobject': case 'psobject': case 'system.management.automation.pscustomobject': case 'system.management.automation.psobject':
        return val !== null && typeof val === 'object' && (val as unknown as Record<string, unknown>)['__pscustomobject__'] === true;
      case 'scriptblock': case 'system.management.automation.scriptblock': return this.isScriptBlock(val);
      case 'timespan': case 'system.timespan': return val !== null && typeof val === 'object' && isTimeSpan(val as Record<string, PSValue>);
      default:
        if (!this.isKnownTypeName(t)) throw new PSRuntimeError(`Unable to find type [${stripTypeBrackets(String(right))}].`);
        return false;
    }
  }

  private isKnownTypeName(lowerName: string): boolean {
    return lowerName.includes('.') || KNOWN_TYPE_NAMES.has(lowerName) || STATIC_TYPES[lowerName] !== undefined;
  }

  private describeType(obj: PSValue): { name: string; fullName: string } | null {
    const scalar = describeScalarType(obj);
    if (scalar !== null) return scalar;
    if (obj instanceof Date) return { name: 'DateTime', fullName: 'System.DateTime' };
    if (typeof obj === 'function') return { name: 'ScriptBlock', fullName: 'System.Management.Automation.ScriptBlock' };
    if (typeof obj !== 'object') return null;
    const rec = obj as Record<string, PSValue>;
    if (isTimeSpan(rec)) return { name: 'TimeSpan', fullName: 'System.TimeSpan' };
    if (this.isScriptBlock(obj)) return { name: 'ScriptBlock', fullName: 'System.Management.Automation.ScriptBlock' };
    const declared = rec['__type__'];
    if (typeof declared === 'string') return { name: declared.slice(declared.lastIndexOf('.') + 1), fullName: declared };
    if ((rec as unknown as Record<string, unknown>)['__pscustomobject__'] === true) {
      return { name: 'PSCustomObject', fullName: 'System.Management.Automation.PSCustomObject' };
    }
    if ((rec as unknown as Record<string, unknown>)['__ordered__'] === true) {
      return { name: 'OrderedDictionary', fullName: 'System.Collections.Specialized.OrderedDictionary' };
    }
    return { name: 'Hashtable', fullName: 'System.Collections.Hashtable' };
  }

  getMember(obj: PSValue, member: string): PSValue {
    if (obj === null || obj === undefined) return null;
    if (member === 'gettype' && !(typeof obj === 'object' && !Array.isArray(obj) && 'gettype' in (obj as object))) {
      const described = this.describeType(obj);
      if (described !== null) return () => makeTypeObject(described.name, described.fullName);
    }
    if (typeof obj === 'string')  return this.getStringMember(obj, member);
    if (typeof obj === 'number')  return numberMember(obj, member);
    if (obj instanceof PSEnumValue) {
      const own = enumMember(obj, member);
      if (own !== undefined) return own as PSValue;
    }
    if (obj instanceof PSNumber)  return boxedNumberMember(obj, member);
    if (obj instanceof PSChar)    return charMember(obj, member);
    if (typeof obj === 'boolean') return booleanMember(obj, member);

    // ArrayList IS an array with a __list__ sentinel — handle list-style methods first
    if (Array.isArray(obj) && (obj as unknown as Record<string, unknown>)['__list__'] !== undefined) {
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

      if (isTimeSpan(rec)) {
        const method = timeSpanMember(rec, member);
        if (method !== null) return method;
      }

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

      // System.DirectoryServices.ActiveDirectorySchedule — accepted for
      // `Set-ADReplicationSiteLink -ReplicationSchedule`, but no schedule-window
      // grid is stored (PRD-Repadmin.md §0.2 — no KCC-adjacent scheduling
      // modeled): SetSchedule/SetDailySchedule are real, callable no-ops rather
      // than an absent method that would misparse the call site.
      if (rec['__type__'] === 'ActiveDirectorySchedule') {
        switch (member) {
          case 'setschedule': case 'setdailyschedule': return () => null;
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

  private dateDifference(a: Date, b: Date): PSValue {
    return makeTimeSpan(a.getTime() - b.getTime()) as unknown as PSValue;
  }

  private getDateMember(d: Date, member: string): PSValue {
    return dateMember(d, member);
  }

  private getStringMember(s: string, member: string): PSValue {
    return stringMember(s, member) ?? null;
  }

  private asInputEnumerator(items: PSValue[]): PSValue[] {
    Object.defineProperty(items, INPUT_CURSOR, { value: -1, writable: true, enumerable: false, configurable: true });
    return items;
  }

  private inputEnumeratorMember(arr: PSValue[], member: string): PSValue | undefined {
    const cursor = arr as unknown as Record<string, number>;
    switch (member) {
      case 'movenext': return () => (cursor[INPUT_CURSOR] += 1) < arr.length;
      case 'reset': return () => { cursor[INPUT_CURSOR] = -1; return null; };
      case 'current': return arr[cursor[INPUT_CURSOR]] ?? null;
      default: return undefined;
    }
  }

  private getArrayMember(arr: PSValue[], member: string): PSValue {
    if ((arr as unknown as Record<string, unknown>)[INPUT_CURSOR] !== undefined) {
      const own = this.inputEnumeratorMember(arr, member);
      if (own !== undefined) return own;
    }
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
    if (op === '-not') return !this.isTruthy(right);
    return this.applyOperator(op, left, right, env);
  }

  /** Extracts the type name string from a [TypeName] node (TypeLiteral or CastExpression wrapping an empty operand). */
  private extractTypeName(node: PSExpression): string {
    if (node.type === 'TypeLiteral')
      return (node as unknown as { typeName: string }).typeName;
    if (node.type === 'CastExpression')
      return (node as PSCastExpression).targetType;
    return stripTypeBrackets(psValueToString(this.evalExpr(node, this.global)));
  }

  private isPureValueNode(node: PSExpression, _env?: PSEnvironment): boolean {
    switch (node.type) {
      case 'ArrayExpression': case 'HashtableExpression': case 'RangeExpression':
      case 'BinaryExpression': case 'UnaryExpression': case 'MemberExpression':
      case 'StaticMemberExpression': case 'IndexExpression': case 'InvocationExpression':
      case 'CastExpression': case 'SubExpression': case 'PipelineExpression':
      case 'ScriptBlock': case 'TernaryExpression':
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


