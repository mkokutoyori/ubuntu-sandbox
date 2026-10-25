/**
 * CmdletContext — Everything a cmdlet needs to execute.
 *
 * Passed by PSRuntime to ICmdlet.execute(). Provides:
 *   - Parsed arguments (positional + named)
 *   - Piped input from the previous stage
 *   - The current variable scope (PSEnvironment)
 *   - A back-reference to PSRuntime (to invoke other cmdlets or eval code)
 *   - Injectable providers for system resources (filesystem, registry, …)
 *   - Output helpers (emit, emitError) so cmdlets can stream multiple values
 *   - invokeBlock to evaluate a PSScriptBlock with a given $_ and named vars
 */

import type { FunctionSignature } from '@/powershell/help/FunctionHelp';
import type { PSValue, PSEnvironment } from '@/powershell/runtime/PSEnvironment';
import type { PSProviders } from '@/powershell/providers/PSProviders';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';
import type { NativeResult } from '@/powershell/nativeAsync';
import type { PSLocationState } from '@/powershell/runtime/PSLocationState';

// PSRuntime is referenced here via a forward-declaration interface to avoid
// circular imports (PSRuntime imports CmdletContext, CmdletContext imports PSRuntime).
export interface IRuntimeRef {
  readonly edition: 'desktop' | 'core';
  readonly locations: PSLocationState;
  execute(code: string): string;
  executeInteractive(code: string): string;
  acceptNativeResult(result: NativeResult): PSValue;
  takeNativeResult(): NativeResult | null;
  /** Execute code and return the last PSValue (no stringification). Used by IEX. */
  executeForValue(code: string): PSValue;
  invokeScriptText(code: string, env?: PSEnvironment): PSValue[];
  getVariable(name: string): PSValue;
  setVariable(name: string, value: PSValue): void;
  /** Evaluate a script block in a child scope of env. */
  invokeScriptBlock(
    block: PSScriptBlock,
    namedVars: Record<string, PSValue>,
    args: PSValue[],
    env: PSEnvironment,
    dollarUnderscore: PSValue,
  ): PSValue;
  /**
   * Run a script block's body directly in `scopeEnv` (no fresh child) with
   * `$_` bound. Used by ForEach-Object so -Begin/-Process/-End share state.
   */
  invokeBlockInScope(
    block: PSScriptBlock,
    scopeEnv: PSEnvironment,
    dollarUnderscore: PSValue,
  ): PSValue;
  /** Make a child scope of the given env (shared across multi-block cmdlets). */
  makeChildScope(env: PSEnvironment): PSEnvironment;
  /** Dispatch a cmdlet call directly (for cmdlets that call other cmdlets). */
  callCmdlet(
    name: string,
    positional: PSValue[],
    named: Record<string, PSValue>,
    pipeInput: PSValue,
    env: PSEnvironment,
  ): PSValue;
  /**
   * List every (canonical) registered cmdlet — used by Get-Command and
   * Get-Alias to enumerate the registry without leaking the implementation.
   * Each cmdlet supplies its own displayName/module/description via the
   * ICmdlet interface (open/closed: new cmdlets just declare these
   * properties, no central dictionary to maintain).
   */
  listCmdlets(): readonly {
    name: string;
    aliases: readonly string[];
    displayName?: string;
    module?: string;
    description?: string;
  }[];
  /** Enumerate the host's environment variables (for `Get-ChildItem Env:`). */
  listEnvVars(): Array<{ Name: string; Value: string }>;
  getFunctionSource(name: string): string | null;
  getFunctionBlock(name: string): PSValue;
  getFunctionLeadingComment(name: string): string | null;
  getFunctionSignature(name: string): FunctionSignature | null;
  defineFunction(name: string, block: PSValue): boolean;
  removeFunction(name: string): boolean;
  /** Names of the functions this session has defined, for Get-Command. */
  listFunctions(): readonly string[];
  /** The session's command history, newest last, for Get-History. */
  listHistory(): readonly string[];
  listUserAliases(): ReadonlyArray<{ name: string; definition: string; description: string }>;
  hasAlias(name: string): boolean;
  defineAlias(name: string, definition: string, description: string): void;
  removeAlias(name: string): boolean;
  /** A cmdlet's declared parameter names — the same list `-<Tab>` offers. */
  getCommandParameters(name: string): string[];
  psCast(val: PSValue, typeName: string): PSValue;
  scriptBlockFromText(code: string): PSValue;
}

export interface CmdletContext {
  /** Positional arguments (already evaluated). */
  readonly positional: PSValue[];

  /** Named parameters (keys are lowercase, already evaluated). */
  readonly named: Record<string, PSValue>;

  /** Value piped from the previous stage. null if this is the first command. */
  readonly pipeInput: PSValue;

  /** Current variable scope. */
  readonly env: PSEnvironment;

  /** Back-reference to the runtime for invoking other cmdlets or eval. */
  readonly runtime: IRuntimeRef;

  /** Injected system providers (null fields = provider not available). */
  readonly providers: PSProviders;

  /**
   * Write a value to the output stream.
   * Cmdlets that produce multiple items should call emit() for each
   * rather than returning an array, enabling proper pipeline streaming.
   */
  emit(val: PSValue): void;

  /** Write to the warning stream; `$WarningPreference` / `-WarningAction` decide what happens. */
  emitWarning(msg: string): void;

  /** Write to the verbose stream; shown only when `$VerbosePreference` / `-Verbose` allow it. */
  emitVerbose(msg: string): void;

  /** Write to the debug stream; shown only when `$DebugPreference` / `-Debug` allow it. */
  emitDebug(msg: string): void;

  /** Write to the information stream (`Write-Information`). */
  emitInformation(data: PSValue, tags: readonly string[]): void;

  /** Write an error message (non-terminating). */
  emitError(msg: string): void;

  /** Write a ready-made ErrorRecord to the error stream (non-terminating). */
  emitErrorRecord(record: PSValue): void;

  /**
   * Evaluate a script block with a given $_ binding and optional named vars.
   * Creates a child scope so local variables don't leak.
   */
  invokeBlock(
    block: PSScriptBlock,
    dollarUnderscore?: PSValue,
    namedVars?: Record<string, PSValue>,
    args?: PSValue[],
  ): PSValue;
}
