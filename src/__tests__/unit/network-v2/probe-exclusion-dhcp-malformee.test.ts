/**
 * Une exclusion DHCP malformee ne rentre pas dans le magasin.
 *
 * Mesure de depart : `ip dhcp excluded-address zorglub` etait accepte en
 * silence, range tel quel, rendu dans `show running-config` — donc
 * rejoue a l'import d'une topologie — et la consequence n'etait pas
 * cosmetique. `isExcluded` convertit chaque borne par `new IPAddress`,
 * qui LEVE sur une chaine qui n'est pas une adresse : une seule faute de
 * frappe faisait tomber TOUTE l'attribution de baux du routeur, pas
 * seulement la ligne fautive. Mesure : `sudo dhclient eth0` rendait
 * `Invalid IP address: zorglub` et le client repartait sans adresse.
 *
 * Discrimination par `git stash` : 7 des 9 cas tombent avant correctif.
 * Les deux autres sont les TEMOINS, dont c'est l'objet de passer des
 * deux cotes — sans eux, un banc mal monte et un serveur casse seraient
 * indiscernables, ce qui est arrive au premier essai : le client etait
 * pilote par une methode qui n'existe pas, et AUCUN des deux cas
 * n'obtenait de bail.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function routeur(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

async function banc(exclusion: string): Promise<LinuxPC> {
  const bus = new EventBus();
  const r = new CiscoRouter('R1');
  const pc = new LinuxPC('PC1');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  r.setEventBus(bus); pc.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(pc.getPorts()[0], sw.getPort('FastEthernet0/2')!);
  r.getPort('GigabitEthernet0/0')!
    .configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  r.powerOn(); pc.powerOn(); sw.powerOn();
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand(exclusion);
  await r.executeCommand('ip dhcp pool P');
  await r.executeCommand('network 10.0.0.0 255.255.255.0');
  await r.executeCommand('default-router 10.0.0.1');
  await r.executeCommand('end');
  return pc;
}

const exclusions = (r: CiscoRouter) =>
  (r as unknown as { _getDHCPServerInternal(): { getExcludedRanges(): unknown[] } })
    ._getDHCPServerInternal().getExcludedRanges();

describe('IOS : `ip dhcp excluded-address` refuse ce qui n\'est pas une adresse', () => {
  it('TEMOIN — une exclusion bien formee est retenue', async () => {
    const r = await routeur();

    expect(await r.executeCommand('ip dhcp excluded-address 10.0.0.1 10.0.0.10')).toBe('');
    expect(exclusions(r)).toEqual([{ start: '10.0.0.1', end: '10.0.0.10' }]);
  });

  it('un mot qui n\'est pas une adresse est refuse', async () => {
    const r = await routeur();

    expect(await r.executeCommand('ip dhcp excluded-address zorglub'))
      .toContain('Invalid input');
    expect(exclusions(r)).toEqual([]);
  });

  it('une adresse hors bornes est refusee', async () => {
    const r = await routeur();

    expect(await r.executeCommand('ip dhcp excluded-address 999.1.1.1'))
      .toContain('Invalid input');
    expect(exclusions(r)).toEqual([]);
  });

  it('une borne HAUTE malformee est refusee, et rien n\'est retenu', async () => {
    const r = await routeur();

    expect(await r.executeCommand('ip dhcp excluded-address 10.0.0.1 zorglub'))
      .toContain('Invalid input');
    expect(exclusions(r)).toEqual([]);
  });

  it('la ligne refusee n\'entre pas dans la configuration rendue', async () => {
    const r = await routeur();
    await r.executeCommand('ip dhcp excluded-address zorglub');
    await r.executeCommand('end');

    expect(await r.executeCommand('show running-config')).not.toContain('zorglub');
  });
});

describe('DHCP : une faute de frappe ne fait plus tomber le serveur', () => {
  it('TEMOIN — un bail est attribue quand l\'exclusion est bien formee', async () => {
    const pc = await banc('ip dhcp excluded-address 10.0.0.1 10.0.0.5');

    const out = await pc.executeCommand('sudo dhclient -v eth0');

    expect(out).toContain('bound to');
    expect(pc.getPorts()[0].getIPAddress()?.toString()).toMatch(/^10\.0\.0\./);
  });

  it('un bail est attribue MALGRE une exclusion mal tapee', async () => {
    const pc = await banc('ip dhcp excluded-address zorglub');

    const out = await pc.executeCommand('sudo dhclient -v eth0');

    expect(out).toContain('bound to');
    expect(pc.getPorts()[0].getIPAddress()?.toString()).toMatch(/^10\.0\.0\./);
  });
});

describe('les quatre portes du meme magasin refusent pareil', () => {
  it('le commutateur Cisco', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');

    expect(await sw.executeCommand('ip dhcp excluded-address zorglub'))
      .toContain('Invalid input');
  });

  it('VRP, en vue systeme et dans un pool', async () => {
    const h = new HuaweiRouter('H1');
    h.powerOn();
    await h.executeCommand('system-view');

    expect(await h.executeCommand('dhcp server excluded-ip-address zorglub'))
      .toContain('Error');

    await h.executeCommand('ip pool P');
    expect(await h.executeCommand('excluded-ip-address zorglub')).toContain('Error');
    expect(await h.executeCommand('excluded-ip-address 10.0.0.1 10.0.0.10')).toBe('');
  });
});
