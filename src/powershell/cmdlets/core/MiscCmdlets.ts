/**
 * MiscCmdlets — Miscellaneous core cmdlets.
 *
 * New-Object, Get-Random, Invoke-Expression, Get-Command, Get-Help.
 * No system providers required (except Get-Command which reads the registry).
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { VolumeInfo } from '@/powershell/providers/PSProviders';
import { isRegistryPath } from '@/network/devices/windows/PSRegistryProvider';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import {
  type ProcessPolicyPort, EXECUTION_POLICIES, EXECUTION_POLICY_SCOPES,
  PROCESS_POLICY_VARIABLE, effectiveExecutionPolicy, matchExecutionPolicy,
  matchExecutionPolicyScope, storedPolicy, writeExecutionPolicy,
} from '@/powershell/executionPolicy';
import { namedCredential } from './RemotingCmdlets';
import { makePSCredential } from '@/powershell/credential/PSCredential';
import { wildcardMatches, wildcardToRegex, hasWildcard } from '@/powershell/runtime/PSWildcard';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { renderCmdletHelp, helpTopicNotFound, HELP_SYSTEM_TOPIC } from '@/powershell/help/renderHelp';
import { parseCommentHelp, scriptHeadHelp } from '@/powershell/help/CommentHelp';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';
import { helpObject, matchesFilter, resolveHelp } from '@/powershell/help/FunctionHelp';
import { newErrorRecord } from '@/powershell/runtime/semantics/PSStreams';

// ─── New-Object ───────────────────────────────────────────────────────────

function newObjectCtorArgs(ctx: CmdletContext): PSValue[] {
  const named = ctx.named['argumentlist'];
  if (named !== undefined) return Array.isArray(named) ? named : [named];
  const positional = ctx.positional.slice(1);
  if (positional.length === 1 && Array.isArray(positional[0])) return positional[0];
  return positional;
}

export class NewObjectCmdlet implements ICmdlet {
  readonly name = 'new-object';
  readonly parameters = ['TypeName', 'ArgumentList', 'Property', 'ComObject', 'Strict'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const tname = psValueToString(ctx.named['typename'] ?? ctx.positional[0] ?? '').toLowerCase();
    if (/(^|[.])(list|collection)\[.+\]$/.test(tname)) {
      const initial = ctx.named['argumentlist'] ?? ctx.positional[1];
      return ctx.runtime.executeForValue(`[${tname}]::new(${Array.isArray(initial) ? '@(' + initial.map(psValueToString).join(',') + ')' : ''})`);
    }
    if (tname.includes('hashtable') || tname.includes('dictionary'))
      return {} as Record<string, PSValue>;
    if (tname.includes('arraylist') || tname.includes('list`1') || tname.includes('list<')) {
      // Real JS array with __list__ sentinel for getMember dispatch + Count getter for direct JS access
      const arr: PSValue[] = [];
      (arr as unknown as Record<string, PSValue>)['__list__'] = arr as unknown as PSValue;
      Object.defineProperty(arr, 'Count', { get: () => arr.length, enumerable: false, configurable: true });
      return arr as unknown as PSValue;
    }
    if (tname.includes('queue')) {
      const items: PSValue[] = [];
      const q: Record<string, PSValue> = { __type__: 'Queue', __items__: items as PSValue[] };
      Object.defineProperty(q, 'Count', { get: () => items.length, enumerable: false, configurable: true });
      return q as unknown as PSValue;
    }
    if (tname.includes('stack')) {
      const items: PSValue[] = [];
      const s: Record<string, PSValue> = { __type__: 'Stack', __items__: items as PSValue[] };
      Object.defineProperty(s, 'Count', { get: () => items.length, enumerable: false, configurable: true });
      return s as unknown as PSValue;
    }
    if (tname.includes('windowsprincipal')) {
      return ctx.runtime.psCast(newObjectCtorArgs(ctx)[0] ?? null, 'security.principal.windowsprincipal');
    }
    if (tname.includes('pscredential')) {
      const args = newObjectCtorArgs(ctx);
      const secret = args[1] as { SecureString?: unknown } | undefined;
      const password = secret && typeof secret === 'object' && 'SecureString' in secret
        ? psValueToString(secret.SecureString as PSValue)
        : psValueToString(args[1] ?? '');
      return makePSCredential(psValueToString(args[0] ?? ''), password) as unknown as PSValue;
    }
    if (tname.includes('activedirectoryschedule')) {
      // `Set-ADReplicationSiteLink -ReplicationSchedule` accepts one of these — no
      // schedule-window enforcement is modeled (PRD-Repadmin.md §0.2, same "no
      // KCC" boundary as `/kcc`), so `SetSchedule(...)` (dispatched in PSRuntime's
      // getMember for `__type__ === 'ActiveDirectorySchedule'`) is a real callable
      // no-op rather than a silently-absent method that would misparse the call.
      return { __type__: 'ActiveDirectorySchedule' } as unknown as PSValue;
    }
    if (tname.includes('activedirectoryaccessrule')) {
      const args = newObjectCtorArgs(ctx);
      return {
        IdentityReference: psValueToString(args[0] ?? ''),
        ActiveDirectoryRights: psValueToString(args[1] ?? ''),
        AccessControlType: psValueToString(args[2] ?? 'Allow'),
        ObjectType: psValueToString(args[3] ?? '00000000-0000-0000-0000-000000000000'),
        InheritanceType: psValueToString(args[4] ?? 'None'),
        InheritedObjectType: psValueToString(args[5] ?? '00000000-0000-0000-0000-000000000000'),
      } as Record<string, PSValue>;
    }
    // `FileSystemAuditRule` — la règle de SACL. Même forme que la règle
    // d'accès, mais le dernier argument est un `AuditFlags`
    // (`Success`/`Failure`/les deux) et non un `AccessControlType` : la
    // SACL dit ce qu'on journalise, pas qui a le droit. Le test doit
    // précéder celui de `filesystemaccessrule`, qui autrement le
    // capturerait par sous-chaîne.
    if (tname.includes('filesystemauditrule')) {
      const args = newObjectCtorArgs(ctx);
      const flags = args.length <= 3 ? args[2] : args[4];
      return {
        IdentityReference: psValueToString(args[0] ?? ''),
        FileSystemRights: psValueToString(args[1] ?? ''),
        InheritanceFlags: args.length <= 3 ? 'None' : psValueToString(args[2] ?? 'None'),
        PropagationFlags: args.length <= 3 ? 'None' : psValueToString(args[3] ?? 'None'),
        AuditFlags: psValueToString(flags ?? 'Success'),
      } as Record<string, PSValue>;
    }
    // Real .NET FileSystemAccessRule has two commonly-used overloads: the
    // short (identity, fileSystemRights, accessControlType) and the long
    // (identity, fileSystemRights, inheritanceFlags, propagationFlags,
    // accessControlType) — disambiguate on arg count like the real ctor
    // overload resolution would.
    if (tname.includes('filesystemaccessrule')) {
      const args = newObjectCtorArgs(ctx);
      if (args.length <= 3) {
        return {
          IdentityReference: psValueToString(args[0] ?? ''),
          FileSystemRights: psValueToString(args[1] ?? ''),
          InheritanceFlags: 'None',
          PropagationFlags: 'None',
          AccessControlType: psValueToString(args[2] ?? 'Allow'),
        } as Record<string, PSValue>;
      }
      return {
        IdentityReference: psValueToString(args[0] ?? ''),
        FileSystemRights: psValueToString(args[1] ?? ''),
        InheritanceFlags: psValueToString(args[2] ?? 'None'),
        PropagationFlags: psValueToString(args[3] ?? 'None'),
        AccessControlType: psValueToString(args[4] ?? 'Allow'),
      } as Record<string, PSValue>;
    }
    // psobject / pscustomobject (and the generic fallback) honour -Property,
    // which seeds the new object's NoteProperties from a hashtable.
    const prop = ctx.named['property'];
    if (prop !== null && typeof prop === 'object' && !Array.isArray(prop)) {
      return { ...(prop as Record<string, PSValue>) };
    }
    return {} as Record<string, PSValue>;
  }
}

// ─── Get-Random ───────────────────────────────────────────────────────────

export class GetRandomCmdlet implements ICmdlet {
  readonly name = 'get-random';
  readonly parameters = ['Maximum', 'Minimum', 'SetSeed', 'InputObject', 'Count'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    // -SetSeed → deterministic mulberry32 sequence (same seed ⇒ same
    // value), matching PowerShell's reseed semantics and keeping
    // seeded debug transcripts reproducible. No seed ⇒ Math.random.
    let rng: () => number;
    if (ctx.named['setseed'] !== undefined) {
      let a = (Number(ctx.named['setseed']) >>> 0) || 1;
      rng = () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    } else {
      rng = Math.random;
    }
    const count = ctx.named['count'] !== undefined ? Number(ctx.named['count']) : undefined;

    // Selection mode: -InputObject or pipeline input → pick element(s).
    const inputObj = ctx.named['inputobject'];
    const pool: PSValue[] | null =
      inputObj !== undefined && inputObj !== null
        ? (Array.isArray(inputObj) ? inputObj : [inputObj])
        : (ctx.pipeInput !== undefined && ctx.pipeInput !== null
            ? (Array.isArray(ctx.pipeInput) ? ctx.pipeInput : [ctx.pipeInput])
            : null);

    if (pool && pool.length > 0) {
      if (count === undefined) return pool[Math.floor(rng() * pool.length)];
      // Sample `count` WITHOUT replacement (shuffle, take N).
      const arr = [...pool];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr.slice(0, Math.min(count, arr.length));
    }

    // Numeric mode.
    const max = ctx.named['maximum'] ?? ctx.positional[0];
    const min = Number(ctx.named['minimum'] ?? 0);
    const draw = () => max !== undefined && max !== null
      ? Math.floor(rng() * (Number(max) - min)) + min
      : Math.floor(rng() * 2147483647);
    if (count !== undefined) {
      return Array.from({ length: Math.max(0, count) }, draw);
    }
    return draw();
  }
}

// ─── Invoke-Expression ────────────────────────────────────────────────────

export class InvokeExpressionCmdlet implements ICmdlet {
  readonly name = 'invoke-expression';
  readonly parameters = ['Command'] as const;
  readonly aliases = ['iex'] as const;

  execute(ctx: CmdletContext): PSValue {
    const code = psValueToString(ctx.named['command'] ?? ctx.positional[0] ?? ctx.pipeInput ?? '');
    if (!code) return null;
    const produced = ctx.runtime.invokeScriptText(code, ctx.env);
    return produced.length === 0 ? null : produced.length === 1 ? produced[0] : produced;
  }
}

// ─── ConvertTo-SecureString ───────────────────────────────────────────────

export class ConvertToSecureStringCmdlet implements ICmdlet {
  readonly name = 'convertto-securestring';
  readonly displayName = 'ConvertTo-SecureString';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const val = psValueToString(ctx.positional[0] ?? ctx.pipeInput ?? '');
    return { SecureString: val, Length: val.length } as Record<string, PSValue>;
  }
}

export class ReadHostCmdlet implements ICmdlet {
  readonly name = 'read-host';
  readonly displayName = 'Read-Host';
  readonly description = 'Reads a line of input from the console.';
  readonly parameters = ['Prompt', 'AsSecureString', 'MaskInput'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const secure = ctx.named['assecurestring'] === true || ctx.named['maskinput'] === true;
    return secure ? ({ SecureString: '', Length: 0 } as Record<string, PSValue>) : '';
  }
}

export class GetHostCmdlet implements ICmdlet {
  readonly name = 'get-host';
  readonly displayName = 'Get-Host';
  readonly description = 'Gets an object that represents the current host program.';
  readonly parameters = [] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const version = ctx.env.get('PSVersionTable') as Record<string, PSValue> | undefined;
    return {
      Name: 'ConsoleHost',
      Version: version?.['PSVersion'] ?? '5.1.0',
      InstanceId: '00000000-0000-0000-0000-000000000000',
      CurrentCulture: 'en-US',
      CurrentUICulture: 'en-US',
      IsRunspacePushed: false,
    } as Record<string, PSValue>;
  }
}

// ─── Get-Help ─────────────────────────────────────────────────────────────

export class GetHelpCmdlet implements ICmdlet {
  readonly name = 'get-help';
  readonly description = 'Displays information about PowerShell commands and concepts.';
  readonly parameters = ['Name', 'Path', 'Category', 'Component', 'Functionality', 'Role', 'Detailed', 'Full', 'Examples', 'Parameter', 'Online', 'ShowWindow'] as const;
  readonly parameterValues = { Path: 'path' } as const;
  readonly aliases = ['help', 'man'] as const;

  execute(ctx: CmdletContext): PSValue {
    const name = psValueToString(
      ctx.named['name'] ?? ctx.positional[0] ?? helpTopicOf(ctx.pipeInput) ?? '');
    if (!name) {
      ctx.emit(HELP_SYSTEM_TOPIC);
      return null;
    }
    const block = ctx.runtime.getFunctionBlock(name) as unknown as PSScriptBlock | null;
    if (block !== null && block !== undefined) {
      const help = resolveHelp(block, ctx.runtime.getFunctionLeadingComment(name));
      const wanted = {
        component: ctx.named['component'] === undefined ? undefined : psValueToString(ctx.named['component']),
        role: ctx.named['role'] === undefined ? undefined : psValueToString(ctx.named['role']),
        functionality: ctx.named['functionality'] === undefined ? undefined : psValueToString(ctx.named['functionality']),
      };
      const matches = matchesFilter(help?.component ?? '', wanted.component)
        && matchesFilter(help?.role ?? '', wanted.role)
        && matchesFilter(help?.functionality ?? '', wanted.functionality);
      if (!matches) {
        ctx.emitErrorRecord(newErrorRecord({
          message: helpTopicNotFound(name).replace(/^Get-Help : /, ''),
          exceptionType: 'System.Management.Automation.Help.HelpNotFoundException',
          fullyQualifiedErrorId: 'HelpNotFound,Microsoft.PowerShell.Commands.GetHelpCommand',
          category: 'ObjectNotFound',
          targetObject: name,
        }) as unknown as PSValue);
        return null;
      }
      return helpObject(name, 'Function', help, block, ctx.runtime.getFunctionSignature(name)!) as unknown as PSValue;
    }
    const scriptPath = /\.ps1$/i.test(name) ? name : null;
    if (scriptPath !== null && ctx.providers.filesystem) {
      let content: string | null = null;
      try { content = ctx.providers.filesystem.readFile(scriptPath); } catch { content = null; }
      if (content !== null) {
        const head = scriptHeadHelp(content);
        const help = head === null ? null : parseCommentHelp(head);
        return helpObject(scriptPath, 'ExternalScript', help, null, { parameters: [], advanced: false, enumNames: () => null }) as unknown as PSValue;
      }
    }
    const rendered = renderCmdletHelp(name, {
      examples:   ctx.named['examples'] === true,
      detailed:   ctx.named['detailed'] === true,
      full:       ctx.named['full'] === true,
      online:     ctx.named['online'] === true,
      showWindow: ctx.named['showwindow'] === true,
      parameter:  ctx.named['parameter'] !== undefined ? psValueToString(ctx.named['parameter']) : undefined,
      declaredParameters: ctx.runtime.getCommandParameters(name),
    });
    if (rendered !== null) {
      ctx.emit(rendered);
      return null;
    }
    const known = ctx.runtime.listCmdlets().find(c =>
      c.name.toLowerCase() === name.toLowerCase()
      || (c.displayName ?? '').toLowerCase() === name.toLowerCase());
    if (!known) {
      ctx.emit(helpTopicNotFound(name));
      return null;
    }
    const label = known.displayName ?? name;
    const sections = [`NAME\n    ${label}`];
    if (known.description) sections.push(`SYNOPSIS\n    ${known.description}`);
    sections.push(`SYNTAX\n    ${label} [<CommonParameters>]`);
    sections.push(`DESCRIPTION\n    ${known.description ?? `Displays help for the ${label} cmdlet.`}`);
    ctx.emit(sections.join('\n\n'));
    return null;
  }
}

function helpTopicOf(pipeInput: PSValue): string | null {
  const first = Array.isArray(pipeInput) ? pipeInput[0] : pipeInput;
  if (first === null || first === undefined) return null;
  if (typeof first === 'string') return first;
  if (typeof first === 'object') {
    const record = first as Record<string, PSValue>;
    const named = record['Name'] ?? record['name'];
    if (named !== undefined) return psValueToString(named);
  }
  return null;
}

// ─── Get-Command ──────────────────────────────────────────────────────────

export class GetCommandCmdlet implements ICmdlet {
  readonly name = 'get-command';
  readonly parameters = ['Name', 'Verb', 'Noun', 'Module', 'CommandType', 'TotalCount', 'Syntax', 'ArgumentList', 'All', 'ListImported', 'ShowCommandInfo', 'ParameterName', 'ParameterType'] as const;
  readonly aliases = ['gcm'] as const;

  execute(ctx: CmdletContext): PSValue {
    // Enumerate every registered cmdlet — Get-Command's whole point is
    // discoverability, so we go straight to the registry instead of a
    // hard-coded subset. Each cmdlet supplies its own canonical
    // PascalCase displayName (open/closed: no central naming dictionary).
    const all = ctx.runtime.listCmdlets();

    type Row = {
      CommandType: 'Cmdlet' | 'Alias' | 'Function';
      Name: string;
      Version: string;
      Source: string;
      Definition?: string;
      ScriptBlock?: PSValue;
    };
    const rows: Row[] = [];
    for (const c of all) {
      const display = c.displayName ?? titleCaseCmdletName(c.name);
      const source  = c.module ?? 'Microsoft.PowerShell.Core';
      rows.push({
        CommandType: 'Cmdlet',
        Name: display,
        Version: '5.1.0',
        Source: source,
      });
      for (const a of c.aliases) {
        rows.push({
          CommandType: 'Alias',
          Name: a,
          Version: '',
          Source: '',
          Definition: display,
        });
      }
    }
    for (const fn of ctx.runtime.listFunctions()) {
      const block = ctx.runtime.getFunctionBlock(fn);
      const definition = block !== null && typeof block === 'object' ? (block as { sourceText?: string }).sourceText ?? '' : '';
      rows.push({ CommandType: 'Function', Name: fn, Version: '', Source: '', Definition: definition, ScriptBlock: block });
    }

    // -Name (positional or named): wildcard / exact, matched against the
    // display name. -Verb / -Noun split on the first dash.
    const nameRaw    = ctx.named['name'] ?? ctx.positional[0];
    const nameFilters = nameRaw === undefined || nameRaw === null || nameRaw === ''
      ? []
      : (Array.isArray(nameRaw) ? nameRaw : [nameRaw]).map(psValueToString).filter(n => n !== '');
    const verbFilter = ctx.named['verb'] ? psValueToString(ctx.named['verb']) : null;
    const nounFilter = ctx.named['noun'] ? psValueToString(ctx.named['noun']) : null;

    const nameMatches = (display: string): boolean => {
      const lower = display.toLowerCase();
      const dash  = display.indexOf('-');
      const verb  = dash > 0 ? display.slice(0, dash).toLowerCase() : '';
      const noun  = dash > 0 ? display.slice(dash + 1).toLowerCase() : lower;
      if (nameFilters.length > 0 && !nameFilters.some(n => wildcardMatches(n, lower))) return false;
      if (verbFilter && !wildcardMatches(verbFilter, verb)) return false;
      if (nounFilter && !wildcardMatches(nounFilter, noun)) return false;
      return true;
    };

    const filtered = (nameFilters.length > 0 || verbFilter || nounFilter)
      ? rows.filter(r => nameMatches(r.Name))
      : rows;

    // -CommandType filter
    const typeRaw = ctx.named['commandtype'];
    const typeFilter = typeRaw ? psValueToString(typeRaw).toLowerCase() : null;
    const byType = typeFilter
      ? filtered.filter(r => r.CommandType.toLowerCase() === typeFilter)
      : filtered;

    byType.sort((a, b) => a.Name.toLowerCase().localeCompare(b.Name.toLowerCase()));

    // De-duplicate by (CommandType, Name).
    const seen = new Set<string>();
    const unique = byType.filter(r => {
      const key = `${r.CommandType}::${r.Name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const asked of nameFilters) {
      if (hasWildcard(asked)) continue;
      if (!unique.some(r => r.Name.toLowerCase() === asked.toLowerCase())) {
        ctx.emitError(`Get-Command : ${commandNotFoundMessage(asked)}`);
      }
    }

    return unique as unknown as Record<string, PSValue>[];
  }
}

/** Convert a registry name like 'get-itemproperty' to 'Get-ItemProperty'. */
function titleCaseCmdletName(raw: string): string {
  return raw.split('-')
    .map(segment => segment.length === 0 ? '' :
      segment.replace(/(^|[^a-z])([a-z])/g, (_, prefix: string, ch: string) => prefix + ch.toUpperCase()))
    .join('-');
}

