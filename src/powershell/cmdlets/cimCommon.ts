import type { CmdletContext } from './CmdletContext';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

export function remoteCimRefusal(ctx: CmdletContext, cmdlet: string): string | null {
  const session = ctx.named['cimsession'];
  if (session === undefined) return null;
  const named = psValueToString(session);
  return `${cmdlet} : A CimSession to '${named}' cannot be opened: remote CIM is not `
    + 'available in this simulator. Run the command on that computer instead.';
}

export function notInSet(parameter: string, given: string, values: readonly string[]): string {
  return `Cannot validate argument on parameter '${parameter}'. The argument "${given}" does not belong to the set "${values.join(',')}" specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again.`;
}
