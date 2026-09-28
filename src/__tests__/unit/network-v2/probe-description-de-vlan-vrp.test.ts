/*
 * Sur un commutateur VRP, `description` dans la vue d'un VLAN etait
 * acceptee — et perdue.
 *
 * Mesure de depart, sur un HW1 a 8 ports :
 *
 *   vlan 10 / description Users-LAN     accepte, sans un mot
 *   display current-configuration       vlan 10 / name VLAN0010   <- ni la
 *                                       description, et un nom que
 *                                       personne n'a donne
 *   display vlan                        VLAN ID  Name  Status  Ports
 *                                       (la mise en page d'IOS, sans
 *                                       colonne Description)
 *
 * La description allait dans une carte du shell que rien ne lit : un
 * critere range et jamais rendu, le defaut de la regle 6 sous sa forme
 * nue.
 *
 * L'AUTORITE EST LA TRANSCRIPTION CAPTUREE, `ntc-templates`
 * `tests/huawei_vrp/display_vlan/huawei_vrp_display_vlan.raw` :
 *
 *   The total number of VLANs is: 3
 *   ------------------------------------------------------------------…
 *   U: Up;         D: Down;         TG: Tagged;         UT: Untagged;
 *   MP: Vlan-mapping;               ST: Vlan-stacking;
 *   #: ProtocolTransparent-vlan;    *: Management-vlan;
 *   ------------------------------------------------------------------…
 *
 *   VID  Type    Ports
 *   ------------------------------------------------------------------…
 *   10   common  UT:XGE0/0/7(D)     XGE0/0/8(D)     …
 *
 *   VID  Status  Property      MAC-LRN Statistics Description
 *   ------------------------------------------------------------------…
 *   10   enable  default       enable  disable    VLAN 0010
 *
 * La description par defaut d'un VLAN est `VLAN 0010` ; `description`
 * la remplace, `undo description` la rend. Un port d'acces est membre
 * NON ETIQUETE (`UT:`), un tronc membre ETIQUETE (`TG:`), et chaque port
 * dit son etat, `(U)` ou `(D)`.
 *
 * Ecrite a l'aveugle contre cette capture, avant de lire les vues.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 8 des 9 cas tombent. Le TEMOIN, un nom donne par `name`, passe des
 * deux cotes : le nom avait deja son magasin, seule la description n'en
 * avait pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function configured(...commands: string[]): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'HW1', 8, 0, 0);
  for (const c of ['system-view', ...commands, 'return']) await sw.executeCommand(c);
  return sw;
}

const statusRow = (view: string, vid: number): string | undefined =>
  view.split('\n').find((l) => new RegExp(`^${vid}\\s+enable\\s`).test(l));

describe('`description` is rendered by the configuration', () => {
  it('the line follows the VLAN', async () => {
    const sw = await configured('vlan 10', 'description Users-LAN', 'quit');

    expect(await sw.executeCommand('display current-configuration'))
      .toMatch(/^vlan 10\n description Users-LAN$/m);
  }, 30000);

  it('a name nobody gave is not rendered', async () => {
    const sw = await configured('vlan 10', 'quit');

    expect(await sw.executeCommand('display current-configuration')).not.toMatch(/name VLAN0010/);
  }, 30000);

  it('a given name is — WITNESS', async () => {
    const sw = await configured('vlan 10', 'name Servers', 'quit');

    expect(await sw.executeCommand('display current-configuration')).toMatch(/^ name Servers$/m);
  }, 30000);
});

describe('`display vlan` speaks like the capture', () => {
  it('the header counts the VLANs', async () => {
    const sw = await configured('vlan batch 10 20');

    expect((await sw.executeCommand('display vlan')).split('\n')[0]).toBe('The total number of VLANs is: 3');
  }, 30000);

  it('the Description column carries the description', async () => {
    const sw = await configured('vlan 10', 'description Users-LAN', 'quit');

    expect(statusRow(await sw.executeCommand('display vlan'), 10))
      .toBe('10   enable  default       enable  disable    Users-LAN');
  }, 30000);

  it('without a description, `VLAN 0020`', async () => {
    const sw = await configured('vlan batch 20');

    expect(statusRow(await sw.executeCommand('display vlan'), 20))
      .toBe('20   enable  default       enable  disable    VLAN 0020');
  }, 30000);

  it('`undo description` restores the default description', async () => {
    const sw = await configured('vlan 10', 'description Users-LAN', 'undo description', 'quit');

    expect(statusRow(await sw.executeCommand('display vlan'), 10))
      .toBe('10   enable  default       enable  disable    VLAN 0010');
    expect(await sw.executeCommand('display current-configuration')).not.toMatch(/description Users-LAN/);
  }, 30000);

  it('an access port is an untagged member, with its state', async () => {
    const sw = await configured(
      'vlan 10', 'quit',
      'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 10', 'quit');

    expect(await sw.executeCommand('display vlan')).toMatch(/^10 {3}common {2}UT:GE0\/0\/1\(D\)$/m);
  }, 30000);

  it('`display vlan 10` keeps the VLAN line and its description', async () => {
    const sw = await configured('vlan 10', 'description Users-LAN', 'quit');

    expect(statusRow(await sw.executeCommand('display vlan 10'), 10))
      .toBe('10   enable  default       enable  disable    Users-LAN');
  }, 30000);
});
