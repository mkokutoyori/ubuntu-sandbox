import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { replayVendorConfig } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function routeur(cmds: string[] = []) {
  const r = new HuaweiRouter('R', 0, 0);
  for (const c of ['system-view', 'dhcp enable', 'interface GigabitEthernet0/0/0',
    'undo shutdown', 'ip address 10.0.0.1 255.255.255.0', ...cmds, 'quit', 'quit']) {
    await r.executeCommand(c);
  }
  return r;
}

const section = async (r: HuaweiRouter) =>
  ((await r.executeCommand('display current-configuration interface GigabitEthernet0/0/0')) ?? '')
    .split('\n').map((l) => l.trim()).filter((l) => l && l !== '#');

async function labPolice(car: string | null) {
  const r = new HuaweiRouter('R', 0, 0);
  const pc = new LinuxPC('PC');
  const srv = new LinuxPC('SRV');
  new Cable('c1').connect(pc.getPorts()[0], r.getPorts()[0]);
  new Cable('c2').connect(srv.getPorts()[0], r.getPorts()[1]);
  const cmds = ['system-view', 'interface GigabitEthernet0/0/0', 'undo shutdown',
    'ip address 10.0.0.1 255.255.255.0'];
  if (car) cmds.push(car);
  cmds.push('quit', 'interface GigabitEthernet0/0/1', 'undo shutdown',
    'ip address 10.0.1.1 255.255.255.0', 'quit', 'quit');
  for (const c of cmds) await r.executeCommand(c);
  await pc.executeCommand('sudo ip addr add 10.0.0.5/24 dev eth0');
  await pc.executeCommand('sudo ip route add default via 10.0.0.1');
  await srv.executeCommand('sudo ip addr add 10.0.1.5/24 dev eth0');
  await srv.executeCommand('sudo ip route add default via 10.0.1.1');
  const out = (await pc.executeCommand('ping -c 1 10.0.1.5')) ?? '';
  return { r, sortie: out };
}

describe('VRP — `qos car` police vraiment', () => {
  it('un seau plus petit qu\'un paquet fait tomber le ping', { timeout: 60000 }, async () => {
    const temoin = await labPolice(null);
    expect(temoin.sortie, 'témoin sans CAR').toMatch(/, 0% packet loss/);

    const large = await labPolice('qos car inbound cir 100000 cbs 100000');
    expect(large.sortie, 'seau large').toMatch(/, 0% packet loss/);

    const etroit = await labPolice('qos car inbound cir 8 cbs 1 pbs 1');
    expect(etroit.sortie, 'seau étroit').toMatch(/, 100% packet loss/);
  });

  it('compte ce qui est passé et ce qui a dépassé', { timeout: 60000 }, async () => {
    const { r } = await labPolice('qos car inbound cir 8 cbs 1 pbs 1');
    const regle = r.getCarPolicer('GE0/0/0')?.list()[0];
    expect(regle?.exceededPackets).toBe(1);
    expect(regle?.conformedPackets).toBe(0);
  });

  it('figure dans la configuration telle qu\'elle a été écrite', async () => {
    expect(await section(await routeur(['qos car inbound cir 1000'])))
      .toContain('qos car inbound cir 1000');
    expect(await section(await routeur([
      'qos car outbound cir 2000 pir 4000 cbs 20000 pbs 40000',
    ]))).toContain('qos car outbound cir 2000 pir 4000 cbs 20000 pbs 40000');
  });

  it('refuse une règle que le seau ne peut pas représenter', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0']) await r.executeCommand(c);
    for (const cmd of ['qos car inbound cir zorglub', 'qos car inbound cir 2000 pir 1000',
      'qos car sideways cir 1000']) {
      expect(await r.executeCommand(cmd), cmd).toMatch(/Wrong parameter/);
    }
    expect(r.getCarPolicer('GE0/0/0')?.isEmpty() ?? true).toBe(true);
  });

  it('`undo qos car` retire la règle et la ligne', async () => {
    const r = await routeur(['qos car inbound cir 1000', 'undo qos car']);
    expect((await section(r)).filter((x) => x.startsWith('qos car'))).toHaveLength(0);
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeur(['qos car inbound cir 1000']);
    const texte = (await r.executeCommand('display current-configuration')) ?? '';
    const r2 = new HuaweiRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    expect(await section(r2)).toContain('qos car inbound cir 1000');
  });
});

describe('VRP — le reste de la famille QoS est refusé', () => {
  it('nomme l\'ordonnanceur absent au lieu de ranger le réglage', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0']) await r.executeCommand(c);
    for (const cmd of ['qos lr outbound cir 2000', 'qos gts cir 1000', 'qos queue 64',
      'qos wfq', 'qos wred', 'qos pq', 'qos cq', 'qos wrr', 'qos priority 5',
      'qos queue-profile QP']) {
      expect(await r.executeCommand(cmd), cmd).toMatch(/no .* scheduler/);
    }
    expect(await r.executeCommand('trust dscp')).toMatch(/no QoS trust boundary/);
  });

  it('accepte `ip urpf`, le controle de chemin inverse existant desormais', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0']) await r.executeCommand(c);
    expect(await r.executeCommand('ip urpf strict')).toBe('');
    expect(await r.executeCommand('display this')).toContain('ip urpf strict');
  });
});

describe('VRP — le DNS d\'un pool d\'interface revient d\'un export', () => {
  it('rend `dhcp server dns-list`', async () => {
    expect(await section(await routeur([
      'dhcp select interface', 'dhcp server dns-list 8.8.8.8 8.8.4.4',
    ]))).toContain('dhcp server dns-list 8.8.8.8 8.8.4.4');
  });

  it('n\'écrit rien sans pool d\'interface', async () => {
    const l = await section(await routeur(['dhcp select global']));
    expect(l.filter((x) => x.startsWith('dhcp server dns-list'))).toHaveLength(0);
  });
});
