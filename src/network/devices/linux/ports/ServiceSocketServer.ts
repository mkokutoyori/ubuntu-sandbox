import type { PortSpec } from '../../../core/ports/PortNumber';

/**
 * Le serveur réel derrière un port de service (docs/PRD-Nginx.md §P0).
 *
 * `SERVICE_LISTENERS` déclare les ports qu'un démon ouvre, et
 * `ServicePortProjection` les inscrivait dans la `SocketTable` — la table
 * que lisent `ss` et `netstat` — sans jamais appeler `TcpStack.listen()`,
 * qui est la seule chose qui décide d'accepter une connexion. La machine
 * affirmait donc deux choses incompatibles : `ss` montrait `0.0.0.0:80`
 * et une connexion sur ce port était refusée.
 *
 * Ce port étroit est la réponse : un service n'apparaît dans `ss` que
 * s'il a fourni un serveur, et ce serveur a ouvert son écoute pour de
 * bon. La cohérence vaut dans les deux sens — un port affiché doit être
 * joignable, un port injoignable ne doit pas être affiché.
 *
 * Les démons qui inscrivent leur socket eux-mêmes (sshd, systemd-resolved,
 * dnsmasq) ne passent pas par ici : ils écoutent déjà vraiment.
 */
export interface ServiceSocketServer {
  /** Ouvre l'écoute réelle. `false` = rien n'écoute, donc rien à afficher. */
  open(spec: PortSpec): boolean;
  close(spec: PortSpec): void;
}
