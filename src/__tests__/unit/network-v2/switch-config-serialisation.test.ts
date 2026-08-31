import { describe, it, expect, beforeEach } from 'vitest';
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

async function commutateur(cmds: string[] = []) {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit', ...cmds, 'end']) {
    await sw.executeCommand(c);
  }
  return sw;
}

const lignes = async (sw: CiscoSwitch) =>
  ((await sw.executeCommand('show running-config')) ?? '').split('\n').map((l) => l.trim());

const section = async (sw: CiscoSwitch, iface: string) =>
  ((await sw.executeCommand(`show running-config | section ${iface}`)) ?? '')
    .split('\n').map((l) => l.trim()).filter((l) => l && l !== '!');

const surPort = (cmds: string[]) => ['interface FastEthernet0/1', ...cmds, 'exit'];

const GLOBAL = [
  'spanning-tree mode rapid-pvst',
  'spanning-tree vlan 10 priority 4096',
  'mac address-table aging-time 600',
  'mac address-table static 0011.2233.4455 vlan 1 interface FastEthernet0/1',
  'ip dhcp snooping',
  'ip dhcp snooping vlan 10',
  'no ip dhcp snooping verify mac-address',
  'lacp system-priority 100',
  'udld enable',
  'dot1x system-auth-control',
  'ip routing',
];

const PORT = [
  'mtu 1600',
  'channel-group 1 mode active',
  'lacp port-priority 100',
  'ip dhcp snooping trust',
  'ip dhcp snooping limit rate 20',
  'dot1x pae authenticator',
  'dot1x port-control auto',
];

describe('commutateur — la configuration globale reproduit ce qui a été tapé', () => {
  it('rend chaque réglage global', async () => {
    const l = await lignes(await commutateur(GLOBAL));
    for (const cmd of GLOBAL) expect(l, cmd).toContain(cmd);
  });

  it('n\'écrit rien tant qu\'aucun n\'est posé', async () => {
    const l = await lignes(await commutateur());
    for (const cmd of GLOBAL) expect(l, cmd).not.toContain(cmd);
  });

  it('survit à un aller-retour export → import', async () => {
    const sw = await commutateur(GLOBAL);
    const texte = (await sw.executeCommand('show running-config')) ?? '';
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await replayVendorConfig(sw2, texte);
    const l = await lignes(sw2);
    for (const cmd of GLOBAL) expect(l, cmd).toContain(cmd);
  });

  it('`root primary` se rend en priorité, comme IOS le fait', async () => {
    const l = await lignes(await commutateur(['spanning-tree vlan 10 root primary']));
    expect(l).toContain('spanning-tree vlan 10 priority 24576');
    expect(l).not.toContain('spanning-tree vlan 10 root primary');
  });

  it('rend la région MST au complet', async () => {
    const l = await lignes(await commutateur([
      'spanning-tree mst configuration', 'name REGION', 'revision 3',
      'instance 1 vlan 10', 'exit',
    ]));
    expect(l).toContain('spanning-tree mst configuration');
    expect(l).toContain('name REGION');
    expect(l).toContain('revision 3');
    expect(l).toContain('instance 1 vlan 10');
  });

  it('une instance MST retient la liste de VLAN, pas le mot-clé', async () => {
    const sw = await commutateur([
      'spanning-tree mst configuration', 'name REGION', 'instance 1 vlan 10', 'exit',
    ]);
    const vue = (await sw.executeCommand('show spanning-tree mst configuration')) ?? '';
    expect(vue).toMatch(/^1\s+10$/m);
  });

  it('rend une session SPAN complète', async () => {
    const l = await lignes(await commutateur([
      'monitor session 1 source interface FastEthernet0/1',
      'monitor session 1 destination interface FastEthernet0/2',
    ]));
    expect(l).toContain('monitor session 1 source interface FastEthernet0/1');
    expect(l).toContain('monitor session 1 destination interface FastEthernet0/2');
  });

  it('rend une carte d\'accès VLAN', async () => {
    const l = await lignes(await commutateur(['vlan access-map VAM 10', 'action drop', 'exit']));
    expect(l).toContain('vlan access-map VAM 10');
    expect(l).toContain('action drop');
  });
});

describe('commutateur — la configuration de port reproduit ce qui a été tapé', () => {
  it('rend chaque réglage de port', async () => {
    const s = await section(await commutateur(surPort(PORT)), 'FastEthernet0/1');
    for (const cmd of PORT) expect(s, cmd).toContain(cmd);
  });

  it('n\'écrit rien tant qu\'aucun n\'est posé', async () => {
    const s = await section(await commutateur(), 'FastEthernet0/1');
    expect(s).toEqual(['interface FastEthernet0/1']);
  });

  it('survit à un aller-retour export → import', async () => {
    const sw = await commutateur(surPort(PORT));
    const texte = (await sw.executeCommand('show running-config')) ?? '';
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await replayVendorConfig(sw2, texte);
    const s = await section(sw2, 'FastEthernet0/1');
    for (const cmd of PORT) expect(s, cmd).toContain(cmd);
  });

  it('rend le tunnel de protocole L2 sur un port dot1q-tunnel', async () => {
    const s = await section(await commutateur(surPort([
      'switchport mode dot1q-tunnel', 'l2protocol-tunnel cdp', 'l2protocol-tunnel stp',
    ])), 'FastEthernet0/1');
    expect(s).toContain('l2protocol-tunnel cdp');
    expect(s).toContain('l2protocol-tunnel stp');
  });

  it('`udld enable` global n\'écrit aucune ligne par port', async () => {
    const sw = await commutateur(['udld enable']);
    const l = await lignes(sw);
    expect(l).toContain('udld enable');
    expect(l.filter((x) => x === 'udld port')).toHaveLength(0);
  });

  it('un port qui diverge du mode global garde sa propre ligne', async () => {
    const s = await section(await commutateur([
      'udld enable', ...surPort(['udld port aggressive']),
    ]), 'FastEthernet0/1');
    expect(s).toContain('udld port aggressive');
  });
});