/** PowerShell-style match: literal substring OR `*?` wildcard (Like operator). */
// ─── Get-Module ───────────────────────────────────────────────────────────

export class GetModuleCmdlet implements ICmdlet {
  readonly name = 'get-module';
  readonly aliases = [] as const;
  readonly parameters = ['ListAvailable'] as const;
  execute(ctx: CmdletContext): PSValue {
    const listAvail = ctx.named['listavailable'] === true || ctx.named['listavailable'] === 'true';
    if (listAvail) {
      return [
        { Name: 'Microsoft.PowerShell.Core',    Version: '5.1.0', ModuleType: 'Manifest' },
        { Name: 'Microsoft.PowerShell.Utility',  Version: '5.1.0', ModuleType: 'Manifest' },
        { Name: 'Microsoft.PowerShell.Management',Version: '5.1.0', ModuleType: 'Manifest' },
      ] as Record<string, PSValue>[];
    }
    return [] as PSValue[];
  }
}

// ─── Import-Module ────────────────────────────────────────────────────────

export class ImportModuleCmdlet implements ICmdlet {
  readonly name = 'import-module';
  readonly aliases = ['ipmo'] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}

// ─── Invoke-Command ───────────────────────────────────────────────────────

export class InvokeCommandCmdlet implements ICmdlet {
  readonly name = 'invoke-command';
  readonly parameters = ['ComputerName', 'ScriptBlock', 'ArgumentList', 'Credential', 'Session', 'AsJob', 'JobName'] as const;
  readonly aliases = ['icm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const block = (ctx.named['scriptblock'] ?? ctx.positional[0]) as PSValue;
    if (!block) return null;

    const computerRaw = ctx.named['computername'];
    if (computerRaw === undefined || computerRaw === null) {
      return ctx.invokeBlock(block as never, null);
    }

    const computers = (Array.isArray(computerRaw) ? computerRaw : [computerRaw]).map(psValueToString);
    const argListRaw = ctx.named['argumentlist'];
    const argumentList = argListRaw === undefined || argListRaw === null
      ? []
      : (Array.isArray(argListRaw) ? argListRaw : [argListRaw]);
    const credential = namedCredential(ctx, 'credential');

    const remoting = ctx.providers.remoting;
    if (!remoting) {
      ctx.emitError('Invoke-Command : WinRM cannot complete the operation in this context.');
      return null;
    }

    const results: PSValue[] = [];
    for (const name of computers) {
      const remote = remoting.resolveComputer(name, credential);
      if (!remote || !remote.isRemotingEnabled()) {
        ctx.emitError(
          `Invoke-Command : Connecting to remote server ${name} failed with the following error message: ` +
          `WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer ` +
          `is accessible over the network, and that a firewall exception for the WinRM service is enabled and allows ` +
          `access from this computer.`,
        );
        continue;
      }
      const value = remote.invoke(block as never, argumentList);
      const items = Array.isArray(value) ? value : (value !== null && value !== undefined ? [value] : []);
      for (const item of items) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          (item as Record<string, PSValue>)['PSComputerName'] = remote.hostname;
        }
        results.push(item);
      }
    }

    if (ctx.named['asjob'] === true) {
      const jobs = ctx.providers.jobs;
      if (!jobs) return null;
      const jobName = ctx.named['jobname'] ? psValueToString(ctx.named['jobname']) : undefined;
      return jobInfoToPS(jobs.startJob(jobName, results, 0));
    }

    return results.length === 1 ? results[0] : results;
  }
}

