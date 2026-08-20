import { decouperPlages, etendreEntre, type SegmentPlage } from '../cli/interfaceRange';

export type PlageAnalyse =
  | { statut: 'ok'; segments: SegmentPlage[] }
  | { statut: 'refus'; token: string | null };

export function analyserPlagePorts(args: readonly string[]): PlageAnalyse {
  const mots = args.filter(a => a.length > 0);
  if (mots.length === 0) return { statut: 'refus', token: null };
  const segments = decouperPlages(mots.join(' ').replace(/\s*,\s*/g, ','), 'to');
  if (!segments) return { statut: 'refus', token: null };
  return { statut: 'ok', segments };
}

export function etendrePlage(
  noms: readonly string[], premier: string, dernier: string | null,
): string[] | null {
  return etendreEntre(noms, premier, dernier);
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
