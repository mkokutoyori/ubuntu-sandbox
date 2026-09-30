import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import type { ICapabilityProvider } from '@/powershell/providers/PSProviders';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';

function capabilities(ctx: CmdletContext, cmdletName: string): ICapabilityProvider {
  if (!ctx.providers.capabilities) throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  return ctx.providers.capabilities;
}

function wildcardMatcher(pattern: string): (name: string) => boolean {
  const expression = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return name => expression.test(name);
}

export class GetWindowsCapabilityCmdlet implements ICmdlet {
  readonly name = 'get-windowscapability';
  readonly aliases = [] as const;
  readonly parameters = ['Online', 'Name', 'LimitAccess'] as const;

  execute(ctx: CmdletContext): PSValue {
    const provider = capabilities(ctx, 'Get-WindowsCapability');
    if (ctx.named['online'] !== true) {
      ctx.emitError('Get-WindowsCapability : A parameter is missing: -Online is the only source supported (an offline image is not built).');
      return null;
    }
    const match = ctx.named['name'] !== undefined ? wildcardMatcher(psValueToString(ctx.named['name'])) : () => true;
    return provider.list().filter(c => match(c.name)).map(c => ({
      Name: c.name, State: c.state, DisplayName: c.displayName, Description: c.description,
    }));
  }
}

function change(ctx: CmdletContext, cmdletName: string, action: 'add' | 'remove'): PSValue {
  const provider = capabilities(ctx, cmdletName);
  if (ctx.named['online'] !== true) {
    ctx.emitError(`${cmdletName} : A parameter is missing: -Online is the only target supported (an offline image is not built).`);
    return null;
  }
  const name = psValueToString(ctx.named['name'] ?? '');
  if (!name) {
    ctx.emitError(`${cmdletName} : Cannot process command because of one or more missing mandatory parameters: Name.`);
    return null;
  }
  const result = action === 'add' ? provider.add(name) : provider.remove(name);
  if (!result.ok) {
    ctx.emitError(`${cmdletName} : ${result.message}`);
    return null;
  }
  return { Online: true, RestartNeeded: false, Path: null };
}

export class AddWindowsCapabilityCmdlet implements ICmdlet {
  readonly name = 'add-windowscapability';
  readonly aliases = [] as const;
  readonly parameters = ['Online', 'Name', 'LimitAccess'] as const;
  execute(ctx: CmdletContext): PSValue { return change(ctx, 'Add-WindowsCapability', 'add'); }
}

export class RemoveWindowsCapabilityCmdlet implements ICmdlet {
  readonly name = 'remove-windowscapability';
  readonly aliases = [] as const;
  readonly parameters = ['Online', 'Name'] as const;
  execute(ctx: CmdletContext): PSValue { return change(ctx, 'Remove-WindowsCapability', 'remove'); }
}
