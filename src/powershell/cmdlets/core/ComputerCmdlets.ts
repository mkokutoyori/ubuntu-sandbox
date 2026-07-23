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
