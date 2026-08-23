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
  for (const c of ['system-view', ...cmds, 'quit']) await r.executeCommand(c);
  return r;
}

const config = async (r: HuaweiRouter) =>
  ((await r.executeCommand('display current-configuration')) ?? '')
    .split('\n').map((l) => l.trim());

const SNMP = [
  'snmp-agent community read public',
  'snmp-agent community write private',
  'snmp-agent sys-info version v2c',
  'snmp-agent sys-info contact admin@lab',
  'snmp-agent sys-info location Salle-B',
];

describe('VRP — le SNMP revient d\'un export, et sa communauté est la bonne', () => {
  it('rend chaque ligne sous l\'orthographe de VRP', async () => {
    const l = await config(await routeur(SNMP));
    for (const cmd of SNMP) expect(l, cmd).toContain(cmd);
  });

  it('retient la COMMUNAUTÉ, pas le mot-clé qui la précède', async () => {
    const r = await routeur(['snmp-agent community read public']);
    const snmp = r.getSnmpService();
    expect(snmp.getCommunities().map((c) => c.name)).toEqual(['public']);
    expect(snmp.getCommunities()[0]?.access).toBe('ro');
  });

  it('distingue lecture et écriture', async () => {
    const r = await routeur(['snmp-agent community write private']);
    expect(r.getSnmpService().getCommunities().find((c) => c.name === 'private')?.access).toBe('rw');
  });

  it('n\'écrit qu\'une fois chaque ligne', async () => {
    const l = await config(await routeur(SNMP));
    for (const cmd of SNMP) {
      expect(l.filter((x) => x === cmd), cmd).toHaveLength(1);
    }
  });

  it('`snmp-agent` seul active l\'agent et se rend', async () => {
    const r = await routeur(['snmp-agent']);
    expect(r.getSnmpService().isEnabled()).toBe(true);
    expect(await config(r)).toContain('snmp-agent');
  });

  it('n\'écrit rien tant que l\'agent n\'est pas activé', async () => {
    const l = await config(await routeur());
    expect(l.filter((x) => x.startsWith('snmp-agent'))).toHaveLength(0);
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeur(SNMP);
    const texte = (await r.executeCommand('display current-configuration')) ?? '';
    const r2 = new HuaweiRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    const l = await config(r2);
    for (const cmd of SNMP) expect(l, cmd).toContain(cmd);
  });
});

describe('VRP — la politique de routage revient d\'un export', () => {
  it('rend une liste de préfixes', async () => {
    expect(await config(await routeur(['ip ip-prefix PL index 10 permit 10.0.0.0 8'])))
      .toContain('ip ip-prefix PL index 10 permit 10.0.0.0 8');
  });

  it('rend une route-policy et sa condition', async () => {
    const l = await config(await routeur([
      'ip ip-prefix PL index 10 permit 10.0.0.0 8',
      'route-policy RP permit node 10', 'if-match ip-prefix PL', 'quit',
    ]));
    expect(l).toContain('route-policy RP permit node 10');
    expect(l).toContain('if-match ip-prefix PL');
  });

  it('déclare la liste de préfixes AVANT la politique qui la nomme', async () => {
    const l = await config(await routeur([
      'ip ip-prefix PL index 10 permit 10.0.0.0 8',
      'route-policy RP permit node 10', 'if-match ip-prefix PL', 'quit',
    ]));
    expect(l.findIndex((x) => x.startsWith('ip ip-prefix PL')))
      .toBeLessThan(l.indexOf('route-policy RP permit node 10'));
  });

  it('rend les trois pièces d\'une politique de trafic', async () => {
    const l = await config(await routeur([
      'traffic classifier C1', 'quit', 'traffic behavior B1', 'quit',
      'traffic policy P1', 'quit',
    ]));
    expect(l.some((x) => x.startsWith('traffic classifier C1'))).toBe(true);
    expect(l).toContain('traffic behavior B1');
    expect(l).toContain('traffic policy P1');
  });

  it('n\'écrit rien tant qu\'aucune n\'est déclarée', async () => {
    const l = await config(await routeur());
    expect(l.filter((x) => /^(ip ip-prefix|route-policy|traffic )/.test(x))).toHaveLength(0);
  });

  it('survit à un aller-retour export → import', async () => {
    const reglages = ['ip ip-prefix PL index 10 permit 10.0.0.0 8'];
    const r = await routeur(reglages);
    const texte = (await r.executeCommand('display current-configuration')) ?? '';
    const r2 = new HuaweiRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    expect(await config(r2)).toContain(reglages[0]);
  });
});
