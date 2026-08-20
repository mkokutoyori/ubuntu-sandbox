export type PlageAnalyse =
  | { statut: 'ok'; premier: string; dernier: string | null }
  | { statut: 'refus'; token: string | null };

export function analyserPlagePorts(args: readonly string[]): PlageAnalyse {
  const mots = args.filter(a => a.length > 0);
  if (mots.length === 0) return { statut: 'refus', token: null };
  const at = mots.findIndex(m => m.toLowerCase() === 'to');
  if (at < 0) return { statut: 'ok', premier: mots.join(''), dernier: null };
  const premier = mots.slice(0, at).join('');
  const dernier = mots.slice(at + 1).join('');
  if (!premier) return { statut: 'refus', token: mots[0] };
  if (!dernier) return { statut: 'refus', token: null };
  return { statut: 'ok', premier, dernier };
}

export function etendrePlage(
  noms: readonly string[], premier: string, dernier: string | null,
): string[] | null {
  const debut = noms.indexOf(premier);
  if (debut < 0) return null;
  if (dernier === null) return [premier];
  const fin = noms.indexOf(dernier);
  if (fin < 0 || fin < debut) return null;
  return noms.slice(debut, fin + 1);
}

export function portGroupRunningConfigLines(
  groupes: readonly [string, string[]][],
): string[] {
  const out: string[] = [];
  for (const [nom, membres] of groupes) {
    out.push(`port-group ${nom}`);
    for (const m of membres) out.push(` group-member ${m}`);
    out.push('#');
  }
  return out;
}

export function renduDisplayPortGroup(
  groupes: readonly [string, string[]][], avecMembres: boolean,
): string {
  if (groupes.length === 0) return 'Info: No port-group is configured.';
  const out: string[] = [];
  for (const [nom, membres] of groupes) {
    out.push(`Port-group: ${nom}`);
    if (!avecMembres) continue;
    out.push(`  Member interfaces: ${membres.length}`);
    for (const m of membres) out.push(`    ${m}`);
  }
  return out.join('\n');
}
