import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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
  srv: LinuxServer;
  vues: string[];
}

async function lab(): Promise<Lab> {
  const r = new CiscoRouter('Router');
  const pc = new LinuxPC('PC-Win-1');
  const srv = new LinuxServer('SRV-DNS');
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);

  await run(r, 'enable');
  await run(r, 'configure terminal');
  await run(r, 'interface GigabitEthernet0/0');
  await run(r, 'ip address 192.168.10.1 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'exit');
  await run(r, 'interface GigabitEthernet0/1');
  await run(r, 'ip address 192.168.20.1 255.255.255.0');
  await run(r, 'no shutdown');
  await run(r, 'end');

  pc.configureInterface('eth0', new IPAddress('192.168.10.101'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('192.168.20.10'), new SubnetMask('255.255.255.0'));
  await run(pc, 'ip route add default via 192.168.10.1');
  await run(srv, 'ip route add default via 192.168.20.1');

  const vues: string[] = [];
  collecteDebug(r.getDebugService(), vues);
  return { r, pc, srv, vues };
}

async function filtreDns(r: CiscoRouter): Promise<void> {
  await run(r, 'configure terminal');
  await run(r, 'ip access-list extended FILTRE-DNS');
  await run(r, '10 permit udp any any eq 53');
  await run(r, 'exit');
  await run(r, 'end');
}

const udp = (vues: string[]) => vues.filter(l => l.startsWith('UDP:'));
const pause = () => new Promise((res) => setTimeout(res, 300));

describe('Scénario 6 — debug ip udp observe DNS et DHCP', () => {
  it('la confirmation nomme l\'ACL de filtrage', async () => {
    const { r } = await lab();
    await filtreDns(r);
    expect(await run(r, 'debug ip udp FILTRE-DNS'))
      .toContain('UDP packet debugging is on for access list FILTRE-DNS');
  });

  it('une requête DNS porte les deux couples adresse(port) et sa longueur', async () => {
    const { r, pc, vues } = await lab();
    await run(r, 'debug ip udp');

    pc.sendUdpDatagram(new IPAddress('192.168.20.10'), 53, 45231, { type: 'dns' } as never);
    await pause();

    const ligne = udp(vues).find(l => l.includes('(53)'));
    expect(ligne).toBeDefined();
    expect(ligne).toMatch(
      /^UDP: src=192\.168\.10\.101\(45231\), dst=192\.168\.20\.10\(53\), length=\d+$/);
  });

  it('la réponse inverse les ports', async () => {
    const { r, pc, srv, vues } = await lab();
    await run(r, 'debug ip udp');

    pc.sendUdpDatagram(new IPAddress('192.168.20.10'), 53, 45231, { type: 'dns' } as never);
    await pause();
    srv.sendUdpDatagram(new IPAddress('192.168.10.101'), 45231, 53, { type: 'dns' } as never);
    await pause();

    const lignes = udp(vues);
    expect(lignes.some(l => /src=192\.168\.10\.101\(45231\), dst=192\.168\.20\.10\(53\)/.test(l))).toBe(true);
    expect(lignes.some(l => /src=192\.168\.20\.10\(53\), dst=192\.168\.10\.101\(45231\)/.test(l))).toBe(true);
  });

  it('une requête sans réponse ne laisse qu\'une seule ligne', async () => {
    const { r, pc, vues } = await lab();
    await run(r, 'debug ip udp');

    pc.sendUdpDatagram(new IPAddress('192.168.20.10'), 53, 52341, { type: 'dns' } as never);
    await pause();

    const echanges = udp(vues).filter(l => l.includes('52341'));
    expect(echanges.length).toBe(1);
    expect(echanges[0]).toMatch(/dst=192\.168\.20\.10\(53\)/);
  });

  it('un échange DHCP montre les ports 68 et 67', async () => {
    const { r, pc, vues } = await lab();
    await run(r, 'configure terminal');
    await run(r, 'ip dhcp pool LAN');
    await run(r, 'network 192.168.10.0 255.255.255.0');
    await run(r, 'default-router 192.168.10.1');
    await run(r, 'end');
    await run(r, 'debug ip udp');

    await run(pc, 'sudo dhclient eth0');
    await pause();

    const lignes = udp(vues);
    expect(lignes.some(l => /\(68\), dst=[\d.]+\(67\)/.test(l))).toBe(true);
  });

  it('sans debug, aucune ligne UDP n\'est émise', async () => {
    const { pc, vues } = await lab();
    pc.sendUdpDatagram(new IPAddress('192.168.20.10'), 53, 45231, { type: 'dns' } as never);
    await pause();
    expect(udp(vues)).toEqual([]);
  });

  it('undebug all arrête la trace UDP', async () => {
    const { r, pc, vues } = await lab();
    await run(r, 'debug ip udp');
    pc.sendUdpDatagram(new IPAddress('192.168.20.10'), 53, 45231, { type: 'dns' } as never);
    await pause();
    const avant = udp(vues).length;
    expect(avant).toBeGreaterThan(0);

    await run(r, 'undebug all');
    pc.sendUdpDatagram(new IPAddress('192.168.20.10'), 53, 45231, { type: 'dns' } as never);
    await pause();
    expect(udp(vues).length).toBe(avant);
  });
});
