/**
 * Une vue MIB decide si un OID est LISIBLE, pas seulement affichable.
 *
 * La regle est celle de la RFC 3415 (VACM), verifiee sur l'implantation
 * de net-snmp (`snmplib/vacm.c`, `netsnmp_view_get`) plutot que de
 * memoire : parmi les entrees de la vue dont le sous-arbre PREFIXE
 * l'OID, on retient la plus LONGUE ; a longueur egale, la plus grande
 * dans l'ordre lexicographique. L'OID est dans la vue si cette entree
 * est `included`. Aucune entree ne prefixe l'OID : hors de la vue.
 *
 * Consequence qui n'est pas evidente et que la regle rend exacte : une
 * vue vide n'admet RIEN, et une exclusion posee plus profond que
 * l'inclusion l'emporte sur elle.
 */

export interface MibViewEntry {
  oid: string;
  type: 'included' | 'excluded';
}

function oidParts(oid: string): number[] {
  return oid.split('.').filter(Boolean).map(Number);
}

function prefixes(subtree: number[], target: number[]): boolean {
  if (subtree.length > target.length) return false;
  return subtree.every((n, i) => n === target[i]);
}

function lexGreater(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return a.length > b.length;
}

export function oidInMibView(oid: string, view: readonly MibViewEntry[]): boolean {
  const target = oidParts(oid);
  let best: { parts: number[]; type: 'included' | 'excluded' } | null = null;
  for (const entry of view) {
    const parts = oidParts(entry.oid);
    if (!prefixes(parts, target)) continue;
    if (best === null
      || parts.length > best.parts.length
      || (parts.length === best.parts.length && lexGreater(parts, best.parts))) {
      best = { parts, type: entry.type };
    }
  }
  return best !== null && best.type === 'included';
}
