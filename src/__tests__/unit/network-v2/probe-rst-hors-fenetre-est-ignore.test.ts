/**
 * Un RST n'est cru que la ou il n'a pas pu etre DEVINE (audit de la pile
 * TCP/IP, lot 12).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `_processSegment` acceptait le drapeau RST INCONDITIONNELLEMENT :
 *
 *     if (seg.flags.rst) { … this._teardown(socket, 'rst'); return; }
 *
 * Aucun controle du numero de sequence. Mesure sur une connexion
 * ETABLIE : un RST porte a `recvNext + 99999` — tres au-dela de la
 * fenetre de reception — la fermait. C'est l'injection de RST en
 * aveugle : qui connait les deux adresses et les deux ports coupe la
 * connexion sans jamais avoir vu un octet du flux, alors que deviner un
 * numero de sequence dans la fenetre est justement ce qui doit lui
 * couter cher.
 *
 * ── L'autorite, lue et non citee de memoire ─────────────────────────
 *
 * `tcp_validate_incoming` (net/ipv4/tcp_input.c) applique la RFC 5961
 * §3.2, et son commentaire l'ecrit :
 *
 *     If seq num matches RCV.NXT or (RCV.NXT - 1) after a FIN, or
 *     the right-most SACK block,
 *     then
 *         RESET the connection
 *     else
 *         Send a challenge ACK
 *
 * precede de l'etape 1, qui jette AVANT cela tout segment hors fenetre —
 * et pour un RST sans meme accuser reception. Trois issues, donc, la ou
 * ce depot n'en avait qu'une :
 *
 *   hors fenetre            -> jete en silence
 *   dans la fenetre, != RCV.NXT -> challenge ACK, connexion INTACTE
 *   exactement RCV.NXT      -> la connexion tombe
 *
 * **SYN-SENT est un cas a part**, et l'oublier aurait casse le refus de
 * connexion : la RFC 9293 §3.10.7.3 y valide le RST par le champ ACK et
 * non par la sequence — le pair n'a encore rien envoye dont on connaisse
 * le numero. C'est pourquoi le TEMOIN du port ferme est dans ce fichier.
 *
 * ── Ce qui n'est deliberement PAS fait ──────────────────────────────
 *
 * Le noyau limite le DEBIT des challenge ACK
 * (`sysctl_tcp_challenge_ack_limit`), parce qu'ils sont eux-memes un
 * amplificateur ; ici rien ne mesure un debit, donc le limiteur n'aurait
 * rien a limiter. Les deux raffinements de `tcp_reset_check` — `RCV.NXT
 * - 1` apres un FIN, et le bord droit du dernier bloc SACK — ne sont pas
 * appliques non plus : ce sont des tolerances qui ELARGISSENT
 * l'acceptation, donc les omettre est le cote SUR de la regle.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * DEUX cas sur quatre tombent. Les deux autres sont des TEMOINS et
 * doivent passer des deux cotes : le RST EXACT, dont c'est l'objet de
 * continuer a fermer la connexion, et le refus sur port ferme, qui
 * passe par SYN-SENT — sans eux, une pile qui ignorerait TOUS les RST
 * passerait cette sonde.
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

async function paire() {
  const client = new LinuxPC('A');
  const serveur = new LinuxServer('linux-server', 'B', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], serveur.getPorts()[0]);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  serveur.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await client.executeCommand('ping -c 1 10.0.0.2');
  return { client, serveur };
}

function injecterRst(
  client: LinuxPC, serveur: LinuxServer, localPort: number, sequence: number,
): void {
  const seg = {
    type: 'tcp', sourcePort: 8080, destinationPort: localPort,
    sequence, acknowledgement: 0, dataOffset: 5,
    flags: { fin: false, syn: false, rst: true, psh: false, ack: false, urg: false },
    window: 0, checksum: 0, urgentPointer: 0, options: [], payload: undefined,
  } as unknown as TcpSegment;
  seg.checksum = computeTcpChecksum(seg, '10.0.0.2', '10.0.0.1');
  client.getPorts()[0].receiveFrame({
    srcMAC: serveur.getPorts()[0].getMAC(), dstMAC: client.getPorts()[0].getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(
      new IPAddress('10.0.0.2'), new IPAddress('10.0.0.1'), IP_PROTO_TCP, 64, seg, 20),
  } as never);
}

async function connexionEtablie() {
  const { client, serveur } = await paire();
  serveur.getTcpStack().listen(8080, { onAccept: () => undefined });
  const socket = client.getTcpStack().connect('10.0.0.2', 8080)!;
  await new Promise((r) => setTimeout(r, 30));
  expect(socket.state).toBe('established');
  return { client, serveur, socket };
}

describe('un RST hors fenetre est ignore', () => {
  it('un RST TRES au-dela de la fenetre ne ferme pas la connexion', async () => {
    const { client, serveur, socket } = await connexionEtablie();
    injecterRst(client, serveur, socket.localPort, (socket.recvNext + 99999) >>> 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.state).toBe('established');
    expect(socket.closed).toBe(false);
  });

  it('un RST DANS la fenetre mais decale ne ferme pas non plus', async () => {
    const { client, serveur, socket } = await connexionEtablie();
    injecterRst(client, serveur, socket.localPort, (socket.recvNext + 7) >>> 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.state).toBe('established');
  });

  it('TEMOIN : un RST EXACTEMENT a RCV.NXT ferme bien la connexion', async () => {
    const { client, serveur, socket } = await connexionEtablie();
    injecterRst(client, serveur, socket.localPort, socket.recvNext);
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.closed).toBe(true);
  });

  it('TEMOIN : un port ferme refuse toujours — le RST de SYN-SENT est juge sur l\'ACK', async () => {
    const { client } = await paire();
    const socket = client.getTcpStack().connect('10.0.0.2', 9999);
    await new Promise((r) => setTimeout(r, 30));
    expect(socket).not.toBeNull();
    expect(socket!.connectRefused).toBe(true);
  });
});
