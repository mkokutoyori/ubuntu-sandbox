/**
 * `ctime(3)` — le format que Unix imprime partout où une date se lit à
 * l'œil nu : la ligne `From ` d'une boîte mbox, la colonne de `atq`, la
 * sortie de `date` sans format.
 *
 *     Mon Aug  3 04:00:00 2026
 *
 * Le quantième est cadré sur **deux colonnes avec une espace**, pas un
 * zéro : `Aug  3`, jamais `Aug 03`. C'est ce qui aligne les colonnes
 * d'`atq` d'un jour à l'autre, et c'est ce que le relevé sur le vrai
 * `atq` montre. Les deux endroits qui en avaient besoin l'écrivaient
 * chacun à leur façon, et aucun des deux ne correspondait.
 */

import { formatLocalTime } from '../system/SystemInfo';

export function formatCtime(d: Date, zone?: string): string {
  return formatLocalTime('%a %b %e %H:%M:%S %Y', d.getTime(), zone);
}
