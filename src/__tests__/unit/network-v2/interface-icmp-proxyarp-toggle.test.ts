import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

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

const vue = (r: CiscoRouter) => r.executeCommand('show ip interface GigabitEthernet0/1');
const cfg = (r: CiscoRouter) => r.executeCommand('show running-config | section GigabitEthernet0/1');

const CAS = [
  { nom: 'redirects', off: 'no ip redirects', on: 'ip redirects', actif: 'ICMP redirects are always sent', eteint: 'ICMP redirects are never sent' },
  { nom: 'unreachables', off: 'no ip unreachables', on: 'ip unreachables', actif: 'ICMP unreachables are always sent', eteint: 'ICMP unreachables are never sent' },
  { nom: 'proxy-arp', off: 'no ip proxy-arp', on: 'ip proxy-arp', actif: 'Proxy ARP is enabled', eteint: 'Proxy ARP is disabled' },
] as const;

describe('interface — ICMP redirects/unreachables et proxy-ARP se coupent et se rallument', () => {
  for (const cas of CAS) {
    it(`${cas.nom} : la vue suit la configuration dans les deux sens`, async () => {
      const r = await routeur();
      expect(await vue(r)).toContain(cas.actif);
      expect(await cfg(r)).not.toContain(cas.off);

      await surIface(r, [cas.off]);
      expect(await vue(r)).toContain(cas.eteint);
      expect(await cfg(r)).toContain(cas.off);

      await surIface(r, [cas.on]);
      expect(await vue(r)).toContain(cas.actif);
      expect(await cfg(r)).not.toContain(cas.off);
    });
  }

  it('les trois faits sont indépendants', async () => {
    const r = await routeur();
    await surIface(r, ['no ip redirects']);
    const v = await vue(r);
    expect(v).toContain('ICMP redirects are never sent');
    expect(v).toContain('ICMP unreachables are always sent');
    expect(v).toContain('Proxy ARP is enabled');
  });
});