// ─── Start-Job / Receive-Job / Wait-Job ───────────────────────────────────

export function jobInfoToPS(info: { id: number; name: string; state: string; hasMoreData: boolean; output: unknown[] }): Record<string, PSValue> {
  return {
    Id: info.id, Name: info.name, State: info.state,
    HasMoreData: info.hasMoreData, Output: info.output as PSValue[],
  };
}

function jobKey(ctx: CmdletContext): string | number | null {
  const id = ctx.named['id'];
  if (id != null) return Number(id);
  const arg = ctx.named['job'] ?? ctx.named['name'] ?? ctx.positional[0];
  if (arg != null && typeof arg === 'object') {
    const oid = (arg as Record<string, PSValue>)['Id'];
    if (oid != null) return Number(oid);
  }
  return (arg as string | number | null) ?? null;
}

export class StartJobCmdlet implements ICmdlet {
  readonly name = 'start-job';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ScriptBlock'] as const;

  execute(ctx: CmdletContext): PSValue {
    const jobs = ctx.providers.jobs;
    if (!jobs) return null;
    const block = (ctx.named['scriptblock'] ?? ctx.positional[0]) as PSValue;
    const name = (ctx.named['name'] as string | undefined) || undefined;
    jobs.beginRecording();
    const output = block ? ctx.invokeBlock(block as never, null) : null;
    const durationMs = jobs.endRecording();
    const arr = output == null ? [] : Array.isArray(output) ? output.filter(x => x != null) : [output];
    return jobInfoToPS(jobs.startJob(name, arr, durationMs));
  }
}

