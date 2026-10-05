/**
 * Une capture ecrite en arriere-plan montre, a la commande suivante, tout ce
 * qui a traverse la machine AVANT cette commande.
 *
 * Mesure de depart (9883a6d5b) : `tcpdump -w FICHIER &` suivi d'un trafic
 * produit de facon synchrone puis, tout de suite, de `tcpdump -r FICHIER`,
 * relisait un fichier VIDE (l'en-tete, aucun paquet) ; la meme lecture, un
 * instant plus tard, montrait les trois paquets de la poignee de main. Les
 * trames ne parvenaient a la capture que dans une micro-tache
 * (`orderedDelivery`, `queueMicrotask`), la ou la commande suivante, lancee
 * dans le meme tour, lisait deja le fichier. Une vraie machine ecrit le
 * paquet avant que l'utilisateur ait fini de taper la commande suivante ; il
 * n'y a pas d'instant ou la capture « n'a pas encore recu » ce qui est passe.
 *
 * Six cas deja presents dans le depot encodaient ce delai sans le savoir et
 * tombaient sur la base — `tcp-handshake-close-lifecycle` (quatre),
 * `oracle-rman-remote-target` et `oracle-net-plan-de-donnees` — aucun
 * n'etait faux : ils decrivaient ce que fait une machine.
 *
 * Correction : `settleOrderedDeliveries()` vide les livraisons en attente
 * (dans l'ordre des numeros de sequence, comme la micro-tache le faisait)
 * au debut de `LinuxMachine.executeCommand` ; l'ordre de livraison ne change
 * pas, seule la date a laquelle la commande suivante le voit.
 *
 * Discrimination (fichier copie sur 9883a6d5b) : UN cas sur deux tombe. Le
 * TEMOIN passe des deux cotes : apres un tour de boucle, la capture a bien
 * recu les trois paquets — sans lui, une capture qui ne verrait plus rien
 * passerait ce fichier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(() => {
  __setDefaultScheduler(new VirtualTimeScheduler());
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

afterEach(() => {
  __setDefaultScheduler(null);
});

async function capturedHandshake(pause: boolean): Promise<string> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  srv.getTcpStack().listen(8080, { onAccept: () => undefined });
  await pc.executeCommand('sudo tcpdump -nn port 8080 -w /tmp/handshake.pcap &');
  pc.getTcpStack().connect('10.0.0.10', 8080);
  if (pause) await new Promise((resolve) => setTimeout(resolve, 0));
  return pc.executeCommand('sudo tcpdump -r /tmp/handshake.pcap -nn');
}

const packetLines = (dump: string): string[] => dump.split('\n').filter((line) => line.includes('Flags ['));

describe('a background capture shows, at the next command, what crossed the machine before it', () => {
  it('the three packets of a handshake are read back at once', async () => {
    expect(packetLines(await capturedHandshake(false)).length).toBe(3);
  });

  it('WITNESS: after one turn of the event loop the capture holds the same three packets', async () => {
    expect(packetLines(await capturedHandshake(true)).length).toBe(3);
  });
});
