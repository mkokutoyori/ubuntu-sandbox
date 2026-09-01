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
    'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'end',
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
  'ip policy route-map PBR',
  'ip directed-broadcast',
  'ip tcp adjust-mss 1360',
  'ip accounting',
  'ip dhcp relay information trusted',
  'ip dhcp snooping trust',
  'ip dhcp snooping limit rate 15',
  'ip rip v2-broadcast',
  'ip nbar protocol-discovery',
  'ipv6 dhcp server POOL1',
  'ipv6 dhcp relay destination 2001:db8::1',
  'fair-queue 64 256 0',
  'random-detect',
  'max-reserved-bandwidth 85',
  'priority-group 3',
  'custom-queue-list 7',
  'tx-ring-limit 12',
];

describe('running-config — les réglages d\'interface hérités y figurent', () => {
  it('n\'écrit rien pour une interface qui n\'en porte aucun', async () => {
    const cfg = await sectionIface(await routeur());
    for (const ligne of REGLAGES) {
      expect(cfg).not.toContain(ligne.split(' ').slice(0, 2).join(' '));
    }
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
  });

  it('accepte plusieurs destinations de relais DHCPv6', async () => {
    const r = await routeur();
    await surIface(r, [
      'ipv6 dhcp relay destination 2001:db8::1',
      'ipv6 dhcp relay destination 2001:db8::2',
    ]);
    const cfg = await sectionIface(r);
    expect(cfg).toContain('ipv6 dhcp relay destination 2001:db8::1');
    expect(cfg).toContain('ipv6 dhcp relay destination 2001:db8::2');
  });

  it('rend `ip route-cache flow` sous la forme moderne d\'IOS', async () => {
    const r = await routeur();
    await surIface(r, ['ip route-cache flow']);
    expect(await sectionIface(r)).toContain('ip flow ingress');
  });

  it('rend les résumés RIP et EIGRP posés sur le port', async () => {
    const r = await routeur();
    await surIface(r, [
      'ip summary-address rip 10.1.0.0 255.255.0.0',
      'ip summary-address eigrp 100 172.16.0.0 255.255.0.0',
      'ip hello-interval eigrp 100 10',
    ]);
    const cfg = await sectionIface(r);
    expect(cfg).toContain('ip summary-address rip 10.1.0.0 255.255.0.0');
    expect(cfg).toContain('ip summary-address eigrp 100 172.16.0.0 255.255.0.0');
    expect(cfg).toContain('ip hello-interval eigrp 100 10');
  });

  it('`no ip summary-address eigrp` retire le résumé nommé et lui seul', async () => {
    const r = await routeur();
    await surIface(r, [
      'ip summary-address eigrp 100 172.16.0.0 255.255.0.0',
      'ip summary-address eigrp 100 192.168.0.0 255.255.0.0',
      'no ip summary-address eigrp 100 172.16.0.0 255.255.0.0',
    ]);
    const cfg = await sectionIface(r);
    expect(cfg).not.toContain('172.16.0.0');
    expect(cfg).toContain('ip summary-address eigrp 100 192.168.0.0 255.255.0.0');
  });

  it('le mode echo étant ACTIF par défaut, seul `no bfd echo` s\'écrit', async () => {
    const r = await routeur();
    await surIface(r, ['bfd echo']);
    expect(await sectionIface(r)).not.toContain('bfd echo');
    await surIface(r, ['no bfd echo']);
    expect(await sectionIface(r)).toContain('no bfd echo');
    await surIface(r, ['bfd echo']);
    expect(await sectionIface(r)).not.toContain('bfd echo');
  });
});
