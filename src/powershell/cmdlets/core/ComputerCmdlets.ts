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
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

export class AddComputerCmdlet implements ICmdlet {
  readonly name = 'add-computer';
  readonly aliases = [] as const;
  readonly parameters = ['DomainName', 'Credential', 'Server', 'OUPath', 'NewName', 'Restart', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const computer = ctx.providers.computer;
    if (!computer) {
      ctx.emitError(`Add-Computer : ${commandNotFoundMessage('Add-Computer')}`);
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

/** `Remove-Computer -UnjoinDomainCredential <cred>` (docs/PRD-Netdom.md §2.1 P4) — same underlying primitive as `netdom remove` (`IComputerProvider.remove()`), a real LDAP `DelRequest` against the DC. */
export class RemoveComputerCmdlet implements ICmdlet {
  readonly name = 'remove-computer';
  readonly displayName = 'Remove-Computer';
  readonly aliases = [] as const;
  readonly parameters = ['UnjoinDomainCredential', 'WorkgroupName', 'Restart', 'Force', 'PassThru'] as const;

  execute(ctx: CmdletContext): PSValue {
    const computer = ctx.providers.computer;
    if (!computer) {
      ctx.emitError(`Remove-Computer : ${commandNotFoundMessage('Remove-Computer')}`);
      return null;
    }
    if (!computer.getDomainInfo()) {
      ctx.emitError('Remove-Computer : Computer failed to be un-joined from the domain: This computer is not currently joined to a domain.');
      return null;
    }
    const credentialRaw = ctx.named['unjoindomaincredential'] !== undefined ? psValueToString(ctx.named['unjoindomaincredential']) : '';
    if (!credentialRaw) {
      ctx.emitError('Remove-Computer : Cannot process command because of one or more missing mandatory parameters: UnjoinDomainCredential.');
      return null;
    }
    const credential = parseCredentialArg(credentialRaw);
    const res = computer.remove(credential);
    if (!res.ok) { ctx.emitError(`Remove-Computer : ${res.message}`); return null; }
    return null;
  }
}

/** `Rename-Computer -NewName <Name> [-DomainCredential <cred>]` (docs/PRD-Netdom.md §2.1 P5) — same underlying primitive as `netdom renamecomputer` (`IComputerProvider.rename()`): renames locally and, if domain-joined, the AD computer object too. */
export class RenameComputerCmdlet implements ICmdlet {
  readonly name = 'rename-computer';
  readonly displayName = 'Rename-Computer';
  readonly aliases = [] as const;
  readonly parameters = ['NewName', 'DomainCredential', 'LocalCredential', 'Restart', 'Force', 'PassThru'] as const;

  execute(ctx: CmdletContext): PSValue {
    const computer = ctx.providers.computer;
    if (!computer) {
      ctx.emitError(`Rename-Computer : ${commandNotFoundMessage('Rename-Computer')}`);
      return null;
    }
    const newName = psValueToString(ctx.named['newname'] ?? ctx.positional[0] ?? '');
    if (!newName) {
      ctx.emitError('Rename-Computer : Cannot process command because of one or more missing mandatory parameters: NewName.');
      return null;
    }
    const credentialRaw = ctx.named['domaincredential'] !== undefined ? psValueToString(ctx.named['domaincredential']) : '';
    const credential = credentialRaw ? parseCredentialArg(credentialRaw) : undefined;
    if (computer.getDomainInfo() && !credential) {
      ctx.emitError('Rename-Computer : Cannot process command because of one or more missing mandatory parameters: DomainCredential.');
      return null;
    }
    const res = computer.rename(newName, credential);
    if (!res.ok) { ctx.emitError(`Rename-Computer : ${res.message}`); return null; }
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
      ctx.emitError(`Install-ADServiceAccount : ${commandNotFoundMessage('Install-ADServiceAccount')}`);
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
      ctx.emitError(`Test-ADServiceAccount : ${commandNotFoundMessage('Test-ADServiceAccount')}`);
      return null;
    }
    const identity = serviceAccountIdentityOf(ctx);
    if (!identity) { ctx.emitError('Test-ADServiceAccount : Cannot process command because of one or more missing mandatory parameters: Identity.'); return null; }
    return computer.testServiceAccount(identity);
  }
}
