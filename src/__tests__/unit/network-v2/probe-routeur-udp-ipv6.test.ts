/**
 * Un routeur emet ET recoit de l'UDP en IPv6 (BRD-Modele-TCP-IP.md
 * phase 8, lot 9).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Les DEUX moities manquaient. A l'EMISSION, `Router.sendUdpDatagram` est
 * ecrit sur l'offre IPv4 et n'avait aucun pendant v6 : un routeur ne
 * pouvait adresser AUCUN datagramme UDP a une destination IPv6. A la
 * RECEPTION, `IPv6DataPlane.handleLocalDelivery` aiguillait OSPFv3,
 * ICMPv6, et sous UDP le SEUL port 547 (DHCPv6) — tout le reste etait
 * jete EN SILENCE, sans meme l'erreur que la RFC 4443 demande.
 *
 * C'est le jumeau UDP du lot 4, qui avait fait la moitie TCP du meme
 * chantier sur le meme objet.
 *
 * ── Reutilisation, plutot qu'une seconde pile ───────────────────────
 *
 * Rien de neuf n'est ecrit : `resolvePath` (la recherche de route du plan
 * d'acheminement), `selectIpv6SourceAddress` (la regle de la RFC 6724
 * §2 descendue dans la couche au lot 4) et `sendFrameNdpAware` (l'envoi
 * qui MET EN FILE sur cache froid au lieu de lire le cache et d'esperer)
 * existaient tous les trois. Le port ferme repond par
 * `sendICMPv6Error(... 'destination-unreachable', 4)`, l'emetteur que le
 * plan d'acheminement emploie deja, et non par un second.
 *
 * La somme de controle UDP est POSEE a l'emission et VERIFIEE a la
 * reception : en IPv6 elle est OBLIGATOIRE (RFC 8200 §8.1, « unlike IPv4,
 * when UDP packets are originated by an IPv6 node, the UDP checksum is
 * not optional »), la ou la RFC 768 laisse le choix en IPv4.
 *
 * ── Ce qui reste v4 seulement, mesure et ecrit plutot que tu ────────
 *
 * Les agents que `receiveControlPlaneUdp` sert — HSRP, NTP, GLBP, BFD,
 * les cinq RADIUS, SNMP, VXLAN — prennent tous un `IPAddress` et restent
 * donc en IPv4. Les elargir est une campagne par agent, pas la suite de
 * ce lot ; ce qui est livre ici est le SOCLE que cette campagne emprunte,
 * et il a un appelant reel — la table de ports du plan de controle, celle
 * ou TFTP et le client DNS se lient — et non zero, ce qui en ferait un
 * moteur sans porte.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * TROIS cas sur quatre tombent. Le quatrieme est le TEMOIN IPv4 monte
 * dans le MEME laboratoire, et il passe des deux cotes comme il le doit :
 * sans lui, un laboratoire mal cable et une fonction absente seraient
 * indiscernables.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, IPv6Address } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function maquette() {
  const routeur = new CiscoRouter('R');
  const poste = new LinuxPC('PC');
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/0')!, poste.getPort('eth0')!);
  for (const c of ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
    'ipv6 address 2001:DB8::1/64', 'no shutdown', 'end']) {
    await routeur.executeCommand(c);
  }
  await poste.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await poste.executeCommand('sudo ip -6 addr add 2001:DB8::2/64 dev eth0');
  await poste.executeCommand('sudo ip link set eth0 up');
  return { routeur, poste };
}

describe('un routeur fait de l\'UDP en IPv6', () => {
  it('un datagramme emis par le routeur TRAVERSE LE FIL', async () => {
    const { routeur, poste } = await maquette();
    const vus: string[] = [];
    poste.getPort('eth0')!.attachTap(({ direction, frame }) => {
      const pkt = frame.payload as { type?: string; nextHeader?: number;
        sourceIP?: { toString(): string }; destinationIP?: { toString(): string } } | undefined;
      if (direction === 'in' && pkt?.type === 'ipv6' && pkt.nextHeader === 17) {
        vus.push(`${pkt.sourceIP}->${pkt.destinationIP}`);
      }
    });

    expect(routeur.sendUdpDatagram6(new IPv6Address('2001:DB8::2'), 9999, 4000, 'salut', 5)).toBe(true);
    expect(vus).toEqual(['2001:db8::1->2001:db8::2']);
  });

  it('un datagramme recu sur un port LIE est remis a son proprietaire', async () => {
    const { routeur, poste } = await maquette();
    const recu: string[] = [];
    routeur.getUdpEndpoint().udpBind(4444, (d) => { recu.push(String(d.udp.payload)); }, 'sonde');

    expect(poste.sendUdpDatagram6(new IPv6Address('2001:DB8::1'), 4444, 5000, 'bonjour', 7)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(recu).toEqual(['bonjour']);
  });

  it('un port que personne n\'ecoute repond ICMPv6, il ne se tait pas', async () => {
    const { routeur, poste } = await maquette();
    const icmp: string[] = [];
    poste.getPort('eth0')!.attachTap(({ direction, frame }) => {
      const pkt = frame.payload as { type?: string; nextHeader?: number; payload?: unknown } | undefined;
      if (direction === 'in' && pkt?.type === 'ipv6' && pkt.nextHeader === 58) {
        icmp.push(String((pkt.payload as { icmpType?: string } | undefined)?.icmpType));
      }
    });

    poste.sendUdpDatagram6(new IPv6Address('2001:DB8::1'), 4445, 5001, 'x', 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(icmp).toContain('destination-unreachable');
  });

  it('TEMOIN : la meme maquette fait deja de l\'UDP en IPv4', async () => {
    const { routeur, poste } = await maquette();
    const recu: string[] = [];
    routeur.getUdpEndpoint().udpBind(4446, (d) => { recu.push(String(d.udp.payload)); }, 'sonde4');

    expect(poste.sendUdpDatagram(new IPAddress('10.0.0.1'), 4446, 5002, 'quatre', 6)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(recu).toEqual(['quatre']);
  });
});
