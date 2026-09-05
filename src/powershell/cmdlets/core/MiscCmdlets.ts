/**
 * MiscCmdlets — Miscellaneous core cmdlets.
 *
 * New-Object, Get-Random, Invoke-Expression, Get-Command, Get-Help.
 * No system providers required (except Get-Command which reads the registry).
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import {
  type ProcessPolicyPort, EXECUTION_POLICIES, EXECUTION_POLICY_SCOPES,
  PROCESS_POLICY_VARIABLE, effectiveExecutionPolicy, matchExecutionPolicy,
  matchExecutionPolicyScope, storedPolicy, writeExecutionPolicy,
} from '@/powershell/executionPolicy';
import { parseCredentialArg } from './RemotingCmdlets';
import { makePSCredential } from '@/powershell/credential/PSCredential';
import { wildcardMatches, wildcardToRegex } from '@/powershell/runtime/PSWildcard';
import { renderCmdletHelp, helpTopicNotFound, HELP_SYSTEM_TOPIC } from '@/powershell/help/renderHelp';

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
    return ctx.runtime.executeForValue(code);
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

// ─── Get-Help ─────────────────────────────────────────────────────────────

export class GetHelpCmdlet implements ICmdlet {
  readonly name = 'get-help';
  readonly description = 'Displays information about PowerShell commands and concepts.';
  readonly parameters = ['Name', 'Path', 'Category', 'Component', 'Functionality', 'Role', 'Detailed', 'Full', 'Examples', 'Parameter', 'Online', 'ShowWindow'] as const;
  readonly aliases = ['help', 'man'] as const;

  execute(ctx: CmdletContext): PSValue {
    const name = psValueToString(
      ctx.named['name'] ?? ctx.positional[0] ?? helpTopicOf(ctx.pipeInput) ?? '');
    if (!name) {
      ctx.emit(HELP_SYSTEM_TOPIC);
      return null;
    }
    const source = ctx.runtime.getFunctionSource(name);
    if (source) {
      const help = extractCommentHelp(source);
      const synopsis = help['synopsis'] ?? '';
      const description = help['description'] ?? '';
      const examples = help['example'] ?? '';
      const sections: string[] = [`NAME\n    ${name}`];
      if (synopsis) sections.push(`SYNOPSIS\n    ${synopsis}`);
      sections.push(`SYNTAX\n    ${name} [<CommonParameters>]`);
      if (description) sections.push(`DESCRIPTION\n    ${description}`);
      if (examples) sections.push(`EXAMPLES\n    ${examples}`);
      ctx.emit(sections.join('\n\n'));
      return null;
    }
    const rendered = renderCmdletHelp(name, {
      examples:   ctx.named['examples'] === true,
      detailed:   ctx.named['detailed'] === true,
      full:       ctx.named['full'] === true,
      online:     ctx.named['online'] === true,
      showWindow: ctx.named['showwindow'] === true,
      parameter:  ctx.named['parameter'] !== undefined ? psValueToString(ctx.named['parameter']) : undefined,
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

/**
 * Un chemin que le fournisseur de fichiers peut juger.
 *
 * `C:` est un lecteur de fichiers ; `TestDrive:`, `HKLM:`, `Env:` sont
 * des lecteurs PowerShell d'un AUTRE fournisseur, dont le systeme de
 * fichiers ne sait rien — lui demander si le chemin existe reviendrait a
 * refuser un `Set-Location HKLM:` parfaitement valide. Une lettre unique
 * suivie de `:` est un lecteur de fichiers ; un nom plus long ne l'est
 * pas.
 */
function isFileSystemPath(path: string): boolean {
  const qualifier = /^([A-Za-z]+):/.exec(path);
  return qualifier === null || qualifier[1].length === 1;
}

