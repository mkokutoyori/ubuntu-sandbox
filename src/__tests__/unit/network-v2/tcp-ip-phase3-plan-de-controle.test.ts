import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  getPortNames(): string[];
  getPort(name: string): unknown;
  powerOn(): void;
}

async function taper(device: Cli, lignes: readonly string[]): Promise<void> {
  for (const ligne of lignes) await device.executeCommand(ligne);
}

interface Labo {
  r1: Cli;
  r2: Cli;
  pc: Cli;
  hote: Cli;
}

async function labo(): Promise<Labo> {
  const r1 = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  const r2 = new CiscoRouter('R2', 200, 0) as unknown as Cli;
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0) as unknown as Cli;
  const hote = new LinuxPC('linux-pc', 'HOTE', 400, 0) as unknown as Cli;
  for (const d of [r1, r2, pc, hote]) d.powerOn();

  const [r1a, r1b] = r1.getPortNames();
  const [r2a, r2b] = r2.getPortNames();

  new Cable('pc-r1').connect(pc.getPort('eth0') as never, r1.getPort(r1a) as never);
  new Cable('r1-r2').connect(r1.getPort(r1b) as never, r2.getPort(r2a) as never);
  new Cable('r2-h').connect(r2.getPort(r2b) as never, hote.getPort('eth0') as never);

  await taper(r1, [
    'enable', 'configure terminal',
    `interface ${r1a}`, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    `interface ${r1b}`, 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1',
    'network 192.168.1.0 0.0.0.255 area 0',
    'network 10.0.0.0 0.0.0.3 area 0',
    'end',
  ]);
  await taper(r2, [
    'enable', 'configure terminal',
    `interface ${r2a}`, 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    `interface ${r2b}`, 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1',
    'network 10.0.0.0 0.0.0.3 area 0',
    'network 192.168.2.0 0.0.0.255 area 0',
    'end',
  ]);
  await taper(pc, [
    'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1',
  ]);
  await taper(hote, [
    'ip link set eth0 up', 'ip addr add 192.168.2.10/24 dev eth0',
    'ip route add default via 192.168.2.1',
  ]);
  return { r1, r2, pc, hote };
}

/** Ce que le plan de CONTROLE publie : recalculs, adjacences, routes. */
function compterRecalculs(): { total(): number; arreter(): void } {
  let total = 0;
  const off = getDefaultEventBus().subscribeAll((event: { topic: string }) => {
    if (/spf|converge|route\.(installed|changed|withdrawn)|lsdb/i.test(event.topic)) total++;
  });
  return { total: () => total, arreter: off };
}

describe('le laboratoire converge d abord — sans quoi rien ne se mesure', () => {
  it('OSPF apprend le reseau distant', async () => {
    const { r1 } = await labo();

    expect(await r1.executeCommand('show ip route')).toMatch(/O\s+192\.168\.2\.0/);
  });

  it('et le PC joint l hote de bout en bout', async () => {
    const { pc } = await labo();

    expect(await pc.executeCommand('ping -c 2 192.168.2.10')).toMatch(/, 0% packet loss/);
  });
});

describe('ACHEMINER ne recalcule pas', () => {
  it('vingt paquets ne publient AUCUN recalcul', async () => {
    const { pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.2.10');

    const compteur = compterRecalculs();
    for (let i = 0; i < 20; i++) await pc.executeCommand('ping -c 1 192.168.2.10');
    compteur.arreter();

    expect(compteur.total()).toBe(0);
  });

  it('et la table est identique avant et apres', async () => {
    const { r1, pc } = await labo();
    const avant = await r1.executeCommand('show ip route');

    for (let i = 0; i < 10; i++) await pc.executeCommand('ping -c 1 192.168.2.10');

    expect(await r1.executeCommand('show ip route')).toBe(avant);
  });

  it('un paquet vers un reseau INCONNU ne recalcule pas non plus', async () => {
    const { pc } = await labo();

    const compteur = compterRecalculs();
    await pc.executeCommand('ping -c 1 -W 1 172.31.99.99');
    compteur.arreter();

    expect(compteur.total()).toBe(0);
  });
});

describe('ce qui DOIT recalculer recalcule encore', () => {
  it('un lien qui tombe fait disparaitre la route apprise', async () => {
    const { r1, r2 } = await labo();
    const [, r2a] = r2.getPortNames();

    await taper(r2, [
      'enable', 'configure terminal',
      `interface ${r2a}`, 'shutdown', 'end',
    ]);

    expect(await r1.executeCommand('show ip route')).not.toMatch(/O\s+192\.168\.2\.0/);
  });

  it('et le lien qui remonte la fait revenir', async () => {
    const { r1, r2 } = await labo();
    const [, r2a] = r2.getPortNames();

    await taper(r2, [
      'enable', 'configure terminal',
      `interface ${r2a}`, 'shutdown', 'no shutdown', 'end',
    ]);

    expect(await r1.executeCommand('show ip route')).toMatch(/O\s+192\.168\.2\.0/);
  });

  it('une route statique ajoutee parait sans qu on achemine', async () => {
    const { r1 } = await labo();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip route 172.20.0.0 255.255.0.0 10.0.0.2', 'end',
    ]);

    expect(await r1.executeCommand('show ip route')).toMatch(/172\.20\.0\.0/);
  });
});
