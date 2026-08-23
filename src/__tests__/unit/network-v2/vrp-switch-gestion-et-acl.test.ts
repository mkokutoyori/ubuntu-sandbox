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
  for (const c of ['system-view', ...cmds, 'quit']) await sw.executeCommand(c);
  return sw;
}

const config = async (sw: HuaweiSwitch) =>
  ((await sw.executeCommand('display current-configuration')) ?? '')
    .split('\n').map((l) => l.trim());

const SNMP = [
  'snmp-agent community read public',
  'snmp-agent community write private',
  'snmp-agent sys-info version v2c',
  'snmp-agent sys-info location Salle-B',
];

describe('commutateur VRP — la gestion atteint enfin son magasin', () => {
  it('`snmp-agent community` retient la communauté, pas le mot-clé', async () => {
    const sw = await commutateur(['snmp-agent community read public']);
    const snmp = sw.getSnmpService();
    expect(snmp.getCommunities().map((c) => c.name)).toEqual(['public']);
    expect(snmp.getCommunities()[0]?.access).toBe('ro');
  });

  it('rend chaque ligne SNMP', async () => {
    const l = await config(await commutateur(SNMP));
    for (const cmd of SNMP) expect(l, cmd).toContain(cmd);
  });

  it('`stelnet server enable` et `telnet server enable` atteignent le service', async () => {
    const sw = await commutateur(['stelnet server enable', 'telnet server enable']);
    const mgmt = sw.getManagementService();
    expect(mgmt.getStelnet().enabled).toBe(true);
    expect(mgmt.getTelnet().enabled).toBe(true);
    const l = await config(sw);
    expect(l).toContain('stelnet server enable');
    expect(l).toContain('telnet server enable');
  });

  it('n\'écrit rien tant qu\'aucun service n\'est configuré', async () => {
    const l = await config(await commutateur());
    expect(l.filter((x) => /^(snmp-agent|stelnet|telnet server)/.test(x))).toHaveLength(0);
  });

  it('survit à un aller-retour export → import', async () => {
    const sw = await commutateur([...SNMP, 'stelnet server enable']);
    const texte = (await sw.executeCommand('display current-configuration')) ?? '';
    const sw2 = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    await replayVendorConfig(sw2, texte);
    const l = await config(sw2);
    for (const cmd of SNMP) expect(l, cmd).toContain(cmd);
    expect(l).toContain('stelnet server enable');
  });
});

describe('commutateur VRP — une liste d\'accès figure dans sa configuration', () => {
  const ACL = ['acl number 3000', 'rule 5 permit ip source 10.0.0.0 0.0.0.255', 'quit'];

  it('rend la liste et sa règle', async () => {
    const l = await config(await commutateur(ACL));
    expect(l).toContain('acl number 3000');
    expect(l).toContain('rule 5 permit ip source 10.0.0.0 0.0.0.255');
  });

  it('déclare la liste AVANT le port qui la filtre', async () => {
    const l = await config(await commutateur([
      ...ACL,
      'interface GigabitEthernet0/0/0', 'traffic-filter inbound acl 3000', 'quit',
    ]));
    expect(l.indexOf('acl number 3000'))
      .toBeLessThan(l.indexOf('interface GigabitEthernet0/0/0'));
  });

  it('n\'écrit rien tant qu\'aucune liste n\'existe', async () => {
    const l = await config(await commutateur());
    expect(l.filter((x) => x.startsWith('acl number'))).toHaveLength(0);
  });

  it('le filtre et sa liste survivent ensemble à un import', async () => {
    const sw = await commutateur([
      ...ACL,
      'interface GigabitEthernet0/0/0', 'traffic-filter inbound acl 3000', 'quit',
    ]);
    const texte = (await sw.executeCommand('display current-configuration')) ?? '';
    const sw2 = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    await replayVendorConfig(sw2, texte);
    const l = await config(sw2);
    expect(l).toContain('acl number 3000');
    expect(l).toContain('traffic-filter inbound acl 3000');
    expect(sw2.getVaclEngine().getInterfaceACL('GigabitEthernet0/0/0', 'in')).toBe(3000);
  });
});
