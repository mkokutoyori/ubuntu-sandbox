import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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
  const r = new CiscoRouter('R', 0, 0);
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const c of cmds) await r.executeCommand(c);
  await r.executeCommand('end');
  return r;
}

const config = async (r: CiscoRouter) =>
  ((await r.executeCommand('show running-config')) ?? '')
    .split('\n').map((l) => l.trim());

const DURCISSEMENT = [
  'no ip source-route',
  'no ip bootp server',
  'no ip gratuitous-arps',
];

describe('durcissement global — la configuration reproduit ce qui a été tapé', () => {
  it('rend chaque négation sous l\'orthographe d\'IOS', async () => {
    const lignes = await config(await routeur(DURCISSEMENT));
    for (const cmd of DURCISSEMENT) expect(lignes).toContain(cmd);
  });

  it('n\'écrit aucune ligne `service` pour ces trois commandes', async () => {
    const lignes = await config(await routeur(DURCISSEMENT));
    for (const nom of ['bootp-server', 'gratuitous-arps', 'finger']) {
      expect(lignes).not.toContain(`no service ${nom}`);
    }
  });

  it('n\'écrit rien tant que les valeurs sont celles d\'IOS', async () => {
    const lignes = await config(await routeur());
    for (const cmd of [...DURCISSEMENT, 'ip finger']) expect(lignes).not.toContain(cmd);
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeur(DURCISSEMENT);
    const texte = (await r.executeCommand('show running-config')) ?? '';
    const r2 = new CiscoRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    const lignes = await config(r2);
    for (const cmd of DURCISSEMENT) expect(lignes).toContain(cmd);
  });

  it('chaque négation se rétracte par sa forme positive', async () => {
    const lignes = await config(await routeur([
      ...DURCISSEMENT,
      'ip source-route', 'ip bootp server', 'ip gratuitous-arps',
    ]));
    for (const cmd of DURCISSEMENT) expect(lignes).not.toContain(cmd);
  });

  it('`ip finger` est désactivé par défaut, donc seule sa présence se rend', async () => {
    expect(await config(await routeur(['no ip finger']))).not.toContain('ip finger');
    expect(await config(await routeur(['ip finger']))).toContain('ip finger');
  });

  it('un commutateur accepte et rend le même durcissement', async () => {
    const sw = new CiscoSwitch('SW', 0, 0);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    for (const c of DURCISSEMENT) {
      expect(await sw.executeCommand(c), c).not.toMatch(/Invalid input/);
    }
    await sw.executeCommand('end');
    const lignes = ((await sw.executeCommand('show running-config')) ?? '')
      .split('\n').map((l) => l.trim());
    for (const cmd of DURCISSEMENT) expect(lignes).toContain(cmd);
  });

  it('`service finger` et `ip finger` sont un seul fait', async () => {
    expect(await config(await routeur(['service finger']))).toContain('ip finger');
    expect(await config(await routeur(['ip finger', 'no service finger'])))
      .not.toContain('ip finger');
    expect(await config(await routeur(['service finger', 'no ip finger'])))
      .not.toContain('ip finger');
  });
});
