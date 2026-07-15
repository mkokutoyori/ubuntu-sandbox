/**
 * Formatage partagé des sockets pour `netstat` et `ss` — utilitaires purs
 * (aucun état, aucune dépendance à l'exécuteur). Ni classe de commande, ni
 * façade : de simples fonctions d'affichage réutilisées par les rendus.
 */

export type ServiceResolver = (port: number, proto: string) => string | null;

/** Filtre d'état socket : `-l` = écoute seule, `-a` = tout, sinon tout sauf écoute. */
export function socketVisible(state: string, wantAll: boolean, wantListening: boolean): boolean {
  if (wantListening) return state === 'LISTEN';
  if (wantAll) return true;
  return state !== 'LISTEN';
}

/** Filtre de famille d'adresses (`-4`/`-6`) — les deux ou aucun ⇒ tout visible. */
export function familyVisible(addr: string, want4: boolean, want6: boolean): boolean {
  if (want4 === want6) return true;
  return addr.includes(':') ? want6 : want4;
}

/** Formate `adresse:port` en résolvant le nom de service sauf en mode numérique (`-n`). */
export function formatEndpoint(
  addr: string, port: number, proto: string,
  numeric: boolean, resolveService?: ServiceResolver, bracketV6 = false,
): string {
  const host = bracketV6 && addr.includes(':') ? `[${addr}]` : addr;
  if (!numeric && resolveService && port > 0) {
    const name = resolveService(port, proto);
    if (name) return `${host}:${name}`;
  }
  return `${host}:${port}`;
}
