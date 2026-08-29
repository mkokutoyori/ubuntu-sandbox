/**
 * Un protocole de controle qui TRAVERSE le routeur n'est pas pour lui.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Maquette A — R — B, et un paquet de A vers B portant un numero de
 * protocole que le routeur sert lui-meme. C'est un TRANSIT ordinaire :
 * l'adresse de destination est celle de B, pas celle du routeur.
 *
 *   protocole 47 (GRE)   -> recu par B : 0
 *   protocole 103 (PIM)  -> recu par B : 0
 *   protocole 2 (IGMP)   -> recu par B : 0
 *   protocole 1 (ICMP)   -> recu par B : 1   (TEMOIN)
 *
 * Le routeur les AVALAIT : ses agents locaux les prenaient quelle que
 * soit l'adresse visee. Le temoin ICMP est ce qui rend les trois zeros
 * lisibles — la maquette achemine bel et bien, donc c'est un avalement
 * et non un cablage absent.
 *
 * C'est le meme defaut que la phase 4 du BRD avait ferme pour l'UDP —
 * « un routeur cesse d'AVALER le trafic de transit » — et que les
 * protocoles portes DIRECTEMENT par IP avaient garde.
 *
 * ── La garde, et pourquoi elle n'est pas un deplacement ─────────────
 *
 * La couture du plan de controle est consultee juste APRES la liste
 * entrante et AVANT la decision d'acheminement. Cette place n'est pas
 * negociable et un cas de `probe-fhrp-passe-par-la-liste-entrante` dit
 * pourquoi : un rapport IGMP est adresse au GROUPE — 239.1.1.1 —, donc
 * du multicast ROUTABLE que `processIPv4` envoie a `forwardMulticast` et
 * non a la remise locale. La descendre apres la decision rendrait ce
 * rapport inatteignable.
 *
 * Ce qu'il fallait donc ecrire n'est pas un deplacement mais une GARDE :
 * la couture n'est consultee que si le paquet est adresse au routeur OU
 * n'est pas unicast. Cela couvre les groupes d'IGMP, de PIM et de VRRP
 * comme le point de terminaison d'un tunnel GRE — qui est une adresse du
 * routeur — et laisse filer le transit.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * La garde retiree, 3 des 6 cas tombent : les trois protocoles de
 * transit. Les 3 autres sont nommes ici — le TEMOIN ICMP, dont c'est
 * l'objet de passer des deux cotes, et les deux cas qui verifient que le
 * plan de controle LOCAL fonctionne toujours (l'abonnement IGMP a un
 * groupe, le voisin PIM), sans lesquels une garde trop large passerait
 * pour un correctif.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, createIPv4Packet, ETHERTYPE_IPV4,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** A — R — B, chaque poste sur son propre reseau, route par defaut posee. */
async function traversee() {
  const routeur = new CiscoRouter('R');
  const a = new LinuxPC('A');
  const b = new LinuxPC('B');
  new Cable('l1').connect(routeur.getPort('GigabitEthernet0/0')!, a.getPorts()[0]);
  new Cable('l2').connect(routeur.getPort('GigabitEthernet0/1')!, b.getPorts()[0]);
  for (const commande of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'end']) {
    await routeur.executeCommand(commande);
  }
  for (const [poste, n] of [[a, '1'], [b, '2']] as const) {
    await poste.executeCommand(`sudo ip addr add 10.0.${n}.10/24 dev eth0`);
    await poste.executeCommand('sudo ip link set eth0 up');
    await poste.executeCommand(`sudo ip route add default via 10.0.${n}.1`);
  }
  // Chauffe les caches ARP des deux cotes : sans cela le premier paquet
  // est mis en file et le cas mesurerait la resolution, pas le transit.
  await a.executeCommand('ping -c 1 10.0.2.10');
  return { routeur, a, b };
}

/** Combien de paquets du protocole demande B recoit-il vraiment ? */
async function transitDe(protocole: number): Promise<number> {
  const { routeur, a, b } = await traversee();
  let recus = 0;
  b.getPorts()[0].attachTap(({ direction, frame }) => {
    const pkt = frame.payload as { type?: string; protocol?: number } | undefined;
    if (direction === 'in' && pkt?.type === 'ipv4' && pkt.protocol === protocole) recus++;
  });

  routeur.getPort('GigabitEthernet0/0')!.receiveFrame({
    srcMAC: a.getPorts()[0].getMAC(),
    dstMAC: routeur.getPort('GigabitEthernet0/0')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(
      new IPAddress('10.0.1.10'), new IPAddress('10.0.2.10'),
      protocole, 64, { type: 'opaque' }, 20),
  } as never);
  await new Promise((r) => setTimeout(r, 20));
  return recus;
}

describe('le routeur n\'avale plus le plan de controle de TRANSIT', () => {
  it('un paquet GRE adresse a une autre machine la traverse', async () => {
    expect(await transitDe(47)).toBe(1);
  });

  it('un paquet PIM adresse a une autre machine aussi', async () => {
    expect(await transitDe(103)).toBe(1);
  });

  it('un paquet IGMP adresse a une autre machine aussi', async () => {
    expect(await transitDe(2)).toBe(1);
  });

  it('TEMOIN : l\'ICMP traversait deja, et traverse toujours', async () => {
    expect(await transitDe(1)).toBe(1);
  });
});

describe('et le plan de controle LOCAL fonctionne toujours', () => {
  it('un abonnement IGMP a un groupe ROUTABLE parvient au routeur', async () => {
    const horloge = new VirtualTimeScheduler();
    __setDefaultScheduler(horloge);
    const routeur = new CiscoRouter('R');
    const poste = new LinuxPC('P');
    new Cable('cm').connect(routeur.getPorts()[0], poste.getPorts()[0]);
    for (const commande of ['enable', 'configure terminal', 'ip multicast-routing',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
      'ip pim sparse-mode', 'ip igmp version 2', 'exit', 'end']) {
      await routeur.executeCommand(commande);
    }
    await poste.executeCommand('sudo ip addr add 10.0.0.10/24 dev eth0');
    await poste.executeCommand('sudo ip link set eth0 up');
    await poste.executeCommand('sudo ip route add default via 10.0.0.1');
    horloge.advance(5000);
    await poste.executeCommand('sudo ip maddr add 239.1.1.1 dev eth0');
    horloge.advance(5000);

    expect(await routeur.executeCommand('show ip igmp groups')).toContain('239.1.1.1');
  });

  it('un voisin PIM se forme toujours entre deux routeurs', async () => {
    const horloge = new VirtualTimeScheduler();
    __setDefaultScheduler(horloge);
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('cp').connect(r1.getPorts()[0], r2.getPorts()[0]);
    for (const [routeur, n] of [[r1, '1'], [r2, '2']] as const) {
      for (const commande of ['enable', 'configure terminal', 'ip multicast-routing',
        'interface GigabitEthernet0/0', `ip address 10.0.12.${n} 255.255.255.0`,
        'no shutdown', 'ip pim sparse-mode', 'exit', 'end']) {
        await routeur.executeCommand(commande);
      }
    }
    horloge.advance(120000);

    expect(await r1.executeCommand('show ip pim neighbor')).toContain('10.0.12.2');
  });
});
