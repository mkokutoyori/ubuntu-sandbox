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
  for (const c of ['system-view', 'acl number 2000',
    'rule 5 permit source 10.0.0.0 0.0.0.255', 'quit',
    'nat address-group 1 200.1.1.10 200.1.1.20',
    'interface GigabitEthernet0/0/0', 'undo shutdown',
    'ip address 10.0.0.1 255.255.255.0', ...cmds, 'quit', 'quit']) {
    await r.executeCommand(c);
  }
  return r;
}

const parInterface = async (r: HuaweiRouter) =>
  ((await r.executeCommand('display current-configuration interface GigabitEthernet0/0/0')) ?? '')
    .split('\n').map((l) => l.trim()).filter((l) => l && l !== '#');

const complete = async (r: HuaweiRouter) =>
  ((await r.executeCommand('display current-configuration')) ?? '')
    .split('\n').map((l) => l.trim());

describe('VRP — NAT, IPv6 et OSPFv3 reviennent d\'un export', () => {
  it('rend `nat outbound` sous ses trois formes', async () => {
    expect(await parInterface(await routeur(['nat outbound 2000'])))
      .toContain('nat outbound 2000');
    expect(await parInterface(await routeur(['nat outbound 2000 address-group 1'])))
      .toContain('nat outbound 2000 address-group 1');
    expect(await parInterface(await routeur(['nat outbound 2000 address-group 1 no-pat'])))
      .toContain('nat outbound 2000 address-group 1 no-pat');
  });

  it('rend `nat server` et le groupe d\'adresses qui le porte', async () => {
    const r = await routeur(['nat server protocol tcp global 200.1.1.1 80 inside 10.0.0.5 80']);
    expect(await parInterface(r))
      .toContain('nat server protocol tcp global 200.1.1.1 80 inside 10.0.0.5 80');
    expect(await complete(r)).toContain('nat address-group 1 200.1.1.10 200.1.1.20');
  });

  it('rend une adresse IPv6 statique, APRÈS `ipv6 enable`', async () => {
    const l = await parInterface(await routeur(['ipv6 enable', 'ipv6 address 2001:db8::1/64']));
    expect(l).toContain('ipv6 address 2001:db8::1/64');
    expect(l.indexOf('ipv6 enable')).toBeLessThan(l.indexOf('ipv6 address 2001:db8::1/64'));
  });

  it('ne rend pas une adresse de lien-local, que personne n\'a tapée', async () => {
    const l = await parInterface(await routeur(['ipv6 enable']));
    expect(l.filter((x) => x.startsWith('ipv6 address'))).toHaveLength(0);
  });

  it('rend l\'appartenance OSPFv3 de l\'interface', async () => {
    expect(await parInterface(await routeur([
      'ipv6 enable', 'ipv6 address 2001:db8::1/64', 'ospfv3 1 area 0',
    ]))).toContain('ospfv3 1 area 0');
  });

  it('n\'écrit rien tant qu\'aucun n\'est posé', async () => {
    const l = await parInterface(await routeur());
    expect(l.filter((x) => /^(nat |ipv6 |ospfv3 )/.test(x))).toHaveLength(0);
  });

  it('survit à un aller-retour export → import', async () => {
    const reglages = [
      'nat outbound 2000 address-group 1',
      'nat server protocol tcp global 200.1.1.1 80 inside 10.0.0.5 80',
      'ipv6 enable', 'ipv6 address 2001:db8::1/64',
    ];
    const r = await routeur(reglages);
    const texte = (await r.executeCommand('display current-configuration')) ?? '';
    const r2 = new HuaweiRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    const l = await parInterface(r2);
    for (const cmd of reglages) expect(l, cmd).toContain(cmd);
  });

  it('les deux vues disent la même chose', async () => {
    const r = await routeur(['nat outbound 2000', 'ipv6 enable', 'ipv6 address 2001:db8::1/64']);
    const complet = await complete(r);
    const debut = complet.indexOf('interface GigabitEthernet0/0/0');
    const bloc: string[] = [];
    for (let i = debut; i < complet.length; i++) {
      if (i > debut && (complet[i] === '#' || complet[i].startsWith('interface '))) break;
      if (complet[i]) bloc.push(complet[i]);
    }
    expect(await parInterface(r)).toEqual(bloc);
  });

  it('déclare une ACL et un groupe AVANT l\'interface qui les nomme', async () => {
    const l = await complete(await routeur([
      'nat outbound 2000 address-group 1', 'traffic-filter inbound acl 2000',
    ]));
    const acl = l.indexOf('acl number 2000');
    const groupe = l.findIndex((x) => x.startsWith('nat address-group 1'));
    const iface = l.indexOf('interface GigabitEthernet0/0/0');
    expect(acl).toBeGreaterThanOrEqual(0);
    expect(groupe).toBeGreaterThanOrEqual(0);
    expect(acl).toBeLessThan(iface);
    expect(groupe).toBeLessThan(iface);
  });

  it('refuse un réglage OSPFv3 par interface que ce moteur ne porte pas', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0']) await r.executeCommand(c);
    for (const cmd of ['ospfv3 cost 10', 'ospfv3 priority 5',
      'ospfv3 network-type p2p', 'ospfv3 authentication']) {
      expect(await r.executeCommand(cmd), cmd).toMatch(/^Error: /);
    }
  });
});
