/**
 * Un routeur qui parle UDP en CLIENT, et pas seulement en serveur d'un
 * protocole câblé en dur.
 *
 * Ce qui manquait : le répartiteur UDP de `Router.processIPv4` connaît
 * RIP, DHCP, IKE et IP SLA — chacun reconnu par une comparaison de port
 * écrite dans le corps de la méthode — et laisse tomber tout le reste.
 * Il n'existait donc aucune façon d'ouvrir un port depuis le plan de
 * contrôle, ce qui est exactement ce qu'il faut pour `copy … tftp:` :
 * un client TFTP choisit un port éphémère, l'écoute, et lit la réponse
 * du serveur qui arrive depuis le port éphémère de CELUI-CI (RFC 1350
 * §4 — le « Transfer ID »), donc depuis un port que personne ne peut
 * connaître à l'avance.
 *
 * Ce n'est délibérément PAS une `SocketTable` : celle d'`EndHost` sert
 * aussi `netstat`/`ss`, que le routeur ne possède pas, et un routeur
 * n'expose aucune vue de ses sockets. Ce module tient la seule chose
 * qui manquait — la table des ports ouverts — et rien de plus.
 */
import type { IPAddress } from '@/network/core/types';
import type { TftpEndpoint, TftpUdpDelivery } from '@/network/tftp/types';

/** L'émission d'un datagramme, laissée au routeur : c'est lui qui tient la FIB. */
export interface RouterUdpTransport {
  sendUdpBytes(
    destinationIP: IPAddress, destinationPort: number,
    sourcePort: number, payload: Uint8Array,
  ): boolean;
}

const EPHEMERAL_MIN = 49152;
const EPHEMERAL_MAX = 65535;

export class RouterUdpEndpoint implements TftpEndpoint {
  private readonly binds = new Map<number, (delivery: TftpUdpDelivery) => void>();

  constructor(private readonly transport: RouterUdpTransport) {}

  allocateEphemeralPort(): number {
    const range = EPHEMERAL_MAX - EPHEMERAL_MIN + 1;
    for (let attempt = 0; attempt < 256; attempt++) {
      const port = EPHEMERAL_MIN + Math.floor(Math.random() * range);
      if (!this.binds.has(port)) return port;
    }
    for (let port = EPHEMERAL_MIN; port <= EPHEMERAL_MAX; port++) {
      if (!this.binds.has(port)) return port;
    }
    throw new Error('EADDRINUSE: No ephemeral ports available');
  }

  udpBind(port: number, handler: (delivery: TftpUdpDelivery) => void): boolean {
    if (this.binds.has(port)) return false;
    this.binds.set(port, handler);
    return true;
  }

  udpClose(port: number): void {
    this.binds.delete(port);
  }

  sendUdpDatagramTo(
    destinationIP: IPAddress, destinationPort: number,
    sourcePort: number, payload: Uint8Array,
  ): boolean {
    return this.transport.sendUdpBytes(destinationIP, destinationPort, sourcePort, payload);
  }

  /**
   * Le datagramme reçu par le routeur. Rend `true` quand un port ouvert
   * l'a pris, pour que le répartiteur sache qu'il n'a plus à le laisser
   * tomber en silence.
   */
  deliver(sourceIP: IPAddress, destinationPort: number, sourcePort: number, payload: unknown): boolean {
    const handler = this.binds.get(destinationPort);
    if (!handler) return false;
    handler({ udp: { sourcePort, payload }, sourceIP });
    return true;
  }

  boundPorts(): number[] {
    return [...this.binds.keys()].sort((a, b) => a - b);
  }
}
