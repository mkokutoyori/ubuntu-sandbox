export type DestinationKind = 'LOCATION' | 'SERVICE' | 'UNSET';
export type DestinationState = 'ENABLE' | 'DEFER' | 'ALTERNATE';

export interface ArchiveDestination {
  readonly destId: number;
  readonly kind: DestinationKind;
  /** Le repertoire pour LOCATION, l'identifiant TNS pour SERVICE. */
  readonly target: string;
  readonly raw: string;
  readonly transport: 'SYNC' | 'ASYNC';
  readonly affirm: boolean;
  readonly dbUniqueName: string | null;
  readonly binding: 'MANDATORY' | 'OPTIONAL';
  readonly validRole: 'PRIMARY_ROLE' | 'STANDBY_ROLE' | 'ALL_ROLES';
  readonly state: DestinationState;
}

function clause(raw: string, nom: string): string | null {
  const m = new RegExp(`\\b${nom}\\s*=\\s*([^,\\s)]+)`, 'i').exec(raw);
  return m ? m[1] : null;
}

export function parseArchiveDestination(
  destId: number, raw: string | undefined, state: string | undefined,
): ArchiveDestination {
  const texte = (raw ?? '').trim();
  const etat = (state ?? 'ENABLE').trim().toUpperCase();
  const declare: DestinationState =
    etat === 'DEFER' || etat === 'ALTERNATE' ? etat : 'ENABLE';
  if (texte.length === 0) {
    return {
      destId, kind: 'UNSET', target: '', raw: '', transport: 'ASYNC', affirm: false,
      dbUniqueName: null, binding: 'OPTIONAL', validRole: 'ALL_ROLES', state: declare,
    };
  }
  const emplacement = clause(texte, 'LOCATION');
  const service = clause(texte, 'SERVICE');
  const validFor = /VALID_FOR\s*=\s*\(([^)]*)\)/i.exec(texte)?.[1] ?? '';
  const role = /PRIMARY_ROLE/i.test(validFor) ? 'PRIMARY_ROLE'
    : /STANDBY_ROLE/i.test(validFor) ? 'STANDBY_ROLE'
      : 'ALL_ROLES';
  return {
    destId,
    kind: service ? 'SERVICE' : emplacement ? 'LOCATION' : 'LOCATION',
    target: service ?? emplacement ?? texte,
    raw: texte,
    transport: /\bSYNC\b/i.test(texte) && !/\bASYNC\b/i.test(texte) ? 'SYNC' : 'ASYNC',
    affirm: /\bAFFIRM\b/i.test(texte) && !/\bNOAFFIRM\b/i.test(texte),
    dbUniqueName: clause(texte, 'DB_UNIQUE_NAME')?.toUpperCase() ?? null,
    binding: /\bMANDATORY\b/i.test(texte) ? 'MANDATORY' : 'OPTIONAL',
    validRole: role,
    state: declare,
  };
}

export function readArchiveDestinations(
  params: ReadonlyMap<string, string>,
): ArchiveDestination[] {
  const out: ArchiveDestination[] = [];
  for (let i = 1; i <= 31; i++) {
    out.push(parseArchiveDestination(
      i, params.get(`log_archive_dest_${i}`), params.get(`log_archive_dest_state_${i}`)));
  }
  return out;
}