export class GetJobCmdlet implements ICmdlet {
  readonly name = 'get-job';
  readonly aliases = [] as const;
  readonly parameters = ['Id', 'Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const jobs = ctx.providers.jobs;
    if (!jobs) return null;
    const id = ctx.named['id'];
    const name = ctx.named['name'];
    if (id != null || name != null) {
      const info = jobs.getJob(id != null ? Number(id) : String(name));
      return info ? jobInfoToPS(info) : null;
    }
    for (const info of jobs.listJobs()) ctx.emit(jobInfoToPS(info));
    return null;
  }
}

export class ReceiveJobCmdlet implements ICmdlet {
  readonly name = 'receive-job';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const jobs = ctx.providers.jobs;
    if (!jobs) return null;
    const key = jobKey(ctx);
    if (key == null) return null;
    const out = jobs.receiveJob(key) as PSValue[];
    if (out.length === 0) return null;
    return out.length === 1 ? out[0] : out;
  }
}

export class WaitJobCmdlet implements ICmdlet {
  readonly name = 'wait-job';
  readonly aliases = [] as const;
  readonly parameters = ['Job'] as const;

  execute(ctx: CmdletContext): PSValue {
    const jobs = ctx.providers.jobs;
    if (!jobs) return null;
    const key = jobKey(ctx);
    if (key == null) return null;
    const info = jobs.waitJob(key);
    if (!info) return null;
    const arg = ctx.named['job'] ?? ctx.positional[0];
    if (arg != null && typeof arg === 'object') {
      (arg as Record<string, PSValue>)['State'] = info.state;
      (arg as Record<string, PSValue>)['HasMoreData'] = info.hasMoreData;
    }
    return jobInfoToPS(info);
  }
}