export function extractCommentHelp(source: string): Record<string, string> {
  const blockRe = /<#([\s\S]*?)#>/;
  const block = blockRe.exec(source);
  if (!block) return {};
  const body = block[1];
  const result: Record<string, string> = {};
  // `\Z` n'est pas une ancre en JavaScript — c'est un `Z` litteral. La
  // derniere section d'un bloc d'aide n'etait donc capturee que si elle
  // contenait la lettre Z ; la fin d'entree s'ecrit `(?![\s\S])`.
  const sectionRe = /^\s*\.([A-Z][A-Z]+)\s*$([\s\S]*?)(?=^\s*\.[A-Z][A-Z]+\s*$|(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(body)) !== null) {
    result[m[1].toLowerCase()] = m[2].trim();
  }
  if (Object.keys(result).length === 0) {
    const lines = body.split(/\n/);
    let currentKey = '';
    let buf: string[] = [];
    const flush = () => { if (currentKey) result[currentKey] = buf.join('\n').trim(); buf = []; };
    for (const raw of lines) {
      const headerMatch = raw.match(/^\s*\.([A-Z][A-Z_]+)\s*$/);
      if (headerMatch) {
        flush();
        currentKey = headerMatch[1].toLowerCase();
      } else if (currentKey) {
        buf.push(raw.trim());
      }
    }
    flush();
  }
  return result;
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

    // -Name (positional or named): wildcard / exact, matched against the
    // display name. -Verb / -Noun split on the first dash.
    const nameRaw    = ctx.named['name'] ?? ctx.positional[0];
    const nameFilter = nameRaw !== undefined && nameRaw !== null && nameRaw !== ''
      ? psValueToString(nameRaw) : null;
    const verbFilter = ctx.named['verb'] ? psValueToString(ctx.named['verb']) : null;
    const nounFilter = ctx.named['noun'] ? psValueToString(ctx.named['noun']) : null;

    const nameMatches = (display: string): boolean => {
      const lower = display.toLowerCase();
      const dash  = display.indexOf('-');
      const verb  = dash > 0 ? display.slice(0, dash).toLowerCase() : '';
      const noun  = dash > 0 ? display.slice(dash + 1).toLowerCase() : lower;
      if (nameFilter && !wildcardMatches(nameFilter, lower)) return false;
      if (verbFilter && !wildcardMatches(verbFilter, verb)) return false;
      if (nounFilter && !wildcardMatches(nounFilter, noun)) return false;
      return true;
    };

    const filtered = (nameFilter || verbFilter || nounFilter)
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
    const credentialRaw = ctx.named['credential'];
    const credential = credentialRaw !== undefined && credentialRaw !== null
      ? parseCredentialArg(psValueToString(credentialRaw)) : undefined;

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

function jobInfoToPS(info: { id: number; name: string; state: string; hasMoreData: boolean; output: unknown[] }): Record<string, PSValue> {
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

// ─── Set-Location ─────────────────────────────────────────────────────────

export class SetLocationCmdlet implements ICmdlet {
  readonly name = 'set-location';
  readonly parameters = ['Path', 'LiteralPath', 'PassThru', 'StackName'] as const;
  readonly aliases = ['cd', 'chdir', 'sl'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    const fs = ctx.providers.filesystem;
    // Se placer dans un répertoire qui n'existe pas est refusé, comme
    // par PowerShell : le curseur suivait n'importe quel chemin, si bien
    // que `$PWD` désignait un dossier absent et que tout ce qui suivait
    // travaillait dans le vide.
    if (fs && path && isFileSystemPath(path) && !fs.exists(path)) {
      ctx.emitError(`Cannot find path '${path}' because it does not exist.`);
      return null;
    }
    if (fs && path) fs.setCwd(path);
    return null;
  }
}

export class PushLocationCmdlet implements ICmdlet {
  readonly name = 'push-location';
  readonly parameters = ['Path', 'LiteralPath', 'PassThru', 'StackName'] as const;
  readonly aliases = ['pushd'] as const;

  execute(ctx: CmdletContext): PSValue {
    const fs = ctx.providers.filesystem;
    const stack = (ctx.runtime.getVariable('__locationStack__') as PSValue[] | null) ?? [];
    stack.push((fs ? fs.getCwd() : 'C:\\') as PSValue);
    ctx.runtime.setVariable('__locationStack__', stack as unknown as PSValue);
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    if (fs && path && isFileSystemPath(path) && !fs.exists(path)) {
      ctx.emitError(`Cannot find path '${path}' because it does not exist.`);
      return null;
    }
    if (fs && path) fs.setCwd(path);
    return null;
  }
}

export class PopLocationCmdlet implements ICmdlet {
  readonly name = 'pop-location';
  readonly parameters = ['PassThru', 'StackName'] as const;
  readonly aliases = ['popd'] as const;

  execute(ctx: CmdletContext): PSValue {
    const fs = ctx.providers.filesystem;
    const stack = (ctx.runtime.getVariable('__locationStack__') as PSValue[] | null) ?? [];
    const prev = stack.pop();
    ctx.runtime.setVariable('__locationStack__', stack as unknown as PSValue);
    if (prev !== undefined && prev !== null) {
      const path = psValueToString(prev);
      if (fs) fs.setCwd(path);
    }
    return null;
  }
}

export class GetLocationCmdlet implements ICmdlet {
  readonly name = 'get-location';
  readonly parameters = ['PSProvider', 'PSDrive', 'Stack', 'StackName'] as const;
  readonly aliases = ['pwd', 'gl'] as const;

  execute(ctx: CmdletContext): PSValue {
    const fs = ctx.providers.filesystem;
    const cwd = fs ? fs.getCwd() : 'C:\\';
    return { Path: cwd, ProviderPath: cwd, Provider: 'FileSystem' } as Record<string, PSValue>;
  }
}

// ─── New-PSDrive ──────────────────────────────────────────────────────────

export class NewPSDriveCmdlet implements ICmdlet {
  readonly name = 'new-psdrive';
  readonly displayName = 'New-PSDrive';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const root = psValueToString(ctx.named['root'] ?? '');
    const drive = { Name: name, Root: root, Used: 0, Free: 0 } as Record<string, PSValue>;
    // Register drive in global scope for Get-PSDrive to retrieve
    const existing = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
    (existing as Record<string, PSValue>)[name.toLowerCase()] = drive;
    ctx.runtime.setVariable('__drives__', existing);
    return drive;
  }
}

// ─── Get-PSDrive ──────────────────────────────────────────────────────────

export class GetPSDriveCmdlet implements ICmdlet {
  readonly name = 'get-psdrive';
  readonly displayName = 'Get-PSDrive';
  readonly aliases = ['gdr'] as const;

  execute(ctx: CmdletContext): PSValue {
    const nameFilter = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '').toLowerCase();
    const drives = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
    const shape = (d: PSValue): Record<string, PSValue> => {
      const rec = d as Record<string, PSValue>;
      return {
        Name:     rec['Name'],
        Used:     rec['Used'] ?? '',
        Free:     rec['Free'] ?? '',
        Provider: rec['Provider'] ?? inferProvider(String(rec['Root'] ?? '')),
        Root:     rec['Root'],
      } as Record<string, PSValue>;
    };
    if (nameFilter) {
      const drive = drives[nameFilter];
      return drive ? shape(drive) : null;
    }
    return Object.values(drives).map(shape);
  }
}

