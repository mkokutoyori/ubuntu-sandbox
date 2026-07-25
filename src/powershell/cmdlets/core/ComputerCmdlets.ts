/**
 * ComputerCmdlets — `Add-Computer` (PRD-Windows-Server.md §5 P6): real
 * domain-join dialogue over the network (`ctx.providers.computer`),
 * available on every Windows host — unlike the AD DS cmdlets, joining a
 * domain isn't gated by a role.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { parseCredentialArg } from './RemotingCmdlets';

export class AddComputerCmdlet implements ICmdlet {
  readonly name = 'add-computer';
  readonly aliases = [] as const;
  readonly parameters = ['DomainName', 'Credential', 'Server', 'OUPath', 'NewName', 'Restart', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const computer = ctx.providers.computer;
    if (!computer) {
      ctx.emitError('Add-Computer : The term \'Add-Computer\' is not recognized as the name of a cmdlet, function, script file, or operable program.');
      return null;
    }
    const domainName = psValueToString(ctx.named['domainname'] ?? ctx.positional[0] ?? '');
    if (!domainName) {
      ctx.emitError('Add-Computer : Cannot process command because of one or more missing mandatory parameters: DomainName.');
      return null;
    }
    const credentialRaw = ctx.named['credential'] !== undefined ? psValueToString(ctx.named['credential']) : '';
    if (!credentialRaw) {
      ctx.emitError('Add-Computer : Cannot process command because of one or more missing mandatory parameters: Credential.');
      return null;
    }
    const credential = parseCredentialArg(credentialRaw);
    const server = ctx.named['server'] !== undefined ? psValueToString(ctx.named['server']) : undefined;
    const ouPath = ctx.named['oupath'] !== undefined ? psValueToString(ctx.named['oupath']) : undefined;
    const newName = ctx.named['newname'] !== undefined ? psValueToString(ctx.named['newname']) : undefined;

    const res = computer.join(domainName, credential, server, { ouPath, newName });
    if (!res.ok) { ctx.emitError(`Add-Computer : ${res.message}`); return null; }
    return null;
  }
}

export class TestComputerSecureChannelCmdlet implements ICmdlet {
  readonly name = 'test-computersecurechannel';
  readonly displayName = 'Test-ComputerSecureChannel';
  readonly aliases = [] as const;
  readonly parameters = ['Repair', 'Credential'] as const;

  execute(ctx: CmdletContext): PSValue {
    const computer = ctx.providers.computer;
    if (!computer || !computer.getDomainInfo()) {
      ctx.emitError('Test-ComputerSecureChannel : The computer is not currently joined to a domain, so this operation cannot be performed.');
      return null;
    }
    return computer.testSecureChannel();
  }
}

function serviceAccountIdentityOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['identity'] ?? ctx.positional[0] ?? '');
}

/** `Install-ADServiceAccount -Identity <gMSA|sMSA>` — a real LDAP round trip to the DC verifying this machine is authorized, then caching the account locally (PRD Managed Service Accounts). */
export class InstallADServiceAccountCmdlet implements ICmdlet {
  readonly name = 'install-adserviceaccount';
  readonly displayName = 'Install-ADServiceAccount';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const computer = ctx.providers.computer;
    if (!computer) {
      ctx.emitError('Install-ADServiceAccount : The term \'Install-ADServiceAccount\' is not recognized as the name of a cmdlet, function, script file, or operable program.');
      return null;
    }
    const identity = serviceAccountIdentityOf(ctx);
    if (!identity) { ctx.emitError('Install-ADServiceAccount : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    const res = computer.installServiceAccount(identity);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

/** `Test-ADServiceAccount -Identity <gMSA|sMSA>` — true only if `Install-ADServiceAccount` already succeeded on this machine. */
export class TestADServiceAccountCmdlet implements ICmdlet {
  readonly name = 'test-adserviceaccount';
  readonly displayName = 'Test-ADServiceAccount';
  readonly aliases = [] as const;
  readonly parameters = ['Identity'] as const;

  execute(ctx: CmdletContext): PSValue {
    const computer = ctx.providers.computer;
    if (!computer) {
      ctx.emitError('Test-ADServiceAccount : The term \'Test-ADServiceAccount\' is not recognized as the name of a cmdlet, function, script file, or operable program.');
      return null;
    }
    const identity = serviceAccountIdentityOf(ctx);
    if (!identity) { ctx.emitError('Test-ADServiceAccount : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    return computer.testServiceAccount(identity);
  }
}
