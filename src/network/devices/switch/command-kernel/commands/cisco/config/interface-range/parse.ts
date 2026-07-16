/**
 * Parseur de plages d'interfaces Cisco :
 *   `FastEthernet0/1-4`         → [Fa0/1, Fa0/2, Fa0/3, Fa0/4]
 *   `Fa0/1-3, Fa0/10`           → [Fa0/1, Fa0/2, Fa0/3, Fa0/10]
 *   `GigabitEthernet0/1`        → [Gi0/1]  (mono-interface)
 *
 * Retourne `null` si la syntaxe est invalide (préfixe non-uniforme,
 * plage inversée, indices non-entiers). Ne fait AUCUNE vérification
 * d'existence des interfaces — c'est la responsabilité de la commande
 * appelante via la MachineApi.
 */
export function parseInterfaceRange(text: string): string[] | null {
  const result: string[] = [];
  const seen = new Set<string>();
  const tokens = text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (tokens.length === 0) return null;
  for (const tok of tokens) {
    // Sépare préfixe (`FastEthernet0/`) de la partie indices (`1-4`).
    const m = /^(.+?)(\d+)(?:-(\d+))?$/.exec(tok);
    if (!m) return null;
    const [, prefix, loStr, hiStr] = m;
    if (!prefix || !loStr) return null;
    const lo = Number.parseInt(loStr, 10);
    const hi = hiStr === undefined ? lo : Number.parseInt(hiStr, 10);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) return null;
    for (let i = lo; i <= hi; i++) {
      const name = `${prefix}${i}`;
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }
  return result;
}
