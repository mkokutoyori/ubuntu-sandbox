import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

/**
 * This simulator has no `PSCredential`/`Get-Credential` object model, so
 * `-Credential` is accepted as a plain string: `"user:password"`, or bare
 * `"user"` (password defaults to the username — matching the seeded demo
 * accounts' "password equals username" convention; a real account with
 * an actual password must be spelled out as `"user:password"`).
 */
export function parseCredentialArg(raw: string): { username: string; password: string } {
  const idx = raw.indexOf(':');
  if (idx === -1) return { username: raw, password: raw };
  return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

export class EnablePSRemotingCmdlet implements ICmdlet {
  readonly name = 'enable-psremoting';
  readonly displayName = 'Enable-PSRemoting';
  readonly parameters = ['Force', 'SkipNetworkProfileCheck'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    if (!ctx.providers.remoting) {
      ctx.emitError('Enable-PSRemoting : WinRM cannot complete the operation in this context.');
      return null;
    }
    ctx.providers.remoting.enablePSRemoting();
    return null;
  }
}

export class TestWSManCmdlet implements ICmdlet {
  readonly name = 'test-wsman';
  readonly displayName = 'Test-WSMan';
  readonly parameters = ['ComputerName', 'Authentication'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const remoting = ctx.providers.remoting;
    if (!remoting) {
      ctx.emitError('Test-WSMan : WinRM cannot complete the operation.');
      return null;
    }
    const target = psValueToString(ctx.named['computername'] ?? ctx.positional[0] ?? '').trim();

    const identity = (): Record<string, PSValue> => ({
      wsmid:          'http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd',
      ProtocolVersion: 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd',
      ProductVendor:   'Microsoft Corporation',
      ProductVersion:  'OS: 0.0.0 SP: 0.0 Stack: 3.0',
    });

    if (!target) {
      if (!remoting.isLocalRemotingEnabled()) {
        ctx.emitError('Test-WSMan : WinRM cannot complete the operation. Verify that the service on the destination is running and is accepting requests.');
        return null;
      }
      return identity();
    }

    const remote = remoting.resolveComputer(target);
    if (!remote || !remote.isRemotingEnabled()) {
      ctx.emitError(
        `Test-WSMan : <f:WSManFault xmlns:f="http://schemas.microsoft.com/wbem/wsman/1/wsmanfault" Code="2150858770" Machine="${target}">` +
        `<f:Message>WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer is accessible over the network, ` +
        `and that a firewall exception for the WinRM service is enabled and allows access from this computer.</f:Message></f:WSManFault>`,
      );
      return null;
    }
    return identity();
  }
}

export class GetWSManCredSSPCmdlet implements ICmdlet {
  readonly name = 'get-wsmancredssp';
  readonly displayName = 'Get-WSManCredSSP';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const enabled = ctx.providers.remoting?.isLocalCredSSPEnabled() ?? false;
    if (enabled) {
      ctx.emit('The machine is configured to allow delegating fresh credentials to the following target(s): wsman/*');
    } else {
      ctx.emit('This computer is not configured to allow delegating fresh credentials.');
      ctx.emit('The machine is not configured to allow delegating fresh credentials to the target computer. Ensure the target computer name is in the Allowed list, and try the command again.');
    }
    return null;
  }
}