const PROVIDERS = ['Alias', 'Environment', 'FileSystem', 'Function', 'Registry', 'Variable'] as const;

function providerNamed(name: string): string | undefined {
  return PROVIDERS.find(candidate => candidate.toLowerCase() === name.toLowerCase());
}

export class NewPSDriveCmdlet implements ICmdlet {
  readonly name = 'new-psdrive';
  readonly displayName = 'New-PSDrive';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'PSProvider', 'Root', 'Description', 'Scope', 'Persist', 'Credential'] as const;
  readonly switchParameters = ['Persist'] as const;

  execute(ctx: CmdletContext): PSValue {
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const root = psValueToString(ctx.named['root'] ?? ctx.positional[2] ?? '');
    const existing = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
    // A UNC root names a share on another machine: mapping it is a real
    // SMB connection, recorded where `net use` reads it, not a row in a
    // shell variable.
    if (root.startsWith('\\\\')) {
      const smb = ctx.providers.smb;
      if (!smb?.mapDrive) {
        ctx.emitError(`New-PSDrive : This computer cannot map a network drive.`);
        return null;
      }
      const mapped = smb.mapDrive(name.endsWith(':') ? name : `${name}:`, root, namedCredential(ctx, 'credential'));
      if (!mapped.ok) {
        ctx.emitError(`New-PSDrive : ${mapped.error ?? 'The network path was not found.'}`);
        return null;
      }
      return { Name: name, Root: root, Used: 0, Free: 0, Provider: 'FileSystem' } as Record<string, PSValue>;
    }
    if (existing[name.toLowerCase()] !== undefined) {
      ctx.emitError(`New-PSDrive : A drive with the name '${name}' already exists.`);
      return null;
    }
    const requested = ctx.named['psprovider'] !== undefined ? psValueToString(ctx.named['psprovider']) : isRegistryPath(root) ? 'Registry' : 'FileSystem';
    const provider = providerNamed(requested);
    if (provider === undefined) {
      ctx.emitError(`New-PSDrive : Cannot find a provider with the name '${requested}'.`);
      return null;
    }
    const fs = ctx.providers.filesystem;
    if (provider === 'FileSystem' && fs !== undefined && !(fs.exists(root) && fs.isDirectory(root))) {
      ctx.emitError(`New-PSDrive : The specified drive root "${root}" either does not exist, or it is not a folder.`);
      return null;
    }
    const drive = { Name: name, Root: root, Provider: provider } as Record<string, PSValue>;
    (existing as Record<string, PSValue>)[name.toLowerCase()] = drive;
    ctx.runtime.setVariable('__drives__', existing);
    return { Name: name, ...occupancyOf(ctx, root), Provider: provider, Root: root };
  }
}

