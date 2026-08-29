/**
 * Un RST EMIS porte le numero que le pair sait verifier (audit de la
 * pile TCP/IP, suite du lot 12).
 *
 * ── Comment ce defaut s'est montre ──────────────────────────────────
 *
 * Le lot 12 avait rendu le RECEVEUR conforme a la RFC 5961 : un RST
 * n'est cru que si sa sequence vaut exactement `RCV.NXT`. La
 * non-regression a alors fait tomber `scenario-3-rst-on-orphan`, et
 * c'est ce qui a nomme le defaut — il ne l'a pas cree. `sendRst`
 * ecrivait `sequence: 0` et `acknowledgement: seq + 1` avec les drapeaux
 * `RST|ACK`, pour TOUT segment qu'aucune socket n'apparie. Tant que le
 * receveur croyait n'importe quel RST, ce numero faux ne se voyait pas ;
 * des qu'il l'a verifie, le RST est devenu inaudible.
 *
 * C'est la forme que ce depot referme regulierement : une valeur
 * affichee que rien ne controle reste fausse jusqu'a ce que quelque
 * chose la controle.
 *
 * La consequence n'etait pas cosmetique. Un serveur dont le service
 * meurt sans FIN — le cas de tous les jours — repond un RST au premier
 * octet que le client lui envoie. Avec le mauvais numero, le client
 * garde sa session ETABLIE face a une machine qui n'a plus de socket :
 * le « limbo » que ce RST existe justement pour eviter.
 *
 * ── L'autorite, lue dans le noyau et non citee de memoire ───────────
 *
 * `tcp_v4_send_reset` (net/ipv4/tcp_ipv4.c) :
 *
 *     rep.th.rst = 1;
 *     if (th->ack) {
 *         rep.th.seq = th->ack_seq;
 *     } else {
 *         rep.th.ack = 1;
 *         rep.th.ack_seq = htonl(ntohl(th->seq) + th->syn + th->fin +
 *                                skb->len - (th->doff << 2));
 *     }
 *
 * DEUX branches, la ou ce depot n'en avait qu'une, et la RFC 9293
 * §3.10.7.1 dit la meme chose dans ses mots. Trois faits en decoulent
 * que l'ancienne ecriture manquait :
 *
 *   le segment porte un ACK -> la sequence du RST est cet ACK, et le
 *                              drapeau ACK du RST reste CLAIR ;
 *   il n'en porte pas       -> sequence 0, ACK pose, et l'accuse vaut
 *                              seq + syn + fin + LONGUEUR DES DONNEES.
 *
 * Le `+ 1` d'avant n'etait juste que pour un SYN nu — c'est-a-dire le
 * seul cas que ce depot eprouvait, le refus de connexion — et faux pour
 * tout segment portant des donnees.
 *
 * ── Corrige dans le meme geste ──────────────────────────────────────
 *
 * L'adresse SOURCE du RST etait celle que le ROUTAGE choisit, alors que
 * le noyau emet depuis `ip_hdr(skb)->daddr`, c'est-a-dire l'adresse a
 * laquelle le segment etait adresse. Les appelants la passaient deja et
 * elle etait JETEE (`void localIp;`) — la signature meme du parametre
 * declare et jamais lu. Sur une machine a une seule adresse les deux
 * coincident, ce qui est pourquoi personne ne l'avait vu ; sur une
 * machine multi-adressee le quadruplet du pair ne correspondrait pas et
 * le RST serait ignore pour une SECONDE raison.
 *
 * Et la regle « quelle est la longueur utile d'un segment ? » etait
 * ecrite DEUX fois dans le meme fichier ; `segmentPayloadSize` la porte
 * une fois et ses trois lecteurs la partagent.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Rendus a `sequence: 0, acknowledgement: seq + 1, RST|ACK`, 4 des 7 cas
 * tombent. Les 3 autres sont nommes ici plutot que laisses a decouvrir :
 * le refus sur port ferme et son numero, qui passent des deux cotes
 * parce que la branche SANS ACK etait deja juste pour un SYN nu — c'est
 * tout l'objet de ces TEMOINS —, et le RST hors fenetre toujours ignore,
 * qui garde qu'on a corrige l'EMETTEUR sans affaiblir le RECEVEUR.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask,
  createIPv4Packet, ETHERTYPE_IPV4, IP_PROTO_TCP,
} from '@/network/core/types';
import { computeTcpChecksum, type TcpSegment } from '@/network/tcp/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface RstVu { sequence: number; acknowledgement: number; ackFlag: boolean }

async function paire() {
  const client = new LinuxPC('A');
  const serveur = new LinuxServer('linux-server', 'B', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], serveur.getPorts()[0]);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  serveur.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await client.executeCommand('ping -c 1 10.0.0.2');
  return { client, serveur };
}

function rstVusSur(client: LinuxPC, sens: 'in' | 'out'): RstVu[] {
  const vus: RstVu[] = [];
  client.getPorts()[0].attachTap(({ direction, frame }) => {
    const pkt = frame.payload as { type?: string; protocol?: number; payload?: unknown } | undefined;
    if (direction !== sens || pkt?.type !== 'ipv4' || pkt.protocol !== IP_PROTO_TCP) return;
    const seg = pkt.payload as TcpSegment | undefined;
    if (!seg?.flags?.rst) return;
    vus.push({
      sequence: seg.sequence, acknowledgement: seg.acknowledgement, ackFlag: seg.flags.ack,
    });
  });
  return vus;
}

function injecter(
  client: LinuxPC, serveur: LinuxServer, seg: TcpSegment,
): void {
  seg.checksum = computeTcpChecksum(seg, '10.0.0.2', '10.0.0.1');
  client.getPorts()[0].receiveFrame({
    srcMAC: serveur.getPorts()[0].getMAC(), dstMAC: client.getPorts()[0].getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(
      new IPAddress('10.0.0.2'), new IPAddress('10.0.0.1'), IP_PROTO_TCP, 64, seg, 20),
  } as never);
}

function segment(champs: Partial<TcpSegment> & { destinationPort: number }): TcpSegment {
  return {
    type: 'tcp', sourcePort: 8080, sequence: 0, acknowledgement: 0, dataOffset: 5,
    flags: { fin: false, syn: false, rst: false, psh: false, ack: false, urg: false, ece: false, cwr: false },
    window: 1024, checksum: 0, urgentPointer: 0, options: [], payload: undefined,
    ...champs,
  } as unknown as TcpSegment;
}

/**
 * Le serveur perd sa socket sans emettre de FIN — ce que fait un service
 * tue net. Le client, lui, se croit toujours etabli.
 */
