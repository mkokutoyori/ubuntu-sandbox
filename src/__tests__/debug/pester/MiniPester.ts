import type { ICmdlet } from '@/powershell/cmdlets/ICmdlet';
import type { CmdletContext } from '@/powershell/cmdlets/CmdletContext';
import type { PSValue, PSEnvironment } from '@/powershell/runtime/PSEnvironment';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { languageEquals } from '@/powershell/runtime/semantics/PSCompare';

export interface PesterResult {
  readonly suite: string;
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly message?: string;
}

const COMPARE = { toDate: () => null };

function isBlock(value: PSValue): value is PSScriptBlock {
  return value !== null && typeof value === 'object' && (value as { type?: string }).type === 'ScriptBlock';
}

function items(value: PSValue): PSValue[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

class AssertionFailure extends Error {}

export class PesterSession {
  readonly results: PesterResult[] = [];
  private readonly suiteNames: string[] = [];
  private readonly beforeEach: PSScriptBlock[][] = [];
  private readonly afterEach: PSScriptBlock[][] = [];

  suitePath(): string {
    return this.suiteNames.join(' > ');
  }

  record(result: Omit<PesterResult, 'suite'>): void {
    this.results.push({ suite: this.suitePath(), ...result });
  }

  enter(name: string): void {
    this.suiteNames.push(name);
    this.beforeEach.push([]);
    this.afterEach.push([]);
  }

  leave(): void {
    this.suiteNames.pop();
    this.beforeEach.pop();
    this.afterEach.pop();
  }

  addBeforeEach(block: PSScriptBlock): void { this.beforeEach[this.beforeEach.length - 1]?.push(block); }
  addAfterEach(block: PSScriptBlock): void { this.afterEach[this.afterEach.length - 1]?.push(block); }
  allBeforeEach(): PSScriptBlock[] { return this.beforeEach.flat(); }
  allAfterEach(): PSScriptBlock[] { return this.afterEach.flat().reverse(); }
}

function describeLike(name: string, session: PesterSession): ICmdlet {
  return {
    name,
    aliases: [],
    parameters: ['Name', 'Tag', 'Tags', 'Skip', 'Fixture'],
    execute(ctx: CmdletContext): PSValue {
      const title = psValueToString(ctx.positional[0] ?? ctx.named['name'] ?? name);
      const block = (ctx.positional.find(isBlock) ?? ctx.named['fixture']) as PSScriptBlock | undefined;
      if (block === undefined) return null;
      if (ctx.named['skip'] !== undefined && ctx.named['skip'] !== false) {
        session.enter(title);
        session.record({ name: '(suite skipped)', status: 'skip' });
        session.leave();
        return null;
      }
      session.enter(title);
      const scope = ctx.runtime.makeChildScope(ctx.env);
      const afterAll: PSScriptBlock[] = [];
      scope.set('__afterAll__', afterAll as unknown as PSValue);
      try {
        ctx.runtime.invokeBlockInScope(block, scope, null);
      } catch (error) {
        session.record({ name: '(suite body)', status: 'fail', message: error instanceof Error ? error.message : String(error) });
      }
      for (const cleanup of afterAll) {
        try { ctx.runtime.invokeBlockInScope(cleanup, scope, null); } catch { /* cleanup failures are not results */ }
      }
      session.leave();
      return null;
    },
  };
}

function hookLike(name: string, handler: (block: PSScriptBlock, ctx: CmdletContext) => void): ICmdlet {
  return {
    name,
    aliases: [],
    parameters: ['Scriptblock'],
    execute(ctx: CmdletContext): PSValue {
      const block = ctx.positional.find(isBlock) ?? (ctx.named['scriptblock'] as PSScriptBlock | undefined);
      if (block !== undefined) handler(block, ctx);
      return null;
    },
  };
}

function expandTitle(template: string, values: Record<string, PSValue>): string {
  return template.replace(/<([A-Za-z_][\w.]*)>/g, (whole, key: string) => {
    const found = Object.keys(values).find(k => k.toLowerCase() === key.toLowerCase());
    if (found === undefined) return whole;
    const value = values[found];
    if (isBlock(value)) return (value as { sourceText?: string }).sourceText ?? '{…}';
    return psValueToString(value);
  });
}

function itCmdlet(session: PesterSession): ICmdlet {
  return {
    name: 'it',
    aliases: [],
    parameters: ['Name', 'Test', 'TestCases', 'Skip', 'Pending', 'Tag', 'Tags', 'ForEach'],
    execute(ctx: CmdletContext): PSValue {
      const title = psValueToString(ctx.positional[0] ?? ctx.named['name'] ?? '');
      const block = (ctx.positional.find(isBlock) ?? ctx.named['test']) as PSScriptBlock | undefined;
      const skip = ctx.named['skip'];
      if (block === undefined || (skip !== undefined && skip !== false) || (ctx.named['pending'] !== undefined && ctx.named['pending'] !== false)) {
        session.record({ name: title, status: 'skip' });
        return null;
      }
      const cases = items(ctx.named['testcases'] ?? ctx.named['foreach']);
      const runs: Array<Record<string, PSValue> | null> = cases.length === 0
        ? [null]
        : cases.map(entry => (entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, PSValue> : { _: entry }));
      for (const values of runs) {
        const testName = values === null ? title : expandTitle(title, values);
        const scope = ctx.runtime.makeChildScope(ctx.env);
        const named: Record<string, PSValue> = {};
        const declared = new Set((block.paramBlock?.parameters ?? []).map(p => (p.name.varName ?? '').toLowerCase()));
        if (values !== null) {
          for (const [key, value] of Object.entries(values)) {
            scope.set(key, value);
            if (declared.has(key.toLowerCase())) named[key.toLowerCase()] = value;
          }
        }
        try {
          for (const hook of session.allBeforeEach()) ctx.runtime.invokeBlockInScope(hook, scope, null);
          ctx.runtime.invokeScriptBlock(block, named, [], scope, null);
          session.record({ name: testName, status: 'pass' });
        } catch (error) {
          session.record({ name: testName, status: 'fail', message: error instanceof Error ? error.message : String(error) });
        } finally {
          for (const hook of session.allAfterEach()) {
            try { ctx.runtime.invokeBlockInScope(hook, scope, null); } catch { /* ignored */ }
          }
        }
      }
      return null;
    },
  };
}

function typeMatches(ctx: CmdletContext, actual: PSValue, expected: PSValue): boolean {
  ctx.runtime.setVariable('__pester_actual__', actual);
  const expression = typeof expected === 'string' && expected.startsWith('[') ? expected : `[${psValueToString(expected)}]`;
  return ctx.runtime.executeForValue(`$__pester_actual__ -is ${expression}`) === true;
}

function equalValues(actual: PSValue, expected: PSValue, exact: boolean): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    const left = items(actual);
    const right = items(expected);
    return left.length === right.length && left.every((value, index) => equalValues(value, right[index], exact));
  }
  try { return languageEquals(expected, actual, !exact, COMPARE); } catch { return psValueToString(actual) === psValueToString(expected); }
}

