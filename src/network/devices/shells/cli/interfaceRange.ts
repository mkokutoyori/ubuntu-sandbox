export interface SegmentPlage {
  readonly premier: string;
  readonly dernier: string | null;
}

export function decouperPlages(brut: string, separateur: '-' | 'to'): SegmentPlage[] | null {
  const segments = brut.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (segments.length === 0) return null;
  const out: SegmentPlage[] = [];
  for (const segment of segments) {
    const parties = separateur === '-'
      ? segment.split('-').map(s => s.trim())
      : segment.split(/\s+to\s+/i).map(s => s.trim());
    if (parties.length === 1) {
      if (!parties[0]) return null;
      out.push({ premier: parties[0], dernier: null });
      continue;
    }
    if (parties.length !== 2 || !parties[0] || !parties[1]) return null;
    out.push({ premier: parties[0], dernier: parties[1] });
  }
  return out;
}

export function completerBorne(premier: string, dernier: string): string {
  if (/[a-zA-Z]/.test(dernier)) return dernier;
  const tete = premier.match(/^(.*?)(\d+)$/);
  if (!tete) return dernier;
  return `${tete[1]}${dernier}`;
}

export function etendreEntre(
  noms: readonly string[], premier: string, dernier: string | null,
): string[] | null {
  const debut = noms.indexOf(premier);
  if (debut < 0) return null;
  if (dernier === null) return [premier];
  const fin = noms.indexOf(dernier);
  if (fin < 0 || fin < debut) return null;
  return noms.slice(debut, fin + 1);
}
