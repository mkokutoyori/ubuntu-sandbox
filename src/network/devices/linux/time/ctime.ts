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

const JOURS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const deux = (n: number): string => String(n).padStart(2, '0');

export function formatCtime(d: Date): string {
  const jour = String(d.getDate()).padStart(2, ' ');
  const heure = `${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())}`;
  return `${JOURS[d.getDay()]} ${MOIS[d.getMonth()]} ${jour} ${heure} ${d.getFullYear()}`;
}
