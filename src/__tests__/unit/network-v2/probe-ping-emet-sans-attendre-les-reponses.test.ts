/**
 * Mesure : `ping -c 20 -i 0.01 -W 2` vers un hote qui jette les echos.
 *
 * ping attendait le delai d'expiration (-W) de chaque echo avant d'emettre le
 * suivant : 20 echos perdus coutaient 20 x 2 s = 40 s d'horloge simulee, et
 * 254 s dans Chromium pour `ping -c 500 -i 0.002`. iputils (ping_common.c,
 * pinger / receive_error_msg) emet toutes les `interval` ms sans attendre,
 * recoit les reponses a part et n'attend le delai qu'apres le dernier envoi :
 * 19 x 10 ms + 2 s = ~2,2 s.
 *
 * Discriminee avec `git stash push -- src/network` : 2 cas sur 5 tombent
 * (duree de 20 echos perdus, duree sous -w). Passent des deux cotes, par
 * non-regression : -O (l'ancienne boucle signalait l'echo perdu apres coup),
 * le temoin (hote qui repond, memes options) et le decompte des transmis.
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

async function pingSilentHost(command: string, silent: boolean): Promise<{ output: string; elapsedMs: number }> {
  const scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  const source = new LinuxPC('linux-pc', 'SRC', 0, 0);
  const target = new LinuxPC('linux-pc', 'DST', 0, 0);
  new Cable('c1').connect(source.getPorts()[0], target.getPorts()[0]);
  await source.executeCommand('sudo ip addr add 10.9.0.1/24 dev eth0');
  await target.executeCommand('sudo ip addr add 10.9.0.2/24 dev eth0');
  if (silent) await target.executeCommand('sudo iptables -A INPUT -p icmp -j DROP');
  const before = scheduler.now();
  const output = await scheduler.advanceUntilSettled(Promise.resolve(source.executeCommand(command)));
  return { output, elapsedMs: scheduler.now() - before };
}

describe('ping emet a cadence fixe, les reponses arrivent a part', () => {
  it('20 echos perdus, -W 2 : environ 2,2 s et non 40 s', async () => {
    const { output, elapsedMs } = await pingSilentHost('ping -c 20 -i 0.01 -W 2 10.9.0.2', true);

    expect(output).toMatch(/^20 packets transmitted, 0 received, 100% packet loss/m);
    expect(elapsedMs).toBeLessThan(4000);
  }, 30000);

  it('-w 3 -W 10 : rend la main apres 3 s, pas apres 10 s', async () => {
    const { output, elapsedMs } = await pingSilentHost('ping -w 3 -W 10 10.9.0.2', true);

    expect(output).toMatch(/packets transmitted, 0 received, 100% packet loss/);
    expect(elapsedMs).toBeLessThan(5000);
  }, 30000);

  it('-O signale l echo precedent encore sans reponse', async () => {
    const { output } = await pingSilentHost('ping -c 3 -O -i 0.5 -W 5 10.9.0.2', true);

    expect(output).toContain('no answer yet for icmp_seq=1');
    expect(output).toContain('no answer yet for icmp_seq=2');
  }, 30000);

  it('temoin : hote qui repond, memes options, 20 recus', async () => {
    const { output, elapsedMs } = await pingSilentHost('ping -c 20 -i 0.01 -W 2 10.9.0.2', false);

    expect(output).toMatch(/^20 packets transmitted, 20 received, 0% packet loss/m);
    expect(elapsedMs).toBeLessThan(4000);
  }, 30000);

  it('les paquets transmis sont comptes meme quand rien ne revient', async () => {
    const { output } = await pingSilentHost('ping -c 5 -i 0.2 -W 1 10.9.0.2', true);

    expect(output).toMatch(/^5 packets transmitted, 0 received/m);
  }, 30000);
});
