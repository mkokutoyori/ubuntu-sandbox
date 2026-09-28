/*
 * `ping` attendait la reponse d'un echo AVANT de compter son intervalle :
 * un echo perdu coutait une seconde et demie au lieu d'une.
 *
 * Mesure de depart, sur la topologie de l'utilisateur rechargee
 * (`lan_with_firewall_fortigate.topology (1).json`) : PC1 ping
 * 192.168.30.4, que FW1 jette faute de route,
 *
 *   4 packets transmitted, 0 received, 100% packet loss, time 4507ms
 *   2 packets transmitted, 0 received, 100% packet loss, time 1503ms
 *
 * L'AUTORITE EST IPUTILS (`ping/ping_common.c`, `pinger`, et
 * `ping/ping_output.c`, lus sur iputils/iputils) : un echo part toutes
 * les `interval` millisecondes, qu'une reponse soit arrivee ou non, et
 * la ligne de statistiques porte `time` = instant du DERNIER envoi moins
 * instant de depart (`rts->cur_time - rts->start_time`). Quatre echos a
 * une seconde d'intervalle donnent donc `time 3000ms`, perdus ou non.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire la boucle.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 3 des 4 cas tombent. Le TEMOIN, quatre echos rendus, passe des deux
 * cotes : sur l'horloge virtuelle une reponse arrive sans delai, et
 * l'ancienne boucle ne se decalait que sur une attente.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

afterEach(() => { __setDefaultScheduler(null); });

async function pingThrough(command: string): Promise<string> {
  const scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const sink = new LinuxPC('linux-pc', 'SINK', 0, 0);
  new Cable('c1').connect(pc1.getPorts()[0], sink.getPorts()[0]);
  await sink.executeCommand('sudo ip addr add 192.168.1.99/24 dev eth0');
  await pc1.executeCommand('sudo ip addr add 192.168.1.3/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.99');
  return scheduler.advanceUntilSettled(Promise.resolve(pc1.executeCommand(command)));
}

describe('an echo leaves every second, answered or not', () => {
  it('four lost echoes: `time 3000ms`', async () => {
    const out = await pingThrough('ping -c 4 192.168.30.4');

    expect(out).toMatch(/^4 packets transmitted, 0 received, 100% packet loss, time 3000ms$/m);
  }, 30000);

  it('two lost echoes: `time 1000ms`', async () => {
    const out = await pingThrough('ping -c 2 192.168.30.4');

    expect(out).toMatch(/^2 packets transmitted, 0 received, 100% packet loss, time 1000ms$/m);
  }, 30000);

  it('`-i 2`: three lost echoes, `time 4000ms`', async () => {
    const out = await pingThrough('ping -c 3 -i 2 192.168.30.4');

    expect(out).toMatch(/^3 packets transmitted, 0 received, 100% packet loss, time 4000ms$/m);
  }, 30000);

  it('four answered echoes: `time 3000ms` — WITNESS', async () => {
    const out = await pingThrough('ping -c 4 192.168.1.99');

    expect(out).toMatch(/^4 packets transmitted, 4 received, 0% packet loss, time 3000ms$/m);
  }, 30000);
});
