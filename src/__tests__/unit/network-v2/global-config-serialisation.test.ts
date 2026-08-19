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

async function routeur(cmds: string[] = []) {
  const r = new CiscoRouter('R', 0, 0);
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'exit', ...cmds, 'end',
  ]) await r.executeCommand(c);
  return r;
}

const lignes = async (r: CiscoRouter) =>
  ((await r.executeCommand('show running-config')) ?? '').split('\n').map((l) => l.trim());

const REGLAGES = [
  'ip default-network 10.9.0.0',
  'ip cef load-sharing algorithm tunnel',
  'ip dhcp relay information policy keep',
  'ip dhcp relay information trust-all',
  'ip dhcp smart-relay',
  'ip dhcp snooping',
  'ip dhcp snooping vlan 10',
  'ip dhcp snooping information option',
  'ip local policy route-map PBR',
];

describe('configuration globale — ce qui est tapé se retrouve dans la configuration', () => {
  it('rend chaque réglage', async () => {
    const l = await lignes(await routeur(REGLAGES));
    for (const cmd of REGLAGES) expect(l, cmd).toContain(cmd);
  });

  it('n\'écrit rien tant qu\'aucun n\'est posé', async () => {
    const l = await lignes(await routeur());
    for (const cmd of REGLAGES) expect(l).not.toContain(cmd);
  });

  it('survit à un aller-retour export → import', async () => {
    const r = await routeur(REGLAGES);
    const texte = (await r.executeCommand('show running-config')) ?? '';
    const r2 = new CiscoRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    const l = await lignes(r2);
    for (const cmd of REGLAGES) expect(l, cmd).toContain(cmd);
  });

  it('chaque réglage se retire par sa forme `no`', async () => {
    const l = await lignes(await routeur([
      ...REGLAGES,
      ...REGLAGES.map((c) => `no ${c}`),
    ]));
    for (const cmd of REGLAGES) expect(l, cmd).not.toContain(cmd);
  });

  it('refuse une valeur que le simulateur n\'évalue pas', async () => {
    const r = await routeur();
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('ip dhcp relay information policy zorglub'))
      .toMatch(/Invalid input/);
    expect(await r.executeCommand('ip cef load-sharing algorithm zorglub'))
      .toMatch(/Invalid input/);
    expect(await r.executeCommand('ip default-network pas-une-adresse'))
      .toMatch(/Invalid input/);
  });

  it('`show ip dhcp snooping` et la configuration lisent le même magasin', async () => {
    const r = await routeur(['ip dhcp snooping', 'ip dhcp snooping vlan 10']);
    const vue = (await r.executeCommand('show ip dhcp snooping')) ?? '';
    expect(vue).not.toContain('not enabled');
    expect(vue).toContain('10');
    expect(await lignes(r)).toContain('ip dhcp snooping vlan 10');
  });

  it('`show ip policy` et la configuration lisent le même magasin', async () => {
    const r = await routeur(['ip local policy route-map PBR']);
    expect((await r.executeCommand('show ip policy')) ?? '').toContain('PBR');
    expect(await lignes(r)).toContain('ip local policy route-map PBR');
  });
});

describe('`ip nat pool` reproduit la forme écrite', () => {
  it('garde `netmask` quand c\'est `netmask` qui a été tapé', async () => {
    const r = await routeur(['ip nat pool P 10.9.0.10 10.9.0.20 netmask 255.255.255.0']);
    expect(await lignes(r)).toContain('ip nat pool P 10.9.0.10 10.9.0.20 netmask 255.255.255.0');
  });

  it('garde `prefix-length` quand c\'est `prefix-length` qui a été tapé', async () => {
    const r = await routeur(['ip nat pool P 10.9.0.10 10.9.0.20 prefix-length 24']);
    expect(await lignes(r)).toContain('ip nat pool P 10.9.0.10 10.9.0.20 prefix-length 24');
  });

  it('ne réécrit pas un masque non /24 en /24', async () => {
    const r = await routeur(['ip nat pool P 10.9.0.10 10.9.0.20 netmask 255.255.255.128']);
    expect(await lignes(r)).toContain('ip nat pool P 10.9.0.10 10.9.0.20 netmask 255.255.255.128');
  });
});

describe('`ip route vrf`', () => {
  it('figure dans la configuration et survit à l\'import', async () => {
    const r = await routeur([
      'ip vrf CLIENT', 'exit',
      'ip route vrf CLIENT 10.9.2.0 255.255.255.0 10.0.0.2',
    ]);
    const attendue = 'ip route vrf CLIENT 10.9.2.0 255.255.255.0 10.0.0.2';
    expect(await lignes(r)).toContain(attendue);

    const texte = (await r.executeCommand('show running-config')) ?? '';
    const r2 = new CiscoRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    expect(await lignes(r2)).toContain(attendue);
  });
});
