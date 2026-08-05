import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  Promise.resolve(d.executeCommand(c));

interface Lab {
  r: CiscoRouter;
  pc: LinuxPC;
  srv: LinuxPC;
  vues: string[];
}

async function lab(): Promise<Lab> {
  const r = new CiscoRouter('Router');
  const pc = new LinuxPC('PC-Linux-1');
  const srv = new LinuxPC('SRV-Oracle');
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);

  await run(r, 'enable');
  await run(r, 'configure terminal');
  await run(r, 'interface GigabitEthernet0/0');
  await run(r, 'ip address 192.168.10.254 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'exit');
  await run(r, 'interface GigabitEthernet0/1');
  await run(r, 'ip address 192.168.20.254 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'end');

  pc.configureInterface('eth0', new IPAddress('192.168.10.101'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('192.168.20.20'), new SubnetMask('255.255.255.0'));
  await run(pc, 'ip route add default via 192.168.10.254');
  await run(srv, 'ip route add default via 192.168.20.254');

  const vues: string[] = [];
  r.getDebugService().subscribe((l: string) => vues.push(l));
  return { r, pc, srv, vues };
}

async function filtreIcmp(r: CiscoRouter): Promise<void> {
  await run(r, 'configure terminal');
  await run(r, 'ip access-list extended FILTRE-ICMP');
  await run(r, '10 permit icmp host 192.168.10.101 any');
  await run(r, '20 permit icmp any host 192.168.10.101');
  await run(r, 'exit');
  await run(r, 'end');
}

describe('Scénario 2 — debug ip icmp voit les pings en temps réel', () => {
  it('la commande se confirme comme sur IOS', async () => {
    const { r } = await lab();
    expect(await run(r, 'debug ip icmp')).toContain('ICMP packet debugging is on');
  });

  it('un ping réussi produit l\'echo reçu puis la réponse', async () => {
    const { r, pc, vues } = await lab();
    await filtreIcmp(r);
    await run(r, 'debug ip icmp');

    expect(await run(pc, 'ping -c 2 192.168.20.20')).toMatch(/, 0% packet loss/);

    const icmp = vues.filter(l => l.startsWith('ICMP:'));
    expect(icmp.some(l => /echo received, src 192\.168\.10\.101, dst 192\.168\.20\.20/.test(l))).toBe(true);
    expect(icmp.some(l => /echo reply sent, src 192\.168\.20\.20, dst 192\.168\.10\.101/.test(l))).toBe(true);
  });

  it('une destination muette donne un host unreachable', { timeout: 20_000 }, async () => {
    const { r, pc, vues } = await lab();
    await filtreIcmp(r);
    await run(r, 'debug ip icmp');

    await run(pc, 'ping -c 1 192.168.20.200');
    await new Promise((r) => setTimeout(r, 2_400));

    const icmp = vues.filter(l => l.startsWith('ICMP:'));
    expect(icmp.some(l => /echo received, src 192\.168\.10\.101, dst 192\.168\.20\.200/.test(l))).toBe(true);
    expect(icmp.some(l => /dst \(192\.168\.20\.200\) host unreachable/.test(l))).toBe(true);
  });

  it('un TTL épuisé donne un time exceeded', async () => {
    const { r, pc, vues } = await lab();
    await filtreIcmp(r);
    await run(r, 'debug ip icmp');

    await run(pc, 'ping -c 1 -t 1 192.168.20.20');

    const icmp = vues.filter(l => l.startsWith('ICMP:'));
    expect(icmp.some(l => /time exceeded \(time to live\) sent to 192\.168\.10\.101/.test(l))).toBe(true);
  });

  it('sans debug actif, aucune ligne ICMP n\'est émise', async () => {
    const { r, pc, vues } = await lab();
    await filtreIcmp(r);
    await run(pc, 'ping -c 2 192.168.20.20');
    expect(vues.filter(l => l.startsWith('ICMP:'))).toEqual([]);
  });

  it('undebug all arrête le flux', async () => {
    const { r, pc, vues } = await lab();
    await run(r, 'debug ip icmp');
    await run(pc, 'ping -c 1 192.168.20.20');
    const avant = vues.filter(l => l.startsWith('ICMP:')).length;
    expect(avant).toBeGreaterThan(0);

    await run(r, 'undebug all');
    await run(pc, 'ping -c 1 192.168.20.20');
    expect(vues.filter(l => l.startsWith('ICMP:')).length).toBe(avant);
  });
});
