import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

async function routeur() {
  const r = new CiscoRouter('R', 0, 0);
  for (const c of [
    'enable', 'configure terminal', 'interface GigabitEthernet0/1',
    'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1', 'network 10.0.0.0 0.0.0.3 area 0', 'end',
  ]) await r.executeCommand(c);
  return r;
}

const surIface = async (r: CiscoRouter, cmds: string[]) => {
  for (const c of ['configure terminal', 'interface GigabitEthernet0/1', ...cmds, 'end']) {
    await r.executeCommand(c);
  }
};

const sectionIface = (r: CiscoRouter) =>
  r.executeCommand('show running-config | section GigabitEthernet0/1');

const REGLAGES = [
  'ip pim sparse-mode', 'ip pim dr-priority 50',
  'ip ospf cost 42', 'ip ospf priority 7', 'ip ospf hello-interval 5',
  'ip ospf dead-interval 20', 'ip ospf network point-to-point',
  'ip ospf authentication message-digest', 'ip ospf mtu-ignore',
  'ip ospf retransmit-interval 9', 'ip ospf transmit-delay 3',
];

describe('running-config — les réglages PIM et OSPF d\'interface y figurent', () => {
  it('n\'écrit rien pour une interface qui n\'en porte aucun', async () => {
    const cfg = await sectionIface(await routeur());
    expect(cfg).not.toContain('ip pim');
    expect(cfg).not.toContain('ip ospf');
  });

  it('rend chaque réglage posé', async () => {
    const r = await routeur();
    await surIface(r, REGLAGES);
    const cfg = await sectionIface(r);
    for (const ligne of REGLAGES) expect(cfg).toContain(ligne);
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeur();
    await surIface(r, REGLAGES);
    const avant = await sectionIface(r);

    const complet = await r.executeCommand('show running-config');
    const r2 = await routeur();
    await replayVendorConfig(r2, complet);

    expect(await sectionIface(r2)).toBe(avant);
    expect(await r2.executeCommand('show ip pim interface')).toMatch(/GigabitEthernet0\/1.*v2\/sparse/);
  });

  it('ne rend pas un réglage revenu à son défaut', async () => {
    const r = await routeur();
    await surIface(r, REGLAGES);
    await surIface(r, [
      'no ip pim sparse-mode', 'no ip ospf cost', 'no ip ospf priority',
      'no ip ospf hello-interval', 'no ip ospf dead-interval', 'no ip ospf network',
      'no ip ospf authentication', 'no ip ospf mtu-ignore',
      'no ip ospf retransmit-interval', 'no ip ospf transmit-delay',
    ]);
    const cfg = await sectionIface(r);
    expect(cfg).not.toContain('ip pim sparse-mode');
    expect(cfg).not.toContain('ip ospf cost');
    expect(cfg).not.toContain('ip ospf priority');
    expect(cfg).not.toContain('ip ospf hello-interval');
    expect(cfg).not.toContain('ip ospf network');
    expect(cfg).not.toContain('ip ospf authentication');
    expect(cfg).not.toContain('ip ospf mtu-ignore');
  });
});
