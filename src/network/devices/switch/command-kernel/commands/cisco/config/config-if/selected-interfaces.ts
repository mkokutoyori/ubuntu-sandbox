import type { CliSession } from '@/command-kernel/cli';
import type { Session } from '@/command-kernel/session/types';

/**
 * Retourne la liste des interfaces à mettre à jour par une commande
 * config-if. Sémantique :
 *  - `interface range` a positionné `selectedInterfaces` (CSV) → liste
 *    complète.
 *  - `interface X` a positionné `selectedInterface` (unique) →
 *    singleton.
 *  - aucun push valide → tableau vide (les commandes doivent écrire
 *    le message vendeur `% No interface selected.`).
 *
 * Ce helper est PUR — aucune I/O, aucun état interne — extrait pour
 * que TOUTES les commandes config-if aient une politique cohérente
 * (règle 2 : commande standalone, mais helper pur autorisé).
 *
 * Accepte `Session` pour éviter au callsite de caster ; les commandes
 * config-if reçoivent toujours une `CliSession` en réalité (mode CLI
 * vendeur), le cast est simplement isolé ici.
 */
export function broadcastInterfaces(session: Session): string[] {
  const fields = (session as CliSession).promptFields;
  if (!fields) return [];
  const list = fields.get('selectedInterfaces');
  if (list) return list.split(',').filter((s) => s.length > 0);
  const one = fields.get('selectedInterface');
  return one ? [one] : [];
}
