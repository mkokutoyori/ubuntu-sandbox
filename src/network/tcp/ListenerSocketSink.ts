/**
 * docs/PRD-Sockets-Une-Seule-Verite.md §P1 — le port étroit par lequel
 * une écoute TCP s'annonce.
 *
 * `TcpStack` décide qui répond ; `SocketTable` décide ce que `ss`,
 * `netstat`, `lsof`, `/proc/net/tcp` et `nmap` montrent. Les deux
 * existaient sans lien, si bien qu'un port pouvait répondre sans être
 * affiché — et l'inverse. Ce sink est le lien, et il est branché depuis
 * l'INTÉRIEUR de `TcpStack` : une écoute ne peut pas oublier de
 * s'annoncer puisqu'il n'y a rien à annoncer, même modèle que
 * `ServiceRegistrySink` pour le registre Windows.
 *
 * Ce que la `SocketTable` sait en plus — pid, nom de processus,
 * bannière — voyage donc avec l'écoute plutôt que d'être réinscrit à
 * côté par un appelant qui pourrait l'oublier.
 */

export interface ListenerIdentity {
  /** PID du processus propriétaire, lu par `ss -p` et `lsof`. */
  pid?: number;
  /** Nom du processus, lu par `ss -p`, `netstat -p` et `lsof`. */
  processName?: string;
  /** Premiers octets écrits sur une connexion fraîche, lus par `nc`/`nmap`. */
  banner?: string;
}

export interface ListenerSocketSink {
  announce(localIp: string, localPort: number, identity: ListenerIdentity): void;
  withdraw(localIp: string, localPort: number): void;
}
