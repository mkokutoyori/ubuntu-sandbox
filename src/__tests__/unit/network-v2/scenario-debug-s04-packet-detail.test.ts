import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

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
  const pc = new LinuxPC('PC-Linux');
  const srv = new LinuxServer('SRV');
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

  pc.configureInterface('eth0', new IPAddress('192.168.10.105'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('192.168.20.10'), new SubnetMask('255.255.255.0'));
  await run(pc, 'ip route add default via 192.168.10.254');
  await run(srv, 'ip route add default via 192.168.20.254');

  const vues: string[] = [];
  r.getDebugService().subscribe((l: string) => vues.push(l));
  return { r, pc, srv, vues };
}

async function filtre(r: CiscoRouter): Promise<void> {
  await run(r, 'configure terminal');
  await run(r, 'ip access-list extended FILTRE-PKT');
  await run(r, '10 permit ip host 192.168.10.105 any');
  await run(r, '20 permit ip any host 192.168.10.105');
  await run(r, 'exit');
  await run(r, 'end');
}

describe('Scénario 4 — debug ip packet detail montre le transport', () => {
  it('la confirmation signale le mode détaillé', async () => {
    const { r } = await lab();
    await filtre(r);
    const out = await run(r, 'debug ip packet FILTRE-PKT detail');
    expect(out).toContain('IP packet debugging is on');
    expect(out).toContain('detailed');
    expect(out).toContain('FILTRE-PKT');
  });

  it('show debugging rappelle que le détail est actif', async () => {
    const { r } = await lab();
    await filtre(r);
    await run(r, 'debug ip packet FILTRE-PKT detail');
    expect(await run(r, 'show debugging')).toContain('(detailed)');
  });

  it('un ping produit la ligne ICMP type=8', async () => {
    const { r, pc, vues } = await lab();
    await filtre(r);
    await run(r, 'debug ip packet FILTRE-PKT detail');

    await run(pc, 'ping -c 1 192.168.20.10');

    expect(vues.some(l => /^ICMP type=8, code=0$/.test(l))).toBe(true);
  });

  it('une connexion TCP produit ports, seq, ack, fenêtre et drapeau SYN', async () => {
    const { r, pc, srv, vues } = await lab();
    await filtre(r);
    await run(r, 'debug ip packet FILTRE-PKT detail');

    pc.getTcpStack().connect('192.168.20.10', 22);
    await new Promise((res) => setTimeout(res, 300));

    const tcp = vues.filter(l => l.startsWith('TCP '));
    expect(tcp.length).toBeGreaterThan(0);
    expect(tcp.some(l => /^TCP src=\d+, dst=22, seq=\d+, ack=\d+, win=\d+/.test(l))).toBe(true);
    expect(tcp.some(l => /\bSYN\b/.test(l))).toBe(true);
  });

  it('un datagramme UDP produit ses deux ports sans seq ni drapeau', async () => {
    const { r, pc, vues } = await lab();
    await filtre(r);
    await run(r, 'debug ip packet FILTRE-PKT detail');

    pc.sendUdpDatagram(new IPAddress('192.168.20.10'), 53, 40000, { type: 'dns' } as never);
    await new Promise((res) => setTimeout(res, 300));

    const udp = vues.filter(l => l.startsWith('UDP '));
    expect(udp.length).toBeGreaterThan(0);
    expect(udp.some(l => /^UDP src=\d+, dst=53$/.test(l))).toBe(true);
    expect(udp.every(l => !/seq=/.test(l))).toBe(true);
  });

  it('sans detail, aucune ligne de transport n\'est émise', async () => {
    const { r, pc, vues } = await lab();
    await filtre(r);
    await run(r, 'debug ip packet FILTRE-PKT');

    await run(pc, 'ping -c 1 192.168.20.10');

    expect(vues.some(l => l.startsWith('IP: '))).toBe(true);
    expect(vues.some(l => /^(TCP|UDP|ICMP type)/.test(l))).toBe(false);
  });
});
