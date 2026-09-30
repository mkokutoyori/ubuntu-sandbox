import type { ICmdlet } from './ICmdlet';
import type { CmdletContext } from './CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

const LOCAL_TARGETS = ['.', 'localhost', '127.0.0.1', '::1'];

function quoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function literal(value: PSValue): string | null {
  if (value === null || value === undefined) return '$null';
  if (typeof value === 'boolean') return value ? '$true' : '$false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return quoted(value);
  if (Array.isArray(value)) {
    const items = value.map(literal);
    return items.some(item => item === null) ? null : items.join(',');
  }
  return null;
}

function commandLine(displayName: string, ctx: CmdletContext, parameter: string): string | null {
  const parts = [displayName];
  for (const [key, value] of Object.entries(ctx.named)) {
    if (key === parameter.toLowerCase()) continue;
    const text = literal(value);
    if (text === null) return null;
    parts.push(`-${key}:${text.includes(',') ? `(${text})` : text}`);
  }
  for (const value of ctx.positional) {
    const text = literal(value);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join(' ');
}

function isLocal(target: string, own: string): boolean {
  const name = target.toLowerCase();
  const self = own.toLowerCase();
  return LOCAL_TARGETS.includes(name) || name === self || name.startsWith(`${self}.`);
}

function parseRemoteOutput(output: string, computer: string): PSValue[] | string {
  const text = output.trim();
  if (text === '') return [];
  try {
    const parsed = JSON.parse(text) as PSValue;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map(item => (item !== null && typeof item === 'object' && !Array.isArray(item)
      ? { ...(item as Record<string, PSValue>), PSComputerName: computer } : item));
  } catch {
    return text;
  }
}

export function remotable(displayName: string, cmdlet: ICmdlet, parameter = 'ComputerName'): ICmdlet {
  const key = parameter.toLowerCase();
  return {
    ...cmdlet,
    execute(ctx: CmdletContext): PSValue {
      const raw = ctx.named[key];
      const remoting = ctx.providers.remoting;
      if (raw === undefined || raw === null || !remoting) return cmdlet.execute(ctx);
      const targets = (Array.isArray(raw) ? raw : [raw]).map(psValueToString).filter(t => t !== '');
      const own = remoting.localComputerName();
      const remote = targets.filter(t => !isLocal(t, own));
      if (remote.length === 0) return cmdlet.execute(ctx);
      const line = commandLine(displayName, ctx, parameter);
      if (line === null) {
        ctx.emitError(`${displayName} : an object argument cannot be marshalled to another computer; pipe or run it on that computer.`);
        return null;
      }
      const results: PSValue[] = [];
      for (const computer of remote) {
        const outcome = remoting.runCommand(computer, `${line} | ConvertTo-Json -Depth 6 -Compress`);
        if (!outcome.ok) {
          ctx.emitError(`${displayName} : Cannot connect to ${computer}: ${outcome.error ?? 'Access is denied.'}`);
          continue;
        }
        const parsed = parseRemoteOutput(outcome.output ?? '', computer);
        if (typeof parsed === 'string') ctx.emitError(parsed);
        else results.push(...parsed);
      }
      return results.length === 1 ? results[0] : results;
    },
  };
}