function describeValue(value: PSValue): string {
  if (value === null || value === undefined) return '$null';
  if (typeof value === 'string') return `'${value}'`;
  if (Array.isArray(value)) return `@(${value.map(describeValue).join(', ')})`;
  return psValueToString(value);
}

function shouldCmdlet(): ICmdlet {
  const ASSERTIONS = ['be', 'beexactly', 'benullorempty', 'benull', 'betrue', 'befalse', 'beoftype', 'match', 'matchexactly', 'contain',
    'havecount', 'belike', 'belikeexactly', 'begreaterthan', 'belessthan', 'begreaterorequal', 'belessorequal', 'throw', 'exist', 'haveparameter', 'bein', 'invoke'];
  return {
    name: 'should',
    aliases: [],
    parameters: ['Not', 'Be', 'BeExactly', 'BeNullOrEmpty', 'BeNull', 'BeTrue', 'BeFalse', 'BeOfType', 'Match', 'MatchExactly', 'Contain', 'HaveCount',
      'BeLike', 'BeLikeExactly', 'BeGreaterThan', 'BeLessThan', 'BeGreaterOrEqual', 'BeLessOrEqual', 'Throw', 'ExpectedMessage', 'ErrorId', 'ExceptionType',
      'Exist', 'BeIn', 'Because', 'ActualValue', 'PassThru'],
    execute(ctx: CmdletContext): PSValue {
      const negate = ctx.named['not'] === true;
      const assertion = ASSERTIONS.find(key => ctx.named[key] !== undefined);
      const raw = ctx.pipeInput;
      const actual: PSValue = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
      const named = ctx.named[assertion ?? ''];
      const expected = named === true && ctx.positional.length > 0 ? ctx.positional[0] : named;
      const fail = (message: string): never => { throw new AssertionFailure(message); };
      const verdict = (passed: boolean, positive: string, negative: string): null => {
        if (negate ? passed : !passed) fail(negate ? negative : positive);
        return null;
      };
      switch (assertion) {
        case 'be': return verdict(equalValues(actual, expected, false), `Expected ${describeValue(expected)}, but got ${describeValue(actual)}.`, `Expected anything except ${describeValue(expected)}.`);
        case 'beexactly': return verdict(equalValues(actual, expected, true), `Expected exactly ${describeValue(expected)}, but got ${describeValue(actual)}.`, `Expected anything except exactly ${describeValue(expected)}.`);
        case 'benullorempty': return verdict(items(actual).length === 0 || actual === '' || (Array.isArray(actual) && actual.length === 0), `Expected $null or empty, but got ${describeValue(actual)}.`, 'Expected a value, but got $null or empty.');
        case 'benull': return verdict(actual === null || actual === undefined, `Expected $null, but got ${describeValue(actual)}.`, 'Expected not $null.');
        case 'betrue': return verdict(actual === true || (actual !== null && actual !== false && actual !== 0 && actual !== ''), `Expected $true, but got ${describeValue(actual)}.`, 'Expected falsy value.');
        case 'befalse': return verdict(actual === false || actual === null || actual === 0 || actual === '', `Expected $false, but got ${describeValue(actual)}.`, 'Expected truthy value.');
        case 'beoftype': return verdict(typeMatches(ctx, actual, expected), `Expected the value to have type ${psValueToString(expected)}, but got ${describeValue(actual)}.`, `Expected the value to not have type ${psValueToString(expected)}.`);
        case 'match': return verdict(new RegExp(psValueToString(expected), 'i').test(psValueToString(actual)), `Expected regular expression '${psValueToString(expected)}' to match ${describeValue(actual)}.`, `Expected regular expression '${psValueToString(expected)}' to not match ${describeValue(actual)}.`);
        case 'matchexactly': return verdict(new RegExp(psValueToString(expected)).test(psValueToString(actual)), `Expected regular expression '${psValueToString(expected)}' to match ${describeValue(actual)}.`, 'Expected no match.');
        case 'contain': return verdict(items(actual).some(value => equalValues(value, expected, false)), `Expected ${describeValue(expected)} to be found in collection ${describeValue(actual)}.`, `Expected ${describeValue(expected)} to not be found.`);
        case 'havecount': return verdict(items(actual).length === Number(expected), `Expected a collection with size ${String(expected)}, but got ${items(actual).length}.`, `Expected a collection with a size different from ${String(expected)}.`);
        case 'belike': return verdict(new RegExp(`^${psValueToString(expected).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(psValueToString(actual)), `Expected like ${describeValue(expected)}, got ${describeValue(actual)}.`, 'Expected not like.');
        case 'belikeexactly': return verdict(new RegExp(`^${psValueToString(expected).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(psValueToString(actual)), `Expected like ${describeValue(expected)}, got ${describeValue(actual)}.`, 'Expected not like.');
        case 'begreaterthan': return verdict(Number(actual) > Number(expected), `Expected ${describeValue(actual)} to be greater than ${describeValue(expected)}.`, 'Expected not greater.');
        case 'belessthan': return verdict(Number(actual) < Number(expected), `Expected ${describeValue(actual)} to be less than ${describeValue(expected)}.`, 'Expected not less.');
        case 'begreaterorequal': return verdict(Number(actual) >= Number(expected), `Expected ${describeValue(actual)} >= ${describeValue(expected)}.`, 'Expected lower.');
        case 'belessorequal': return verdict(Number(actual) <= Number(expected), `Expected ${describeValue(actual)} <= ${describeValue(expected)}.`, 'Expected greater.');
        case 'bein': return verdict(items(expected).some(value => equalValues(actual, value, false)), `Expected ${describeValue(actual)} to be in ${describeValue(expected)}.`, 'Expected not in.');
        case 'throw': {
          ctx.runtime.setVariable('__pester_block__', actual);
          const outcome = isBlock(actual)
            ? ctx.runtime.executeForValue("try { $null = & $__pester_block__; '__pester_nothrow__' } catch { $_ }")
            : '__pester_nothrow__';
          const thrown = outcome === '__pester_nothrow__' ? null : outcome as Record<string, PSValue>;
          const exceptionMessage = thrown === null ? '' : psValueToString((thrown.Exception as Record<string, PSValue> | undefined)?.Message ?? thrown.Message);
          const wanted = ctx.named['expectedmessage'] ?? (typeof expected === 'string' ? expected : undefined);
          const wantedId = ctx.named['errorid'];
          const thrownId = thrown === null ? '' : psValueToString(thrown.FullyQualifiedErrorId);
          const matches = thrown !== null && (wanted === undefined || exceptionMessage.toLowerCase().includes(psValueToString(wanted).toLowerCase()))
            && (wantedId === undefined || thrownId === psValueToString(wantedId));
          verdict(matches,
            thrown === null ? 'Expected an exception, but no exception was thrown.'
              : wantedId !== undefined && thrownId !== psValueToString(wantedId) ? `Expected ErrorId '${psValueToString(wantedId)}', but got '${thrownId}'.`
              : `Expected message '${psValueToString(wanted)}', but got '${exceptionMessage}'.`,
            'Expected no exception, but one was thrown.');
          return ctx.named['passthru'] === true ? thrown : null;
        }
        default: return fail(`Unsupported Should assertion (${Object.keys(ctx.named).join(', ')}).`);
      }
    },
  };
}

export function createPesterCmdlets(session: PesterSession): ICmdlet[] {
  return [
    describeLike('describe', session),
    describeLike('context', session),
    itCmdlet(session),
    shouldCmdlet(),
    hookLike('beforeall', (block, ctx) => { ctx.runtime.invokeBlockInScope(block, ctx.env, null); }),
    hookLike('beforeeach', block => session.addBeforeEach(block)),
    hookLike('aftereach', block => session.addAfterEach(block)),
    hookLike('afterall', (block, ctx) => {
      const pending = ctx.env.get('__afterAll__');
      if (Array.isArray(pending)) (pending as unknown as PSScriptBlock[]).push(block);
    }),
  ];
}

export type { PSEnvironment };
