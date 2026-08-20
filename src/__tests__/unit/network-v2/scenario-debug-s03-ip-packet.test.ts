import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { collecteDebug } from './_helpers/debugLines';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  Promise.resolve(d.executeCommand(c));

interface Lab {
  r: CiscoRouter;
  pc: LinuxPC;
  cible: LinuxPC;
  vues: string[];
}

async function lab(): Promise<Lab> {
  const r = new CiscoRouter('Router');
  const pc = new LinuxPC('PC-Linux');
  const cible = new LinuxPC('PC-Cible');
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, cible.getPort('eth0')!);

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

  pc.configureInterface('eth0', new IPAddress('192.168.10.105'), new SubnetMask('255.255.255.0'));
  cible.configureInterface('eth0', new IPAddress('192.168.20.101'), new SubnetMask('255.255.255.0'));
  await run(pc, 'ip route add default via 192.168.10.254');
  await run(cible, 'ip route add default via 192.168.20.254');

  const vues: string[] = [];
  collecteDebug(r.getDebugService(), vues);
  return { r, pc, cible, vues };
}

async function filtrePkt(r: CiscoRouter): Promise<void> {
  await run(r, 'configure terminal');
  await run(r, 'ip access-list extended FILTRE-PKT');
  await run(r, '10 permit ip host 192.168.10.105 any');
  await run(r, '20 permit ip any host 192.168.10.105');
  await run(r, 'exit');
  await run(r, 'end');
}

const decisions = (vues: string[]) => vues.filter(l => l.startsWith('IP: '));

describe('Scénario 3 — debug ip packet montre chaque décision', () => {
  it('la commande avec ACL nomme le filtre', async () => {
    const { r } = await lab();
    await filtrePkt(r);
    expect(await run(r, 'debug ip packet FILTRE-PKT'))
      .toContain('IP packet debugging is on for access list FILTRE-PKT');
  });

  it('forward porte les deux interfaces, la longueur et la décision', async () => {
    const { r, pc, vues } = await lab();
    await filtrePkt(r);
    await run(r, 'debug ip packet FILTRE-PKT');

    expect(await run(pc, 'ping -c 1 192.168.20.101')).toMatch(/, 0% packet loss/);

    const fwd = decisions(vues).find(l => l.includes('forward'));
    expect(fwd).toBeDefined();
    expect(fwd).toMatch(/^IP: s=192\.168\.10\.105 \(GigabitEthernet0\/0\)/);
    expect(fwd).toMatch(/d=192\.168\.20\.101 \(GigabitEthernet0\/1\)/);
    expect(fwd).toMatch(/len \d+/);
    expect(fwd).toMatch(/forward$/);
  });

  it('unroutable quand aucune route ne mène à la destination', async () => {
    const { r, pc, vues } = await lab();
    await filtrePkt(r);
    await run(r, 'debug ip packet FILTRE-PKT');

    await run(pc, 'ping -c 1 10.99.0.1');

    const ligne = decisions(vues).find(l => l.includes('unroutable'));
    expect(ligne).toBeDefined();
    expect(ligne).toMatch(/s=192\.168\.10\.105/);
    expect(ligne).toMatch(/d=10\.99\.0\.1/);
  });

  it('access denied quand une ACL rejette le paquet', async () => {
    const { r, pc, vues } = await lab();
    await filtrePkt(r);
    await run(r, 'configure terminal');
    await run(r, 'access-list 120 deny ip host 192.168.10.105 host 192.168.20.101');
    await run(r, 'access-list 120 permit ip any any');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'ip access-group 120 in');
    await run(r, 'end');
    await run(r, 'debug ip packet FILTRE-PKT');

    await run(pc, 'ping -c 1 192.168.20.101');

    const ligne = decisions(vues).find(l => l.includes('access denied'));
    expect(ligne).toBeDefined();
    expect(ligne).toMatch(/s=192\.168\.10\.105/);
  });

  it('encapsulation failed quand l\'ARP du prochain saut ne répond pas',
    { timeout: 20_000 }, async () => {
    const { r, pc, vues } = await lab();
    await filtrePkt(r);
    await run(r, 'debug ip packet FILTRE-PKT');

    await run(pc, 'ping -c 1 192.168.20.200');
    await new Promise((res) => setTimeout(res, 2_400));

    const ligne = decisions(vues).find(l => l.includes('encapsulation failed'));
    expect(ligne).toBeDefined();
    expect(ligne).toMatch(/d=192\.168\.20\.200/);
  });

  it('l\'ACL de debug écarte le trafic d\'une autre machine', async () => {
    const { r, cible, vues } = await lab();
    await filtrePkt(r);
    await run(r, 'debug ip packet FILTRE-PKT');

    await run(cible, 'ping -c 1 192.168.10.254');

    expect(decisions(vues).some(l => l.includes('192.168.20.101'))).toBe(false);
  });

  it('undebug all coupe la trace des paquets', async () => {
    const { r, pc, vues } = await lab();
    await filtrePkt(r);
    await run(r, 'debug ip packet FILTRE-PKT');
    await run(pc, 'ping -c 1 192.168.20.101');
    const avant = decisions(vues).length;
    expect(avant).toBeGreaterThan(0);

    await run(r, 'undebug all');
    await run(pc, 'ping -c 1 192.168.20.101');
    expect(decisions(vues).length).toBe(avant);
  });
});