function inferProvider(root: string): string {
  if (/^[A-Za-z]:\\?$/.test(root)) return 'FileSystem';
  if (/^HK/i.test(root))           return 'Registry';
  return '';
}

// ─── Clear-Host ───────────────────────────────────────────────────────────

export class ClearHostCmdlet implements ICmdlet {
  readonly name = 'clear-host';
  readonly aliases = ['cls', 'clear'] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}

// ─── Get-Alias ────────────────────────────────────────────────────────────
//
// Returns the built-in alias map.  Real PowerShell ships dozens; we mirror
// every alias declared on a registered cmdlet so the listing stays in sync
// with whatever the interpreter actually accepts.  `Get-Alias <name>` and
// `Get-Alias -Name <pattern>` filter the result.

interface AliasEntry { Name: string; Definition: string; CommandType: string }

export class GetAliasCmdlet implements ICmdlet {
  readonly name = 'get-alias';
  readonly aliases = ['gal'] as const;

  execute(ctx: CmdletContext): PSValue {
    const filter = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '').trim();
    const all: AliasEntry[] = [];
    for (const cmdlet of ctx.runtime.listCmdlets()) {
      for (const a of cmdlet.aliases) {
        all.push({ Name: a, Definition: cmdlet.name, CommandType: 'Alias' });
      }
    }
    all.sort((a, b) => a.Name.localeCompare(b.Name));
    if (!filter) return all as unknown as PSValue;
    const pat = wildcardToRegex(filter);
    const matched = all.filter(e => pat.test(e.Name));
    if (matched.length === 0) {
      ctx.emitError(`Get-Alias : Cannot find alias because alias with name '${filter}' does not exist.`);
      return null;
    }
    return matched as unknown as PSValue;
  }
}


// ─── Get-PSProvider ───────────────────────────────────────────────────────

export class GetPSProviderCmdlet implements ICmdlet {
  readonly name = 'get-psprovider';
  readonly displayName = 'Get-PSProvider';
  readonly aliases = [] as const;

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