async function serveurOrphelin(port: number) {
  const { client, serveur } = await paire();
  serveur.getTcpStack().listen(port, { onAccept: () => undefined });
  const socket = client.getTcpStack().connect('10.0.0.2', port)!;
  await new Promise((r) => setTimeout(r, 30));
  expect(socket.state, 'la maquette doit d\'abord ETABLIR la session').toBe('established');

  serveur.getTcpStack().closeListener(port);
  (serveur.getTcpStack() as unknown as { sockets: Map<string, unknown> }).sockets.clear();
  return { client, serveur, socket };
}

describe('la branche AVEC ACK — un segment de session orpheline', () => {
  it('le RST porte la sequence que le segment ACCUSAIT', async () => {
    const { client, socket } = await serveurOrphelin(7000);
    const vus = rstVusSur(client, 'in');
    const attendue = socket.recvNext;

    socket.write('hello');
    await new Promise((r) => setTimeout(r, 30));

    expect(vus.length, 'le serveur doit repondre un RST').toBeGreaterThan(0);
    expect(vus[0].sequence).toBe(attendue);
  });

  it('le drapeau ACK du RST reste CLAIR', async () => {
    const { client, socket } = await serveurOrphelin(7001);
    const vus = rstVusSur(client, 'in');

    socket.write('hello');
    await new Promise((r) => setTimeout(r, 30));

    expect(vus.length).toBeGreaterThan(0);
    expect(vus[0].ackFlag).toBe(false);
  });

  it('et le client le CROIT, donc il ne reste pas en limbo', async () => {
    const { socket } = await serveurOrphelin(7002);

    socket.write('hello');
    await new Promise((r) => setTimeout(r, 30));

    expect(socket.state).not.toBe('established');
    expect(socket.closed).toBe(true);
  });
});

describe('la branche SANS ACK — un segment qu\'aucune socket n\'attend', () => {
  it('l\'accuse compte les DONNEES du segment, pas un `+ 1` fixe', async () => {
    const { client, serveur } = await paire();
    const vus = rstVusSur(client, 'out');

    injecter(client, serveur, segment({
      destinationPort: 9999, sourcePort: 5555, sequence: 4000, payload: 'douze-octets',
    }));
    await new Promise((r) => setTimeout(r, 30));

    expect(vus.length, 'un segment sans socket doit provoquer un RST').toBeGreaterThan(0);
    expect(vus[0].sequence).toBe(0);
    expect(vus[0].ackFlag).toBe(true);
    expect(vus[0].acknowledgement).toBe(4000 + 'douze-octets'.length);
  });

  it('TEMOIN : un SYN nu vers un port ferme accuse seq + 1', async () => {
    const { client, serveur } = await paire();
    const vus = rstVusSur(client, 'out');

    injecter(client, serveur, segment({
      destinationPort: 9998, sourcePort: 5556, sequence: 77,
      flags: { fin: false, syn: true, rst: false, psh: false, ack: false, urg: false, ece: false, cwr: false },
    }));
    await new Promise((r) => setTimeout(r, 30));

    expect(vus.length).toBeGreaterThan(0);
    expect(vus[0].sequence).toBe(0);
    expect(vus[0].ackFlag).toBe(true);
    expect(vus[0].acknowledgement).toBe(78);
  });

  it('TEMOIN : un port ferme refuse toujours la connexion', async () => {
    const { client } = await paire();
    expect(client.getTcpStack().connectOutcome('10.0.0.2', 9997)).toBe('refused');
  });
});

describe('le receveur n\'a PAS ete affaibli en chemin', () => {
  it('TEMOIN : un RST hors fenetre est toujours ignore', async () => {
    const { client, serveur } = await paire();
    serveur.getTcpStack().listen(8080, { onAccept: () => undefined });
    const socket = client.getTcpStack().connect('10.0.0.2', 8080)!;
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.state).toBe('established');

    injecter(client, serveur, segment({
      destinationPort: socket.localPort, sequence: (socket.recvNext + 99999) >>> 0,
      flags: { fin: false, syn: false, rst: true, psh: false, ack: false, urg: false, ece: false, cwr: false },
    }));
    await new Promise((r) => setTimeout(r, 30));

    expect(socket.state).toBe('established');
  });
});
