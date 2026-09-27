/*
 * Un hote Linux inscrivait chaque redirection ICMP comme une route
 * STATIQUE, permanente, que l'export de topologie sauvegardait.
 *
 * Mesure de depart, sur la topologie que l'utilisateur a exportee
 * (`lan_with_firewall_fortigate.topology (1).json`, commit 16b70e5aa) :
 * PC1, passerelle Router2 (192.168.1.1), qui route 192.168.30.0/24 vers
 * FW1 (192.168.1.99) sur le meme LAN, portait 257 routes
 *
 *   192.168.30.X/32 via 192.168.1.99 dev eth0 proto static metric 1
 *
 * une par adresse qu'un balayage avait touchee ; PC2, PC7 et Server3 en
 * portaient aussi. `ip route` les listait, elles ne s'effacaient jamais, et
 * le rechargement les rendait eternelles.
 *
 * L'AUTORITE EST LINUX (`net/ipv4/route.c`, `__ip_do_redirect`) : une
 * redirection acceptee devient une EXCEPTION de prochain saut
 * (`update_or_create_fnhe`) qui expire apres `ip_rt_gc_timeout` — 300 s —
 * et n'entre pas dans la table principale. `ip route get` la montre dans sa
 * ligne `cache <redirected> expires …sec`, `ip route flush cache` l'efface.
 * C'est le meme cache que la PMTU, deja porte par l'hote.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire le code.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 5 des 6 cas tombent. Le sixieme, le TEMOIN, passe des deux cotes :
 * l'hote apprenait deja le meilleur saut, seul l'endroit ou il le rangeait
 * etait faux.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { exportTopology } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

afterEach(() => { __setDefaultScheduler(null); });

async function lab(): Promise<LinuxPC> {
  const lan = new GenericSwitch('switch-generic', 'LAN', 4, 0, 0);
  const ra = new CiscoRouter('RA', 0, 0);
  const rb = new CiscoRouter('RB', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('c1').connect(ra.getPorts()[0], lan.getPorts()[0]);
  new Cable('c2').connect(rb.getPorts()[0], lan.getPorts()[1]);
  new Cable('c3').connect(pc.getPorts()[0], lan.getPorts()[2]);
  new Cable('c4').connect(rb.getPorts()[1], server.getPorts()[0]);
  for (const c of ['enable', 'configure terminal',
    `interface ${ra.getPorts()[0].getName()}`, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.168.30.0 255.255.255.0 192.168.1.99', 'end']) await ra.executeCommand(c);
  for (const c of ['enable', 'configure terminal',
    `interface ${rb.getPorts()[0].getName()}`, 'ip address 192.168.1.99 255.255.255.0', 'no shutdown', 'exit',
    `interface ${rb.getPorts()[1].getName()}`, 'ip address 192.168.30.1 255.255.255.0', 'no shutdown', 'exit',
    'end']) await rb.executeCommand(c);
  await server.executeCommand('sudo ip addr add 192.168.30.4/24 dev eth0');
  await server.executeCommand('sudo ip route add default via 192.168.30.1');
  await pc.executeCommand('sudo ip addr add 192.168.1.3/24 dev eth0');
  await pc.executeCommand('sudo ip route add default via 192.168.1.1');
  return pc;
}

describe('the redirect lives in the cache, not in the table', () => {
  it('the ping goes through and the host learns the better hop — WITNESS', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('ping -c 4 192.168.30.4')).toMatch(/, 0% packet loss/);
    expect(await pc.executeCommand('ip route get 192.168.30.4')).toMatch(/^192\.168\.30\.4 via 192\.168\.1\.99 dev eth0 /);
  }, 30000);

  it('`ip route` does not list the redirect', async () => {
    const pc = await lab();
    await pc.executeCommand('ping -c 4 192.168.30.4');

    expect(await pc.executeCommand('ip route')).not.toMatch(/192\.168\.30\.4/);
  }, 30000);

  it('`ip route get` shows it in its cache', async () => {
    const pc = await lab();
    await pc.executeCommand('ping -c 4 192.168.30.4');

    expect(await pc.executeCommand('ip route get 192.168.30.4'))
      .toMatch(/\n {4}cache <redirected> expires \d+sec/);
  }, 30000);

  it('`ip route flush cache` erases it', async () => {
    const pc = await lab();
    await pc.executeCommand('ping -c 4 192.168.30.4');
    await pc.executeCommand('sudo ip route flush cache');

    expect(await pc.executeCommand('ip route get 192.168.30.4')).toMatch(/^192\.168\.30\.4 via 192\.168\.1\.1 dev eth0 /);
  }, 30000);

  it('it expires after 300 s', async () => {
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const pc = await lab();
    await scheduler.advanceUntilSettled(Promise.resolve(pc.executeCommand('ping -c 4 192.168.30.4')));
    expect(await pc.executeCommand('ip route get 192.168.30.4')).toMatch(/^192\.168\.30\.4 via 192\.168\.1\.99 /);

    scheduler.advance(301_000);

    expect(await pc.executeCommand('ip route get 192.168.30.4')).toMatch(/^192\.168\.30\.4 via 192\.168\.1\.1 dev eth0 /);
  }, 30000);

  it('the topology export does not save it', async () => {
    const pc = await lab();
    await pc.executeCommand('ping -c 4 192.168.30.4');

    const exported = exportTopology('lab', new Map([[pc.getId(), pc as never]]), []);
    const routes = exported.devices[0].staticRoutes ?? [];
    expect(routes.filter((r) => r.network === '192.168.30.4')).toEqual([]);
  }, 30000);
});