// ─── Get-PSDrive ──────────────────────────────────────────────────────────

export class GetPSDriveCmdlet implements ICmdlet {
  readonly name = 'get-psdrive';
  readonly displayName = 'Get-PSDrive';
  readonly aliases = ['gdr'] as const;
  readonly parameters = ['Name', 'PSProvider', 'Scope'] as const;

  execute(ctx: CmdletContext): PSValue {
    const rows = this.drives(ctx);
    const providers = namesOf(ctx.named['psprovider']);
    for (const provider of providers) {
      if (!hasWildcard(provider) && !PROVIDERS.some(candidate => candidate.toLowerCase() === provider.toLowerCase())) {
        ctx.emitError(`Get-PSDrive : Cannot find a provider with the name '${provider}'.`);
        return null;
      }
    }
    const byProvider = providers.length === 0
      ? rows
      : rows.filter(row => providers.some(pattern => wildcardMatches(pattern, psValueToString(row['Provider']))));
    const patterns = [...namesOf(ctx.named['name']), ...ctx.positional.flatMap(namesOf)];
    if (patterns.length === 0) return byProvider;
    const found: Record<string, PSValue>[] = [];
    for (const pattern of patterns) {
      const matching = byProvider.filter(row => wildcardMatches(pattern, psValueToString(row['Name'])));
      if (matching.length === 0 && !hasWildcard(pattern)) {
        ctx.emitError(`Get-PSDrive : Cannot find drive. A drive with the name '${pattern}' does not exist.`);
        continue;
      }
      for (const row of matching) if (!found.includes(row)) found.push(row);
    }
    return found.length === 0 ? null : found.length === 1 ? found[0] : found;
  }

