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
  for (const c of ['system-view', 'interface GigabitEthernet0/0/0', 'undo shutdown',
    'ip address 10.0.0.1 255.255.255.0', ...cmds, 'quit', 'quit']) {
    await r.executeCommand(c);
  }
  return r;
}

const section = async (r: HuaweiRouter) =>
  ((await r.executeCommand('display current-configuration interface GigabitEthernet0/0/0')) ?? '')
    .split('\n').map((l) => l.trim()).filter((l) => l && l !== '#');

const REGLAGES = [
  'ospf cost 50',
  'ospf dr-priority 100',
  'ospf timer hello 5',
  'ospf timer dead 20',
  'ospf network-type p2p',
  'ospf authentication-mode md5 1 cipher Huawei@123',
  'rip version 2 multicast',
  'rip authentication-mode simple cipher Huawei@123',
  'rip summary-address 10.0.0.0 255.255.0.0',
  'speed 100',
  'duplex full',
];

describe('VRP — la configuration d\'interface reproduit ce qui a été tapé', () => {
  it('rend chaque réglage', async () => {
    const s = await section(await routeur(REGLAGES));
    for (const cmd of REGLAGES) expect(s, cmd).toContain(cmd);
  });

  it('n\'écrit rien tant qu\'aucun n\'est posé', async () => {
    const s = await section(await routeur());
    expect(s).toEqual([
      'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.1 255.255.255.0',
    ]);
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeur(REGLAGES);
    const texte = (await r.executeCommand('display current-configuration')) ?? '';
    const r2 = new HuaweiRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    const s = await section(r2);
    for (const cmd of REGLAGES) expect(s, cmd).toContain(cmd);
  });

  it('ne rend pas une valeur qui est celle de VRP par défaut', async () => {
    const s = await section(await routeur([
      'ospf dr-priority 1', 'ospf timer hello 10', 'ospf timer dead 40',
      'ospf network-type broadcast',
    ]));
    expect(s.filter((l) => l.startsWith('ospf '))).toHaveLength(0);
  });

  it('`authentication-mode simple cipher <clé>` retient la CLÉ, pas le mot-clé', async () => {
    const s = await section(await routeur(['ospf authentication-mode simple cipher Huawei@123']));
    expect(s).toContain('ospf authentication-mode simple cipher Huawei@123');
    expect(s).not.toContain('ospf authentication-mode simple cipher cipher');
  });

  it('`rip version` distingue diffusion et multidiffusion', async () => {
    expect(await section(await routeur(['rip version 2 broadcast'])))
      .toContain('rip version 2 broadcast');
    expect(await section(await routeur(['rip version 1']))).toContain('rip version 1');
  });

  it('chaque réglage se retire par sa forme `undo`', async () => {
    const s = await section(await routeur([
      'rip version 2 multicast', 'rip authentication-mode simple cipher Huawei@123',
      'undo rip version', 'undo rip authentication-mode',
    ]));
    expect(s.filter((l) => l.startsWith('rip '))).toHaveLength(0);
  });

  it('`speed`/`duplex` coupent vraiment la négociation', async () => {
    const r = await routeur(['speed 100', 'duplex full']);
    const port = r.getPort('GE0/0/0')!;
    expect(port.isNegotiationAuto()).toBe(false);
    expect(port.getSpeed()).toBe(100);
    expect(port.getDuplex()).toBe('full');
  });

  it('`speed auto` rend la négociation et efface les deux lignes', async () => {
    const s = await section(await routeur(['speed 100', 'duplex full', 'speed auto']));
    expect(s.filter((l) => l.startsWith('speed ') || l.startsWith('duplex '))).toHaveLength(0);
  });

  it('refuse une valeur que la machine ne connaît pas', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0']) await r.executeCommand(c);
    expect(await r.executeCommand('speed 42')).toMatch(/Wrong parameter/);
    expect(await r.executeCommand('duplex zorglub')).toMatch(/Wrong parameter/);
    expect(await r.executeCommand('ospf authentication-mode zorglub')).toMatch(/Wrong parameter/);
  });

  it('refuse ce que ce simulateur ne peut pas évaluer, en nommant la brique absente', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0']) await r.executeCommand(c);
    for (const cmd of ['rip metricin 2', 'rip poison-reverse', 'ospf mtu-enable']) {
      expect(await r.executeCommand(cmd), cmd).toMatch(/^Error: /);
    }
    await r.executeCommand('quit');
    await r.executeCommand('quit');
    const s = await section(r);
    expect(s.filter((l) => /metricin|poison-reverse|mtu-enable/.test(l))).toHaveLength(0);
  });
});
