import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
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

async function routeurNat(regle: string) {
  const r = new CiscoRouter('R', 0, 0);
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
    'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 203.0.113.1 255.255.255.0',
    'ip nat outside', 'no shutdown', 'exit',
    'ip nat pool P1 203.0.113.10 203.0.113.10 netmask 255.255.255.0',
    'access-list 10 permit 10.0.0.0 0.0.0.255',
    regle, 'end',
  ]) await r.executeCommand(c);
  return r;
}

const lignes = async (r: CiscoRouter) =>
  ((await r.executeCommand('show running-config')) ?? '').split('\n').map((l) => l.trim());

describe('`ip nat inside source list … pool … overload`', () => {
  it('figure dans la configuration avec son mot-clé', async () => {
    const r = await routeurNat('ip nat inside source list 10 pool P1 overload');
    expect(await lignes(r)).toContain('ip nat inside source list 10 pool P1 overload');
  });

  it('sans le mot-clé, la ligne rendue ne l\'invente pas', async () => {
    const r = await routeurNat('ip nat inside source list 10 pool P1');
    const l = await lignes(r);
    expect(l).toContain('ip nat inside source list 10 pool P1');
    expect(l).not.toContain('ip nat inside source list 10 pool P1 overload');
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeurNat('ip nat inside source list 10 pool P1 overload');
    const texte = (await r.executeCommand('show running-config')) ?? '';
    const r2 = new CiscoRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    expect(await lignes(r2)).toContain('ip nat inside source list 10 pool P1 overload');
  });

  async function labNat(regle: string) {
    const r = await routeurNat(regle);
    const sw = new GenericSwitch('switch-generic', 'SW');
    const serveur = new LinuxPC('SRV');
    const hotes: LinuxPC[] = [];
    for (const [n, ip] of [[0, '10.0.0.11'], [1, '10.0.0.12']] as Array<[number, string]>) {
      const pc = new LinuxPC(`PC${n}`);
      new Cable(`c${n}`).connect(pc.getPorts()[0], sw.getPorts()[n]);
      await pc.executeCommand(`sudo ip addr add ${ip}/24 dev eth0`);
      await pc.executeCommand('sudo ip route add default via 10.0.0.1');
      hotes.push(pc);
    }
    new Cable('cr').connect(r.getPort('GigabitEthernet0/0')!, sw.getPorts()[2]);
    new Cable('cs').connect(r.getPort('GigabitEthernet0/1')!, serveur.getPorts()[0]);
    await serveur.executeCommand('sudo ip addr add 203.0.113.7/24 dev eth0');
    await serveur.executeCommand('sudo ip route add default via 203.0.113.1');
    const pertes: string[] = [];
    for (const pc of hotes) {
      pertes.push(((await pc.executeCommand('ping -c 1 203.0.113.7')) ?? '')
        .split('\n').find((l) => /packet loss/.test(l))?.trim() ?? '');
    }
    return { r, pertes };
  }

  const traductions = async (r: CiscoRouter) =>
    ((await r.executeCommand('show ip nat translations')) ?? '')
      .split('\n').filter((l) => /^icmp /.test(l.trim()));

  it('un pool d\'UNE adresse traduit DEUX hôtes, ce que le pool simple ne fait pas', async () => {
    expect(await traductions((await labNat(
      'ip nat inside source list 10 pool P1 overload')).r)).toHaveLength(2);
    expect(await traductions((await labNat(
      'ip nat inside source list 10 pool P1')).r)).toHaveLength(1);
  });

  it('les deux hôtes partagent l\'adresse du pool et se distinguent par le port', async () => {
    const l = await traductions((await labNat('ip nat inside source list 10 pool P1 overload')).r);
    const globaux = l.map((ligne) => ligne.trim().split(/\s+/)[1]);
    expect(globaux.map((g) => g.split(':')[0])).toEqual(['203.0.113.10', '203.0.113.10']);
    expect(new Set(globaux.map((g) => g.split(':')[1])).size).toBe(2);
  });

  it('la réponse revient : le routeur répond à l\'ARP pour une adresse de son pool', async () => {
    const { pertes } = await labNat('ip nat inside source list 10 pool P1 overload');
    for (const p of pertes) expect(p).toMatch(/, 0% packet loss/);
  });
});

describe('`ip pim rp-address`', () => {
  async function routeurPim(cmds: string[]) {
    const r = new CiscoRouter('R', 0, 0);
    for (const c of ['enable', 'configure terminal', 'ip multicast-routing', ...cmds, 'end']) {
      await r.executeCommand(c);
    }
    return r;
  }

  it('figure dans la configuration', async () => {
    const r = await routeurPim(['ip pim rp-address 10.9.0.1']);
    expect(await lignes(r)).toContain('ip pim rp-address 10.9.0.1');
  });

  it('rend chaque RP statique déclaré', async () => {
    const r = await routeurPim(['ip pim rp-address 10.9.0.1', 'ip pim rp-address 10.9.0.2']);
    const l = await lignes(r);
    expect(l).toContain('ip pim rp-address 10.9.0.1');
    expect(l).toContain('ip pim rp-address 10.9.0.2');
  });

  it('`no` le retire de la configuration', async () => {
    const r = await routeurPim(['ip pim rp-address 10.9.0.1', 'no ip pim rp-address 10.9.0.1']);
    expect(await lignes(r)).not.toContain('ip pim rp-address 10.9.0.1');
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeurPim(['ip pim rp-address 10.9.0.1']);
    const texte = (await r.executeCommand('show running-config')) ?? '';
    const r2 = new CiscoRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    expect(await lignes(r2)).toContain('ip pim rp-address 10.9.0.1');
  });

  it('refuse une portée que ce simulateur n\'évalue pas plutôt que de l\'élargir', async () => {
    const r = new CiscoRouter('R', 0, 0);
    for (const c of ['enable', 'configure terminal', 'ip multicast-routing']) {
      await r.executeCommand(c);
    }
    expect(await r.executeCommand('ip pim rp-address 10.9.0.2 5 override'))
      .toMatch(/Invalid input/);
    await r.executeCommand('end');
    expect(await lignes(r)).not.toContain('ip pim rp-address 10.9.0.2');
  });
});
