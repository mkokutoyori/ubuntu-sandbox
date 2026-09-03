import type { CmdletContext } from './CmdletContext';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

export type ConfirmImpact = 'None' | 'Low' | 'Medium' | 'High';

const IMPACT_RANK: Record<ConfirmImpact, number> = { None: 0, Low: 1, Medium: 2, High: 3 };

export const NON_INTERACTIVE_HOST =
  'Windows PowerShell is in NonInteractive mode. Read and Prompt functionality is not available.';

function rankOf(raw: string): number {
  const key = (Object.keys(IMPACT_RANK) as ConfirmImpact[])
    .find(k => k.toLowerCase() === raw.trim().toLowerCase());
  return key === undefined ? IMPACT_RANK.High : IMPACT_RANK[key];
}

export function confirmationDue(ctx: CmdletContext, impact: ConfirmImpact): boolean {
  const requested = ctx.named['confirm'];
  if (requested === false) return false;
  if (requested === true) return true;
  const preference = rankOf(psValueToString(ctx.env.get('ConfirmPreference') ?? 'High'));
  if (preference === IMPACT_RANK.None) return false;
  return IMPACT_RANK[impact] >= preference;
}
