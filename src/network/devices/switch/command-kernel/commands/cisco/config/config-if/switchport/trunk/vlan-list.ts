/**
 * Parseur de listes VLAN au format Cisco : `10`, `10,20`, `10-20`,
 * `10,20-30,50`. Retourne `null` si la syntaxe est invalide. Bornes
 * validées (1..4094).
 *
 * Ce helper est PUR (aucune I/O, aucune dépendance shell) — extrait
 * pour être partagé entre les feuilles `switchport trunk allowed vlan
 * ...`. Conforme à la règle 2 : utilitaire pur, aucun formateur
 * legacy.
 */
export function parseVlanList(text: string): ReadonlySet<number> | null {
  const result = new Set<number>();
  const tokens = text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (tokens.length === 0) return null;
  for (const tok of tokens) {
    const rangeMatch = /^(\d+)-(\d+)$/.exec(tok);
    if (rangeMatch) {
      const lo = Number.parseInt(rangeMatch[1], 10);
      const hi = Number.parseInt(rangeMatch[2], 10);
      if (!inRange(lo) || !inRange(hi) || hi < lo) return null;
      for (let v = lo; v <= hi; v++) result.add(v);
      continue;
    }
    if (!/^\d+$/.test(tok)) return null;
    const v = Number.parseInt(tok, 10);
    if (!inRange(v)) return null;
    result.add(v);
  }
  return result;
}

function inRange(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && v <= 4094;
}
