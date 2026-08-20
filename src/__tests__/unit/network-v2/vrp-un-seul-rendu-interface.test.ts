import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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
  for (const c of ['system-view', 'dhcp enable', 'acl number 3000',
    'rule 5 permit ip source 10.0.0.0 0.0.0.255', 'quit',
    'interface GigabitEthernet0/0/0', 'undo shutdown',
    'ip address 10.0.0.1 255.255.255.0', ...cmds, 'quit', 'quit']) {
    await r.executeCommand(c);
  }
  return r;
}

const parInterface = async (r: HuaweiRouter) =>
  ((await r.executeCommand('display current-configuration interface GigabitEthernet0/0/0')) ?? '')
    .split('\n').map((l) => l.trim()).filter((l) => l && l !== '#');

async function blocDansConfigComplete(r: HuaweiRouter) {
  const complet = ((await r.executeCommand('display current-configuration')) ?? '').split('\n');
  const debut = complet.findIndex((l) => l.trim() === 'interface GigabitEthernet0/0/0');
  const bloc: string[] = [];
  for (let i = debut; i < complet.length; i++) {
    if (i > debut && !/^\s/.test(complet[i])) break;
    const t = complet[i].trim();
    if (t && t !== '#') bloc.push(t);
  }
  return bloc;
}

const REGLAGES = [
  'traffic-filter inbound acl 3000',
  'dhcp select relay',
  'dhcp relay server-ip 10.9.0.5',
];

describe('VRP — un bloc d\'interface, un seul rendu', () => {
  it('les deux vues disent la même chose', async () => {
    const r = await routeur(REGLAGES);
    expect(await parInterface(r)).toEqual(await blocDansConfigComplete(r));
  });

  it('elles disent la même chose sur une interface nue, aussi', async () => {
    const r = await routeur();
    expect(await parInterface(r)).toEqual(await blocDansConfigComplete(r));
  });

  it('`traffic-filter` figure dans la vue par interface', async () => {
    expect(await parInterface(await routeur(['traffic-filter inbound acl 3000'])))
      .toContain('traffic-filter inbound acl 3000');
  });

  it('les trois modes de `dhcp select` se rendent', async () => {
    for (const mode of ['global', 'relay', 'interface']) {
      expect(await parInterface(await routeur([`dhcp select ${mode}`])), mode)
        .toContain(`dhcp select ${mode}`);
    }
  });

  it('n\'écrit aucun `dhcp select` tant qu\'aucun n\'est posé', async () => {
    const l = await parInterface(await routeur());
    expect(l.filter((x) => x.startsWith('dhcp select'))).toHaveLength(0);
  });

  it('`dhcp select global` vit sur la machine, pas sur la session', async () => {
    const r = await routeur(['dhcp select global']);
    const autre = r.createVtyShell?.();
    if (autre) {
      const vue = ((autre.execute?.('display current-configuration') as string) ?? '');
      expect(vue).toContain('dhcp select global');
    }
    expect(await parInterface(r)).toContain('dhcp select global');
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeur(REGLAGES);
    const texte = (await r.executeCommand('display current-configuration')) ?? '';
    const r2 = new HuaweiRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    const l = await parInterface(r2);
    for (const cmd of REGLAGES) expect(l, cmd).toContain(cmd);
  });
});