  private drives(ctx: CmdletContext): Record<string, PSValue>[] {
    const declared = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
    const rows: Record<string, PSValue>[] = [];
    const fs = ctx.providers.filesystem;

    // The file-system drives are the volumes the machine actually mounts,
    // with their real occupancy — not a frozen list beside the file system.
    for (const volume of ctx.providers.disks?.listVolumes() ?? []) {
      const letter = volume.driveLetter;
      const here = fs?.driveLocation?.(letter) ?? `${letter}:\\`;
      rows.push({
        Name:     letter,
        ...volumeOccupancy(volume),
        Provider: 'FileSystem',
        Root:     `${letter}:\\`,
        CurrentLocation: here.slice(3),
      });
    }
    const mounted = new Set(rows.map(r => psValueToString(r['Name']).toLowerCase()));
    for (const [key, value] of Object.entries(declared)) {
      if (mounted.has(key)) continue;
      const rec = value as Record<string, PSValue>;
      rows.push({
        Name:     rec['Name'],
        ...occupancyOf(ctx, String(rec['Root'])),
        Provider: rec['Provider'],
        Root:     rec['Root'],
      });
    }

    // Mapped network drives come from the machine's own table — the very
    // one `net use` lists — so the two views cannot disagree about which
    // drives exist.
    for (const mapping of ctx.providers.smb?.listMappings?.() ?? []) {
      if (!mapping.local) continue;
      const letter = mapping.local.replace(/:$/, '');
      if (rows.some(r => psValueToString(r['Name']).toLowerCase() === letter.toLowerCase())) continue;
      rows.push({
        Name: letter, Used: '', Free: '', Provider: 'FileSystem', Root: mapping.remote,
      });
    }

    return rows.sort((a, b) => psValueToString(a['Name']).toLowerCase().localeCompare(psValueToString(b['Name']).toLowerCase()));
  }
}

function namesOf(value: PSValue): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(psValueToString).filter(name => name !== '');
}

// ─── Remove-PSDrive ────────────────────────────────────────────────────────

export class RemovePSDriveCmdlet implements ICmdlet {
  readonly name = 'remove-psdrive';
  readonly displayName = 'Remove-PSDrive';
  readonly aliases = ['rdr'] as const;
  readonly parameters = ['Name', 'PSProvider', 'Scope', 'Force', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Remove-PSDrive : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const letter = name.endsWith(':') ? name : `${name}:`;
    if (ctx.providers.smb?.unmapDrive?.(letter)) return null;
    const declared = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
    if (declared[name.toLowerCase()] === undefined) {
      ctx.emitError(`Remove-PSDrive : Cannot find drive. A drive with the name '${name}' does not exist.`);
      return null;
    }
    delete declared[name.toLowerCase()];
    ctx.runtime.setVariable('__drives__', declared);
    return null;
  }
}

function driveGigabytes(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(2);
}

function volumeOccupancy(volume: VolumeInfo): { Used: string; Free: string } {
  return { Used: driveGigabytes(volume.size - volume.sizeRemaining), Free: driveGigabytes(volume.sizeRemaining) };
}

function occupancyOf(ctx: CmdletContext, root: string): { Used: string; Free: string } {
  const letter = /^([A-Za-z]):/.exec(root)?.[1].toUpperCase();
  const volume = letter === undefined
    ? undefined
    : ctx.providers.disks?.listVolumes().find(candidate => candidate.driveLetter.toUpperCase() === letter);
  return volume === undefined ? { Used: '', Free: '' } : volumeOccupancy(volume);
}

// ─── Clear-Host ───────────────────────────────────────────────────────────

export class ClearHostCmdlet implements ICmdlet {
  readonly name = 'clear-host';
  readonly aliases = ['cls', 'clear'] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}

// ─── Get-PSProvider ───────────────────────────────────────────────────────

export class GetPSProviderCmdlet implements ICmdlet {
  readonly name = 'get-psprovider';
  readonly displayName = 'Get-PSProvider';
  readonly aliases = [] as const;
  readonly parameters = ['PSProvider'] as const;

  execute(ctx: CmdletContext): PSValue {
    const filter = psValueToString(ctx.named['psprovider'] ?? ctx.positional[0] ?? '').trim();
    const providers = [
      { Name: 'Alias',       Capabilities: 'ShouldProcess',                         Drives: 'Alias' },
      { Name: 'Environment', Capabilities: 'ShouldProcess',                         Drives: 'Env'   },
      { Name: 'FileSystem',  Capabilities: 'Filter, ShouldProcess, Credentials',    Drives: 'C, D'  },
      { Name: 'Function',    Capabilities: 'ShouldProcess',                         Drives: 'Function' },
      { Name: 'Registry',    Capabilities: 'ShouldProcess, Transactions',           Drives: 'HKLM, HKCU' },
      { Name: 'Variable',    Capabilities: 'ShouldProcess',                         Drives: 'Variable' },
    ];
    if (!filter) return providers as unknown as PSValue;
    const pat = wildcardToRegex(filter);
    const matched = providers.filter(p => pat.test(p.Name));
    return matched as unknown as PSValue;
  }
}

