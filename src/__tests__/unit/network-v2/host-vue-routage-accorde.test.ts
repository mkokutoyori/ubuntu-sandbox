import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { HostObservables } from '@/network/devices/host/observables';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

const vues = (d: unknown) => (d as { observables: HostObservables }).observables;

const table = (d: unknown) =>
  (d as { getRoutingTable(): ReadonlyArray<unknown> }).getRoutingTable();

function accordent(d: unknown): void {
  expect(vues(d).routes.get().length).toBe(table(d).length);
  expect(vues(d).stats.get().routeCount).toBe(table(d).length);
}

describe('la table de routage MONTREE est celle de la machine', () => {
  it('une adresse posee cree une route connectee, et la vue la voit', async () => {
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
    await run(pc, 'ip link set eth0 up');

    expect(await run(pc, 'ip route')).toContain('192.168.10.0/24');
    expect(vues(pc).routes.get()
      .some(r => r.destination === '192.168.10.0' && r.iface === 'eth0')).toBe(true);
    accordent(pc);
  });

  it('une passerelle par defaut parait dans la vue', async () => {
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
    await run(pc, 'ip link set eth0 up');
    await run(pc, 'ip route add default via 192.168.10.1');

    expect(vues(pc).routes.get().some(r => r.gateway === '192.168.10.1')).toBe(true);
    accordent(pc);
  });

  it('une route retiree disparait de la vue', async () => {
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
    await run(pc, 'ip link set eth0 up');
    await run(pc, 'ip route add 10.9.0.0/24 via 192.168.10.1');
    expect(vues(pc).routes.get().some(r => r.destination === '10.9.0.0')).toBe(true);

    await run(pc, 'ip route del 10.9.0.0/24');
    expect(vues(pc).routes.get().some(r => r.destination === '10.9.0.0')).toBe(false);
    accordent(pc);
  });

  it('retirer l adresse retire la route connectee, et la vue suit', async () => {
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    pc.configureInterface('eth0',
      new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));
    expect(vues(pc).routes.get().some(r => r.destination === '192.168.10.0')).toBe(true);

    pc.unconfigureInterface('eth0');
    expect(vues(pc).routes.get().some(r => r.destination === '192.168.10.0')).toBe(false);
    accordent(pc);
  });

  it('la vue est POUSSEE : un abonne est prevenu quand une route nait', async () => {
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    const vus: number[] = [];
    vues(pc).routes.subscribe(() => { vus.push(vues(pc).routes.get().length); });

    await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
    await run(pc, 'ip link set eth0 up');

    expect(vus.length).toBeGreaterThan(0);
    expect(vus[vus.length - 1]).toBeGreaterThan(0);
  });

  it('une machine sans adresse ne montre aucune route', () => {
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    accordent(pc);
  });
});
