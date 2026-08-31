import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Fw {
  executeCommand(command: string): Promise<string>;
  getIsPoweredOn(): boolean;
  powerOn(): void;
}

function fortigate(): Fw {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Fw;
  if (!fw.getIsPoweredOn()) fw.powerOn();
  return fw;
}

async function taper(fw: Fw, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await fw.executeCommand(ligne));
  return sorties;
}

async function multiVdom(fw: Fw): Promise<Fw> {
  await taper(fw, ['config system global', 'set vdom-mode multi-vdom', 'end']);
  return fw;
}

describe('le VDOM `root` existe, et `show vdom` le montre', () => {
  it('`show vdom` nomme `root`', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('show vdom')).toMatch(/edit "?root"?/);
  });

  it('et le bloc n est pas VIDE', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('show vdom');

    expect(vue.split('\n').filter(l => l.trim().length > 0).length)
      .toBeGreaterThan(2);
  });

  it('`get system status` annonce le meme vdom courant', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('get system status'))
      .toMatch(/Current virtual domain:\s*root/);
  });

  it('en multi-vdom aussi, `root` est la', async () => {
    const fw = await multiVdom(fortigate());

    expect(await fw.executeCommand('show vdom')).toMatch(/edit "?root"?/);
  });
});

describe('un VDOM cree rejoint `root` dans la vue', () => {
  async function avecVentes(): Promise<Fw> {
    const fw = await multiVdom(fortigate());
    await taper(fw, ['config vdom', 'edit "VENTES"', 'next', 'end']);
    return fw;
  }

  it('les deux paraissent', async () => {
    const fw = await avecVentes();
    const vue = await fw.executeCommand('show vdom');

    expect(vue).toMatch(/root/);
    expect(vue).toMatch(/VENTES/);
  });

  it('`root` vient en PREMIER — il preexiste', async () => {
    const fw = await avecVentes();
    const vue = await fw.executeCommand('show vdom');

    expect(vue).toMatch(/root/);
    expect(vue).toMatch(/VENTES/);
    expect(vue.indexOf('root')).toBeLessThan(vue.indexOf('VENTES'));
  });

  it('supprimer un VDOM cree le retire de la vue', async () => {
    const fw = await avecVentes();
    await taper(fw, ['config vdom', 'delete "VENTES"', 'end']);

    expect(await fw.executeCommand('show vdom')).not.toMatch(/VENTES/);
  });

  it('mais `root` survit — il ne se supprime pas', async () => {
    const fw = await avecVentes();
    await taper(fw, ['config vdom', 'delete "root"', 'end']);

    expect(await fw.executeCommand('show vdom')).toMatch(/root/);
  });
});

describe('`config vdom` est la vraie commande, pas `config system vdom`', () => {
  it('`config vdom` entre dans la table', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('config vdom')).not.toMatch(/Command fail/);
  });

  it('`edit root` y est accepte', async () => {
    const fw = fortigate();
    await fw.executeCommand('config vdom');

    expect(await fw.executeCommand('edit "root"')).not.toMatch(/Command fail/);
  });

  it('`show` complet contient le bloc des vdom', async () => {
    const fw = await multiVdom(fortigate());

    expect(await fw.executeCommand('show')).toMatch(/config vdom/);
  });
});