export class GetHistoryCmdlet implements ICmdlet {
  readonly name = 'get-history';
  readonly displayName = 'Get-History';
  readonly aliases = ['h', 'history'] as const;
  readonly description = 'Gets a list of the commands entered during the current session.';
  readonly parameters = ['Id', 'Count'] as const;

  execute(ctx: CmdletContext): PSValue {
    const entries = ctx.runtime.listHistory()
      .map((line, index) => ({ Id: index + 1, CommandLine: line }));
    const idRaw = ctx.named['id'] ?? ctx.positional[0];
    if (idRaw !== undefined) {
      const wanted = (Array.isArray(idRaw) ? idRaw : [idRaw])
        .map(v => Number(psValueToString(v)));
      const picked = entries.filter(e => wanted.includes(e.Id));
      for (const missing of wanted.filter(w => !entries.some(e => e.Id === w))) {
        ctx.emitError(`Get-History : Cannot find command history for Id '${missing}'.`);
      }
      return picked as unknown as PSValue;
    }
    const countRaw = ctx.named['count'] ?? ctx.positional[1];
    if (countRaw === undefined) return entries as unknown as PSValue;
    const count = Number(psValueToString(countRaw));
    if (!Number.isFinite(count) || count < 0) {
      ctx.emitError(`Get-History : Cannot convert value "${psValueToString(countRaw)}" to type "System.Int32".`);
      return null;
    }
    return entries.slice(Math.max(0, entries.length - count)) as unknown as PSValue;
  }
}

function processPolicyPort(ctx: CmdletContext): ProcessPolicyPort {
  return {
    read: () => {
      const v = ctx.runtime.getVariable(PROCESS_POLICY_VARIABLE);
      return v === undefined || v === null || v === '' ? null : psValueToString(v);
    },
    write: (value: string | null) => {
      ctx.runtime.setVariable(PROCESS_POLICY_VARIABLE, value === null ? '' : value);
    },
  };
}

export class GetExecutionPolicyCmdlet implements ICmdlet {
  readonly name = 'get-executionpolicy';
  readonly displayName = 'Get-ExecutionPolicy';
  readonly aliases = [] as const;
  readonly description = 'Gets the execution policies for the current session.';
  readonly parameters = ['Scope', 'List'] as const;

  execute(ctx: CmdletContext): PSValue {
    const port = processPolicyPort(ctx);
    if (ctx.named['list'] !== undefined) {
      return EXECUTION_POLICY_SCOPES.map(scope => ({
        Scope: scope,
        ExecutionPolicy: storedPolicy(ctx.providers, scope, port),
      } as Record<string, PSValue>)) as PSValue;
    }
    const rawScope = ctx.named['scope'] ?? ctx.positional[0];
    if (rawScope === undefined) {
      return effectiveExecutionPolicy(ctx.providers, port).policy;
    }
    const scope = matchExecutionPolicyScope(psValueToString(rawScope));
    if (scope === null) {
      ctx.emitError(`Get-ExecutionPolicy : Cannot validate argument on parameter 'Scope'. The argument does not belong to the set "${EXECUTION_POLICY_SCOPES.join(',')}".`);
      return null;
    }
    return storedPolicy(ctx.providers, scope, port);
  }
}

export class SetExecutionPolicyCmdlet implements ICmdlet {
  readonly name = 'set-executionpolicy';
  readonly displayName = 'Set-ExecutionPolicy';
  readonly aliases = [] as const;
  readonly description = 'Sets the PowerShell execution policies for Windows computers.';
  readonly parameters = ['ExecutionPolicy', 'Scope', 'Force', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const rawPolicy = ctx.named['executionpolicy'] ?? ctx.positional[0];
    if (rawPolicy === undefined) {
      ctx.emitError('Set-ExecutionPolicy : Cannot process command because of one or more missing mandatory parameters: ExecutionPolicy.');
      return null;
    }
    const policy = matchExecutionPolicy(psValueToString(rawPolicy));
    if (policy === null) {
      ctx.emitError(`Set-ExecutionPolicy : Cannot validate argument on parameter 'ExecutionPolicy'. The argument does not belong to the set "${EXECUTION_POLICIES.join(',')}".`);
      return null;
    }
    const rawScope = ctx.named['scope'] ?? ctx.positional[1];
    const scope = rawScope === undefined
      ? 'LocalMachine'
      : matchExecutionPolicyScope(psValueToString(rawScope));
    if (scope === null) {
      ctx.emitError(`Set-ExecutionPolicy : Cannot validate argument on parameter 'Scope'. The argument does not belong to the set "${EXECUTION_POLICY_SCOPES.join(',')}".`);
      return null;
    }
    if (ctx.named['whatif'] !== undefined) {
      ctx.emit(`What if: Setting the execution policy to ${policy} in the ${scope} scope.`);
      return null;
    }
    const failure = writeExecutionPolicy(
      ctx.providers, scope, policy, processPolicyPort(ctx));
    if (failure) { ctx.emitError(`Set-ExecutionPolicy : ${failure}`); return null; }
    return null;
  }
}
