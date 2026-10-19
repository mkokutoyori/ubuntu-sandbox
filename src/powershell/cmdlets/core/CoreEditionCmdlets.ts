import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { formatString } from '@/powershell/runtime/semantics/CompositeFormat';

function toArray(value: PSValue): PSValue[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isScriptBlock(value: PSValue): value is PSScriptBlock {
  return value !== null && typeof value === 'object' && (value as { type?: string }).type === 'ScriptBlock';
}

export class JoinStringCmdlet implements ICmdlet {
  readonly name = 'join-string';
  readonly displayName = 'Join-String';
  readonly description = 'Combines objects from the pipeline into a single string.';
  readonly aliases = [] as const;
  readonly coreOnly = true as const;
  readonly parameters = ['Property', 'Separator', 'OutputPrefix', 'OutputSuffix', 'SingleQuote', 'DoubleQuote', 'FormatString', 'UseCulture', 'InputObject'] as const;

  execute(ctx: CmdletContext): PSValue {
    const positional = [...ctx.positional];
    const property = ctx.named['property'] ?? positional.shift();
    const separatorValue = ctx.named['separator'] ?? positional.shift();
    const ofs = ctx.env.get('OFS');
    const separator = separatorValue !== undefined && separatorValue !== null
      ? psValueToString(separatorValue)
      : ofs !== undefined && ofs !== null ? psValueToString(ofs) : '';
    const prefix = psValueToString(ctx.named['outputprefix'] ?? ctx.named['op'] ?? '');
    const suffix = psValueToString(ctx.named['outputsuffix'] ?? ctx.named['os'] ?? '');
    const quote = ctx.named['singlequote'] === true ? "'" : ctx.named['doublequote'] === true ? '"' : '';
    const format = ctx.named['formatstring'] !== undefined ? psValueToString(ctx.named['formatstring']) : '';
    const items = toArray(ctx.named['inputobject'] ?? ctx.pipeInput);

    const pieces: string[] = [];
    for (const item of items) {
      if (item === null || item === undefined) continue;
      let value: PSValue = item;
      if (isScriptBlock(property)) {
        value = ctx.invokeBlock(property, item);
      } else if (property !== undefined && property !== null) {
        const record = item as Record<string, PSValue>;
        const key = typeof item === 'object'
          ? Object.keys(record).find(k => k.toLowerCase() === psValueToString(property).toLowerCase())
          : undefined;
        value = key !== undefined ? record[key] : null;
      }
      const text = psValueToString(value);
      if (quote !== '') pieces.push(`${quote}${text}${quote}`);
      else if (format !== '') pieces.push(formatString(format, [value]));
      else pieces.push(text);
    }
    return `${prefix}${pieces.join(separator)}${suffix}`;
  }
}

export class TestJsonCmdlet implements ICmdlet {
  readonly name = 'test-json';
  readonly displayName = 'Test-Json';
  readonly description = 'Tests whether a string is a valid JSON document.';
  readonly aliases = [] as const;
  readonly coreOnly = true as const;
  readonly parameters = ['Json'] as const;

  execute(ctx: CmdletContext): PSValue {
    const source = psValueToString(ctx.named['json'] ?? ctx.positional[0] ?? ctx.pipeInput ?? '');
    try {
      JSON.parse(source);
      return true;
    } catch {
      ctx.emitError('Test-Json : Cannot parse the JSON.');
      return false;
    }
  }
}
