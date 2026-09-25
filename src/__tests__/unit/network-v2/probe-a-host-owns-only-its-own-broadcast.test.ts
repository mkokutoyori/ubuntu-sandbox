/**
 * Un hote emet vers la diffusion de son sous-reseau, et ne prend pour une
 * diffusion que celle de SES prefixes.
 *
 * Mesure de depart, deux defauts d'un meme fait ecrit plusieurs fois dans
 * `EndHost` :
 * - a l'EMISSION, un datagramme UDP vers 10.0.0.255 (le sous-reseau de
 *   l'hote) demandait l'adresse MAC de 10.0.0.255 par ARP — personne ne
 *   repond, le datagramme ne partait jamais. `sendIpv4FrameArpAware`
 *   savait deja poser une diffusion sur ff:ff:ff:ff:ff:ff
 *   (`linkDestinationFor`), mais l'emission UDP, l'echo forge de
 *   `hping3 -1`, la reponse d'echo et l'erreur ICMP en recopiaient la
 *   fin sans sa premiere ligne. Ils y delegent desormais ;
 * - a la RECEPTION, `destinationIP.isBroadcastFor(mask)` jugeait sans la
 *   partie reseau : 192.168.7.255, pose sur la MAC d'un hote de
 *   10.0.0.0/24, montait jusqu'au service lie au port. La reception
 *   delegue a `isDirectedBroadcast` (`layers/internet/InternetLayer.ts`),
 *   partie reseau comprise, ni /31 ni /32.
 *
 * L'autorite est la RFC 1122 §3.3.6 : un hote reconnait la diffusion de
 * SON reseau et la diffusion limitee ; Linux route l'adresse de diffusion
 * d'un sous-reseau connecte en `broadcast`, donc vers la MAC de diffusion.
 *
 * Discrimination, mesuree en retirant le correctif : 2 des 3 cas tombent.
 * « WITNESS: a unicast datagram reaches the bound service » passe des deux
 * cotes ; il prouve que l'emission et l'ecouteur fonctionnent, donc que
 * les deux autres cas tombent pour la raison qu'ils nomment.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';

async function deliveredTo(destination: string): Promise<number> {
  const sender = new LinuxPC('A');
  const receiver = new LinuxPC('B');
  new Cable('link').connect(sender.getPorts()[0], receiver.getPorts()[0]);
  for (const [host, address] of [[sender, '10.0.0.10'], [receiver, '10.0.0.20']] as const) {
    await host.executeCommand(`sudo ip addr add ${address}/24 dev eth0`);
    await host.executeCommand('sudo ip link set eth0 up');
  }
  const receiverMac = receiver.getPorts()[0].getMAC().toString();
  await sender.executeCommand('sudo ip route add 192.168.7.0/24 dev eth0');
  await sender.executeCommand(`sudo ip neigh add 192.168.7.255 lladdr ${receiverMac} dev eth0`);
  let delivered = 0;
  receiver.udpBind(5000, () => { delivered++; }, 'probe');
  sender.sendUdpDatagram(new IPAddress(destination), 5000, 40000, 'hello', 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return delivered;
}

describe('a host sends to its subnet broadcast and owns only its own broadcasts', () => {
  it('WITNESS: a unicast datagram reaches the bound service', async () => {
    expect(await deliveredTo('10.0.0.20')).toBe(1);
  });

  it('a datagram to the broadcast of the shared subnet leaves on the broadcast MAC and is received', async () => {
    expect(await deliveredTo('10.0.0.255')).toBe(1);
  });

  it('the broadcast of another subnet, framed to its MAC, is not delivered', async () => {
    expect(await deliveredTo('192.168.7.255')).toBe(0);
  });
});
