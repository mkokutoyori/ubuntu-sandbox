import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

async function commutateur(cmds: string[] = []) {
  const sw = new HuaweiSwitch('switch-huawei', 'SW', 8);
  for (const c of ['system-view', 'vlan batch 10 20 30 99 150', 'dhcp enable',
    'acl number 3000', 'rule 5 permit ip source 10.0.0.0 0.0.0.255', 'quit',
    'interface GigabitEthernet0/0/0', ...cmds, 'quit', 'quit']) {
    await sw.executeCommand(c);
  }
  return sw;
}

const parInterface = async (sw: HuaweiSwitch) =>
  ((await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/0')) ?? '')
    .split('\n').map((l) => l.trim()).filter((l) => l && l !== '#');

async function blocDansConfigComplete(sw: HuaweiSwitch) {
  const complet = ((await sw.executeCommand('display current-configuration')) ?? '').split('\n');
  const debut = complet.findIndex((l) => l.trim() === 'interface GigabitEthernet0/0/0');
  const bloc: string[] = [];
  for (let i = debut; i < complet.length; i++) {
    if (i > debut && (!/^\s/.test(complet[i]) || complet[i].trim() === '#')) break;
    if (complet[i].trim()) bloc.push(complet[i].trim());
  }
  return bloc;
}

const REGLAGES = [
  'stp edged-port enable',
  'stp cost 100',
  'port-security enable',
  'port-security max-mac-num 3',
  'mac-limit maximum 5',
  'dhcp snooping enable',
  'dhcp snooping trusted',
  'traffic-filter inbound acl 3000',
  'storm-control broadcast min-rate 100 max-rate 200',
  'loopback-detect enable',
];

describe('commutateur VRP — un bloc d\'interface, un seul rendu', () => {
  it('les deux vues disent la même chose', async () => {
    const sw = await commutateur(REGLAGES);
    expect(await parInterface(sw)).toEqual(await blocDansConfigComplete(sw));
  });

  it('elles disent la même chose sur un port nu, aussi', async () => {
    const sw = await commutateur();
    expect(await parInterface(sw)).toEqual(await blocDansConfigComplete(sw));
  });

  it('rend chaque réglage dans la configuration complète', async () => {
    const bloc = await blocDansConfigComplete(await commutateur(REGLAGES));
    for (const cmd of REGLAGES) expect(bloc, cmd).toContain(cmd);
  });

  it('survit à un aller-retour export → import', async () => {
    const sw = await commutateur(REGLAGES);
    const texte = (await sw.executeCommand('display current-configuration')) ?? '';
    const sw2 = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    await replayVendorConfig(sw2, texte);
    const bloc = await blocDansConfigComplete(sw2);
    for (const cmd of REGLAGES) expect(bloc, cmd).toContain(cmd);
  });
});

describe('commutateur VRP — un port hybride se décrit comme hybride', () => {
  const HYBRIDE = ['port link-type hybrid', 'port hybrid pvid vlan 30',
    'port hybrid tagged vlan 10', 'port hybrid untagged vlan 20'];

  it('ne se décrit plus comme un port d\'accès', async () => {
    const bloc = await blocDansConfigComplete(await commutateur(HYBRIDE));
    expect(bloc).toContain('port link-type hybrid');
    expect(bloc).not.toContain('port link-type access');
  });

  it('rend son PVID et ses deux listes de VLAN', async () => {
    const bloc = await blocDansConfigComplete(await commutateur(HYBRIDE));
    expect(bloc).toContain('port hybrid pvid vlan 30');
    expect(bloc).toContain('port hybrid tagged vlan 10');
    expect(bloc.some((l) => l.startsWith('port hybrid untagged vlan'))).toBe(true);
  });

  it('n\'écrit chaque ligne qu\'une fois', async () => {
    const bloc = await blocDansConfigComplete(await commutateur(HYBRIDE));
    for (const l of ['port link-type hybrid', 'port hybrid pvid vlan 30']) {
      expect(bloc.filter((x) => x === l), l).toHaveLength(1);
    }
  });

  it('survit à un aller-retour export → import', async () => {
    const sw = await commutateur(HYBRIDE);
    const texte = (await sw.executeCommand('display current-configuration')) ?? '';
    const sw2 = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    await replayVendorConfig(sw2, texte);
    expect(sw2.getSwitchportConfig('GigabitEthernet0/0/0')?.mode).toBe('hybrid');
  });
});

describe('commutateur VRP — `speed`/`duplex`/`mtu` posent vraiment le port', () => {
  it('la machine ne contredit plus sa propre configuration', async () => {
    const sw = await commutateur(['speed 100', 'duplex full', 'mtu 9000']);
    const port = sw.getPort('GigabitEthernet0/0/0')!;
    expect(port.getSpeed()).toBe(100);
    expect(port.getDuplex()).toBe('full');
    expect(port.getMTU()).toBe(9000);
    expect(port.isNegotiationAuto()).toBe(false);
    const bloc = await blocDansConfigComplete(sw);
    expect(bloc).toContain('speed 100');
    expect(bloc).toContain('duplex full');
    expect(bloc).toContain('mtu 9000');
  });

  it('`speed auto` rend la négociation et efface les lignes', async () => {
    const sw = await commutateur(['speed 100', 'speed auto']);
    expect(sw.getPort('GigabitEthernet0/0/0')!.isNegotiationAuto()).toBe(true);
    const bloc = await blocDansConfigComplete(sw);
    expect(bloc.filter((l) => /^(speed|duplex) /.test(l))).toHaveLength(0);
  });

  it('refuse une valeur que le port ne connaît pas', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW', 8);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0']) await sw.executeCommand(c);
    for (const cmd of ['speed 42', 'duplex zorglub', 'mtu zorglub']) {
      expect(await sw.executeCommand(cmd), cmd).toMatch(/Wrong parameter/);
    }
    expect(sw.getPort('GigabitEthernet0/0/0')!.getSpeed()).toBe(1000);
  });
});

describe('commutateur VRP — LLDP se rend sous l\'orthographe de VRP', () => {
  it('rend `lldp enable` en vue système', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW', 8);
    for (const c of ['system-view', 'lldp enable', 'quit']) await sw.executeCommand(c);
    const l = ((await sw.executeCommand('display current-configuration')) ?? '')
      .split('\n').map((x) => x.trim());
    expect(l).toContain('lldp enable');
    expect(l).not.toContain('lldp run');
  });

  it('n\'écrit rien tant que LLDP n\'est pas activé', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW', 8);
    const l = ((await sw.executeCommand('display current-configuration')) ?? '')
      .split('\n').map((x) => x.trim());
    expect(l.filter((x) => x.startsWith('lldp'))).toHaveLength(0);
  });
});
