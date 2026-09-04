import type { CmdletContext } from './CmdletContext';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

export function remoteCimRefusal(ctx: CmdletContext, cmdlet: string): string | null {
  const session = ctx.named['cimsession'];
  if (session === undefined) return null;
  const named = psValueToString(session);
  return `${cmdlet} : A CimSession to '${named}' cannot be opened: remote CIM is not `
    + 'available in this simulator. Run the command on that computer instead.';
}
