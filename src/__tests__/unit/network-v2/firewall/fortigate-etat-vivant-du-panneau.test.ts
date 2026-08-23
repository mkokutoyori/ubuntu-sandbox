import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { HostObservables } from '@/network/devices/host/observables';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

const vues = (d: unknown): HostObservables | undefined =>
  (d as { observables?: HostObservables }).observables;

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
  await run(pc, 'ip link set eth0 up');
  for (const c of ['config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping ssh', 'next', 'end']) {
    await run(fgt, c);
  }
  return { fgt, pc };
}

describe('le panneau lit un pare-feu comme il lit un hote', () => {
  it('le pare-feu EXPOSE des vues, c est ce que le panneau cherche', async () => {
    const { fgt } = await laboratoire();
    expect(vues(fgt)).toBeDefined();
  });

  it('une route connectee parait des que l interface est adressee', async () => {
    const { fgt } = await laboratoire();
    const routes = vues(fgt)!.routes.get();
    expect(routes.some(r => r.destination === '192.168.10.0' && r.iface === 'port2')).toBe(true);
  });

  it('la table ARP montree est CELLE de la machine, pas une copie figee', async () => {
    const { fgt, pc } = await laboratoire();
    await run(fgt, 'execute ping 192.168.10.10');

    const arp = vues(fgt)!.arp.get();
    expect(arp.some(e => e.ip === '192.168.10.10' && e.iface === 'port2')).toBe(true);

    const port = pc.getPort('eth0')!;
    expect(arp.find(e => e.ip === '192.168.10.10')?.mac)
      .toBe(port.getMAC().toString());
  });

  it('les compteurs comptent ce qui est REELLEMENT parti', async () => {
    const { fgt } = await laboratoire();
    expect(vues(fgt)!.stats.get().icmpEchosSent).toBe(0);

    await run(fgt, 'execute ping 192.168.10.10');

    const stats = vues(fgt)!.stats.get();
    expect(stats.icmpEchosSent).toBeGreaterThan(0);
    expect(stats.icmpEchosReceived).toBeGreaterThan(0);
    expect(stats.arpCacheSize).toBeGreaterThan(0);
    expect(stats.routeCount).toBeGreaterThan(0);
  });

  it('un service d administration ouvert parait comme ecouteur TCP', async () => {
    const { fgt } = await laboratoire();
    const ports = vues(fgt)!.tcpListeners.get().map(l => l.port);
    expect(ports).toContain(22);
  });

  it('une route statique tapee a la CLI parait', async () => {
    const { fgt } = await laboratoire();
    for (const c of ['config router static', 'edit 1', 'set dst 10.9.0.0 255.255.255.0',
      'set gateway 192.168.10.10', 'set device port2', 'next', 'end']) await run(fgt, c);

    const routes = vues(fgt)!.routes.get();
    expect(routes.some(r => r.destination === '10.9.0.0' && r.gateway === '192.168.10.10'))
      .toBe(true);
  });

  it('les vues SUIVENT, elles ne sont pas figees au demarrage', async () => {
    const { fgt } = await laboratoire();
    const observees: number[] = [];
    vues(fgt)!.arp.subscribe(() => { observees.push(vues(fgt)!.arp.get().length); });

    await run(fgt, 'execute ping 192.168.10.10');

    expect(observees.length).toBeGreaterThan(0);
    expect(observees[observees.length - 1]).toBeGreaterThan(0);
  });

  it('un pare-feu sans rien de configure ne ment pas : tout est vide', () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    expect(vues(fgt)!.arp.get()).toHaveLength(0);
    expect(vues(fgt)!.stats.get().icmpEchosSent).toBe(0);
  });
});
