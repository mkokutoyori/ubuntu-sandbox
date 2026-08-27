import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

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

/**
 * PC --- R1 === R2 --- HOTE
 *
 * R1 ne connait que le lien 10.0.0.0/30 et le reseau du PC. Le reseau de
 * HOTE, 192.168.2.0/24, ne lui est PAS directement connecte : c'est par
 * lui que passe la recursion.
 */
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
    'end',
  ]);
  await taper(r2, [
    'enable', 'configure terminal',
    `interface ${r2a}`, 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    `interface ${r2b}`, 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.168.1.0 255.255.255.0 10.0.0.1',
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

describe('un saut suivant SUR le lien — le temoin', () => {
  it('la route directe achemine', async () => {
    const { r1, pc } = await labo();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end',
    ]);

    expect(await pc.executeCommand('ping -c 2 192.168.2.10')).toMatch(/, 0% packet loss/);
  });
});

describe('un saut suivant HORS lien se resout par recursion', () => {
  async function recursive(): Promise<Labo> {
    const base = await labo();
    await taper(base.r1, [
      'enable', 'configure terminal',
      'ip route 192.168.2.0 255.255.255.0 10.0.0.2',
      'ip route 172.16.0.0 255.255.0.0 192.168.2.10',
      'end',
    ]);
    return base;
  }

  it('la route recursive est ACCEPTEE et parait dans la table', async () => {
    const { r1 } = await recursive();

    expect(await r1.executeCommand('show ip route')).toMatch(/172\.16\.0\.0/);
  });

  it('le bloc de description nomme le saut suivant CONFIGURE', async () => {
    const { r1 } = await recursive();
    const vue = await r1.executeCommand('show ip route 172.16.0.0');

    expect(vue).toMatch(/Routing entry for 172\.16\.0\.0/);
    expect(vue).toMatch(/192\.168\.2\.10/);
    expect(vue).toMatch(/static/);
  });

  it('un paquet vers ce reseau QUITTE vraiment le routeur', async () => {
    const { r1, pc } = await recursive();
    const avant = await r1.executeCommand('show interfaces');
    await pc.executeCommand('ping -c 1 -W 1 172.16.5.5');
    const apres = await r1.executeCommand('show interfaces');

    expect(apres).not.toBe(avant);
  });

  it('un PING traverse pour de bon par la route recursive', async () => {
    const base = await labo();
    await taper(base.r1, [
      'enable', 'configure terminal',
      'ip route 192.168.2.0 255.255.255.0 10.0.0.2',
      'ip route 172.16.0.0 255.255.0.0 192.168.2.10',
      'end',
    ]);
    await taper(base.hote, ['ip addr add 172.16.5.5/16 dev eth0']);
    await taper(base.r2, [
      'enable', 'configure terminal',
      'ip route 172.16.0.0 255.255.0.0 192.168.2.10', 'end',
    ]);

    expect(await base.pc.executeCommand('ping -c 2 172.16.5.5'))
      .toMatch(/, 0% packet loss/);
  });

  it('la recursion s arrete quand la route INTERMEDIAIRE disparait', async () => {
    const { r1 } = await recursive();
    await taper(r1, [
      'enable', 'configure terminal',
      'no ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end',
    ]);

    expect(await r1.executeCommand('show ip route')).not.toMatch(/172\.16\.0\.0/);
  });

  it('un saut suivant que RIEN ne resout n installe pas de route active', async () => {
    const { r1 } = await labo();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip route 172.16.0.0 255.255.0.0 203.0.113.99', 'end',
    ]);

    expect(await r1.executeCommand('show ip route')).not.toMatch(/172\.16\.0\.0/);
  });
});

describe('une route par defaut recursive — la forme la plus tapee', () => {
  it('`ip route 0.0.0.0 0.0.0.0 <hors-lien>` achemine par recursion', async () => {
    const { r1, pc } = await labo();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip route 192.168.2.0 255.255.255.0 10.0.0.2',
      'ip route 0.0.0.0 0.0.0.0 192.168.2.10',
      'end',
    ]);

    expect(await r1.executeCommand('show ip route')).toMatch(/0\.0\.0\.0\/0|Gateway of last resort/);
    expect(await pc.executeCommand('ping -c 1 -W 1 8.8.8.8')).toMatch(/packet loss/);
  });
});

describe('le plan de DONNEES ne reveille pas le plan de controle', () => {
  it('acheminer un paquet ne CHANGE pas la table de routage', async () => {
    const { r1, pc } = await labo();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end',
    ]);

    const avant = await r1.executeCommand('show ip route');
    await pc.executeCommand('ping -c 2 192.168.2.10');
    const apres = await r1.executeCommand('show ip route');

    expect(apres).toBe(avant);
  });

  it('et la table reste la meme apres DIX acheminements', async () => {
    const { r1, pc } = await labo();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end',
    ]);

    const avant = await r1.executeCommand('show ip route');
    for (let i = 0; i < 10; i++) await pc.executeCommand('ping -c 1 192.168.2.10');

    expect(await r1.executeCommand('show ip route')).toBe(avant);
  });
});

describe('la table reste coherente', () => {
  it('une route connectee reste connectee', async () => {
    const { r1 } = await labo();

    expect(await r1.executeCommand('show ip route')).toMatch(/C\s+192\.168\.1\.0/);
  });

  it('la route la plus SPECIFIQUE gagne', async () => {
    const { r1, pc } = await labo();
    await taper(r1, [
      'enable', 'configure terminal',
      'ip route 192.168.2.0 255.255.255.0 10.0.0.2',
      'ip route 192.168.2.10 255.255.255.255 10.0.0.2',
      'end',
    ]);

    expect(await pc.executeCommand('ping -c 1 192.168.2.10')).toMatch(/, 0% packet loss/);
  });
});
