import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue, PSEnvironment } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

type PSObj = Record<string, PSValue>;

export class AddMemberCmdlet implements ICmdlet {
  readonly name = 'add-member';
  readonly parameters = [
    'InputObject', 'MemberType', 'Name', 'Value', 'SecondValue',
    'TypeName', 'PassThru', 'Force',
    'NotePropertyName', 'NotePropertyValue', 'NotePropertyMembers',
  ] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const target = (ctx.named['inputobject'] ?? ctx.pipeInput) as PSValue;
    if (target === null || target === undefined || typeof target !== 'object') {
      ctx.emitError('Add-Member: input object must be an object.');
      return null;
    }
    const obj = target as PSObj;
    const passThru = !!ctx.named['passthru'];
    const force = !!ctx.named['force'];

    const noteName = ctx.named['notepropertyname'];
    if (noteName !== undefined && noteName !== null) {
      const key = psValueToString(noteName);
      if (force || !(key in obj)) obj[key] = ctx.named['notepropertyvalue'] ?? null;
      return passThru ? obj : null;
    }
    const noteMembers = ctx.named['notepropertymembers'];
    if (noteMembers !== undefined && noteMembers !== null && typeof noteMembers === 'object') {
      for (const [k, v] of Object.entries(noteMembers as PSObj)) {
        if (force || !(k in obj)) obj[k] = v;
      }
      return passThru ? obj : null;
    }

    const memberType = psValueToString(ctx.named['membertype'] ?? 'NoteProperty').toLowerCase();
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const value = ctx.named['value'] ?? ctx.positional[1];
    if (!name) {
      ctx.emitError('Add-Member: -Name is required.');
      return null;
    }

    switch (memberType) {
      case 'noteproperty':
      case 'property':
        if (force || !(name in obj)) obj[name] = value ?? null;
        break;
      case 'scriptmethod':
        obj[name] = makeMethod(ctx, value, obj);
        break;
      case 'scriptproperty': {
        const getter = makeMethod(ctx, value, obj);
        Object.defineProperty(obj, name, {
          get: () => (getter as (...a: PSValue[]) => PSValue)(),
          configurable: true, enumerable: true,
        });
        break;
      }
      case 'aliasproperty': {
        const target = psValueToString(value ?? '');
        Object.defineProperty(obj, name, {
          get: () => obj[target] ?? null,
          configurable: true, enumerable: true,
        });
        break;
      }
      default:
        if (force || !(name in obj)) obj[name] = value ?? null;
    }
    return passThru ? obj : null;
  }
}

function makeMethod(ctx: CmdletContext, value: PSValue, self: PSObj): PSValue {
  const block = value as unknown as { type?: string; body?: unknown };
  if (block && block.type === 'ScriptBlock') {
    const env: PSEnvironment = ctx.env;
    return ((...args: PSValue[]) => {
      const child = ctx.runtime.makeChildScope(env);
      child.set('this', self as PSValue);
      return ctx.runtime.invokeScriptBlock(
        block as unknown as import('@/powershell/parser/PSASTNode').PSScriptBlock,
        {}, args, child, null,
      );
    }) as unknown as PSValue;
  }
  return value;
}
