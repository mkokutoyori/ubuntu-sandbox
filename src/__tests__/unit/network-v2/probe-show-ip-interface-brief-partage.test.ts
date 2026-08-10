import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function ios(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await d.executeCommand(c));
  return last;
}

function ligne(sortie: string, nom: string): string {
  return sortie.split('\n').find((l) => l.startsWith(nom)) ?? '';
}

describe('`show ip interface brief` : un port débranché n\'est pas éteint', () => {
  it('commutateur : un port sans câble est `down`, jamais `administratively down`', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
    sw.powerOn();
    const l = ligne(await ios(sw, ['enable', 'show ip interface brief']), 'FastEthernet0/1');
    expect(l).toContain('down');
    expect(l).not.toContain('administratively down');
  }, 30_000);

  it('commutateur : un port `shutdown` est `administratively down`', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
    sw.powerOn();
    const vue = await ios(sw, [
      'enable', 'configure terminal', 'interface FastEthernet0/1', 'shutdown', 'end',
      'show ip interface brief',
    ]);
    expect(ligne(vue, 'FastEthernet0/1')).toContain('administratively down');
  }, 30_000);

  it('routeur : les mêmes mots pour la même situation', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const avant = ligne(await ios(r, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end',
      'show ip interface brief',
    ]), 'GigabitEthernet0/0');
    expect(avant).toContain('administratively down');
    const apres = ligne(await ios(r, [
      'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end',
      'show ip interface brief',
    ]), 'GigabitEthernet0/0');
    expect(apres).toContain('down');
    expect(apres).not.toContain('administratively down');
  }, 30_000);

  it('une SVI porte son adresse et sa méthode', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
    sw.powerOn();
    const vue = await ios(sw, [
      'enable', 'configure terminal', 'interface Vlan1',
      'ip address 192.168.1.2 255.255.255.0', 'no shutdown', 'end',
      'show ip interface brief',
    ]);
    const l = ligne(vue, 'Vlan1');
    expect(l).toContain('192.168.1.2');
    expect(l).toContain('manual');
  }, 30_000);

  it('chaque plateforme garde la largeur mesurée sur la sienne', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
    sw.powerOn();
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const enTeteSw = (await ios(sw, ['enable', 'show ip interface brief'])).split('\n')[0];
    const enTeteR = (await ios(r, ['enable', 'show ip interface brief'])).split('\n')[0];
    expect(enTeteSw.indexOf('IP-Address')).toBe(23);
    expect(enTeteR.indexOf('IP-Address')).toBe(27);
    expect(enTeteSw.slice(23)).toBe(enTeteR.slice(27));
  }, 30_000);
});
