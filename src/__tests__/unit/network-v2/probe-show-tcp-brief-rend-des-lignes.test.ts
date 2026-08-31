import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
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

async function taper(d: Cli, lignes: readonly string[]): Promise<void> {
  for (const ligne of lignes) await d.executeCommand(ligne);
}

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  const [a] = r.getPortNames();
  await taper(r, [
    'enable', 'configure terminal',
    `interface ${a}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 1024',
    'line vty 0 4', 'transport input all', 'login local', 'exit',
    'username admin privilege 15 secret cisco',
    'end',
  ]);
  return r;
}

const LIGNES = (vue: string): string[] =>
  vue.split('\n').filter(l => l.trim().length > 0);

describe('`show tcp brief` montre les ECOUTEURS que la machine porte', () => {
  it('la vue ne se limite plus a son en-tete', async () => {
    const r = await routeur();

    expect(LIGNES(await r.executeCommand('show tcp brief')).length)
      .toBeGreaterThan(1);
  });

  it('l en-tete reste celui d IOS', async () => {
    const r = await routeur();

    expect(LIGNES(await r.executeCommand('show tcp brief'))[0])
      .toBe('TCB       Local Address           Foreign Address        (state)');
  });

  it('le port SSH 22 y figure', async () => {
    const r = await routeur();

    expect(await r.executeCommand('show tcp brief')).toMatch(/\.22\b/);
  });

  it('un ecouteur est dans l etat LISTEN', async () => {
    const r = await routeur();

    expect(await r.executeCommand('show tcp brief')).toMatch(/LISTEN/);
  });

  it('le TCB est un identifiant hexadecimal', async () => {
    const r = await routeur();
    const lignes = LIGNES(await r.executeCommand('show tcp brief')).slice(1);

    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.every(l => /^[0-9A-F]{8}\s/.test(l))).toBe(true);
  });

  it('l adresse porte son port apres un POINT, comme IOS', async () => {
    const r = await routeur();
    const lignes = LIGNES(await r.executeCommand('show tcp brief')).slice(1);

    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.every(l => /[\d*]+\.[\d*]+/.test(l))).toBe(true);
  });
});

describe('une connexion ETABLIE y parait aussi', () => {
  async function avecSession(): Promise<Cli> {
    const r = await routeur();
    const pc = new LinuxPC('linux-pc', 'PC1', 400, 0);
    pc.powerOn();
    new Cable('lien').connect(
      r.getPort(r.getPortNames()[0]) as never, pc.getPort('eth0') as never);
    await taper(pc as unknown as Cli, [
      'ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0',
    ]);
    (pc as unknown as {
      getTcpStack(): { connect(ip: string, port: number): unknown };
    }).getTcpStack().connect('10.0.0.1', 22);
    return r;
  }

  it('l adresse du pair figure dans la colonne distante', async () => {
    const r = await avecSession();

    expect(await r.executeCommand('show tcp brief')).toMatch(/10\.0\.0\.10\./);
  });

  it('et son etat n est pas LISTEN', async () => {
    const r = await avecSession();
    const ligne = LIGNES(await r.executeCommand('show tcp brief'))
      .find(l => l.includes('10.0.0.10.'));

    expect(ligne).toBeDefined();
    expect(ligne).not.toMatch(/LISTEN/);
  });
});

describe('`show tcp brief` sur un equipement SANS ecouteur', () => {
  it('rend son en-tete et rien d autre', async () => {
    const r = new CiscoRouter('R2', 0, 0) as unknown as Cli;
    r.powerOn();
    await r.executeCommand('enable');
    const vue = await r.executeCommand('show tcp brief');

    expect(LIGNES(vue)[0]).toMatch(/^TCB/);
  });
});
