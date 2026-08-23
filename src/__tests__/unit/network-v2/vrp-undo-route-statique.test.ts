/**
 * VRP — une route statique se retire par la commande qui l'a posee.
 *
 * Discrimination par `git stash` : 10 des 12 cas tombent avant
 * correctif. Les deux autres sont nommes plutot que laisses a
 * decouvrir. Le TEMOIN — la forme masque pointille avec saut, la seule
 * que l'ancien analyseur du routeur connaissait — passe des deux cotes,
 * et c'est son objet : sans lui, un banc mal monte et un `undo` inerte
 * seraient indiscernables. « Le saut suivant qui correspond retire la
 * route », sur le commutateur, passait avant pour une raison qui ne
 * prouve rien : l'ancien code y retirait par prefixe SEUL, donc il
 * tombait juste par coincidence — c'est le cas jumeau, « un saut
 * suivant qui ne correspond pas ne retire rien », qui mesure la
 * difference.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function routeur(commandes: readonly string[] = []): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('R1');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  new Cable('a').connect(r.getPorts()[0], sw.getPort('FastEthernet0/1')!);
  r.powerOn(); sw.powerOn();
  await r.executeCommand('system-view');
  await r.executeCommand(`interface ${r.getPorts()[0].getName()}`);
  await r.executeCommand('ip address 10.0.0.254 255.255.255.0');
  await r.executeCommand('undo shutdown');
  await r.executeCommand('quit');
  for (const c of commandes) await r.executeCommand(c);
  return r;
}

const statiques = (r: HuaweiRouter): string[] => r.getRoutingTable()
  .filter((e) => e.type === 'static' || e.type === 'default')
  .map((e) => `${e.network}/${e.mask.toCIDR()}`);

const vue = async (r: HuaweiRouter): Promise<string> =>
  r.executeCommand('display ip routing-table');

describe('VRP : `undo ip route-static` retire la route', () => {
  it('TEMOIN — la forme masque pointille avec saut retirait deja', async () => {
    const r = await routeur(['ip route-static 10.8.0.0 255.255.255.0 10.0.0.1']);
    expect(statiques(r)).toEqual(['10.8.0.0/24']);

    await r.executeCommand('undo ip route-static 10.8.0.0 255.255.255.0 10.0.0.1');

    expect(statiques(r)).toEqual([]);
  });

  it('la longueur de prefixe est acceptee a la suppression comme a la creation', async () => {
    const r = await routeur(['ip route-static 10.9.0.0 24 10.0.0.1']);

    expect(await r.executeCommand('undo ip route-static 10.9.0.0 24 10.0.0.1')).toBe('');
    expect(statiques(r)).toEqual([]);
  });

  it('le saut suivant est facultatif', async () => {
    const r = await routeur(['ip route-static 10.9.0.0 24 10.0.0.1']);

    expect(await r.executeCommand('undo ip route-static 10.9.0.0 24')).toBe('');
    expect(statiques(r)).toEqual([]);
  });

  it('la forme par interface de sortie retire la bonne route', async () => {
    const r = await routeur(['ip route-static 10.7.0.0 24 GigabitEthernet0/0/0']);
    expect(statiques(r)).toEqual(['10.7.0.0/24']);

    expect(await r.executeCommand('undo ip route-static 10.7.0.0 24 GigabitEthernet0/0/0')).toBe('');

    expect(statiques(r)).toEqual([]);
  });

  it('`all` retire toutes les routes statiques et garde les connectees', async () => {
    const r = await routeur([
      'ip route-static 10.9.0.0 24 10.0.0.1',
      'ip route-static 10.8.0.0 24 10.0.0.1',
    ]);
    expect(statiques(r)).toHaveLength(2);

    expect(await r.executeCommand('undo ip route-static all')).toBe('');

    expect(statiques(r)).toEqual([]);
    expect(await vue(r)).toContain('10.0.0.0/24');
  });

  it('une preference qui ne correspond pas ne retire rien', async () => {
    const r = await routeur(['ip route-static 10.6.0.0 24 10.0.0.1 preference 200']);

    expect(await r.executeCommand('undo ip route-static 10.6.0.0 24 10.0.0.1 preference 100'))
      .toContain('Route not found');
    expect(statiques(r)).toEqual(['10.6.0.0/24']);
  });

  it('la preference qui correspond retire la route', async () => {
    const r = await routeur(['ip route-static 10.6.0.0 24 10.0.0.1 preference 200']);

    expect(await r.executeCommand('undo ip route-static 10.6.0.0 24 10.0.0.1 preference 200')).toBe('');
    expect(statiques(r)).toEqual([]);
  });

  it('un mot de trop apres `all` est refuse', async () => {
    const r = await routeur();

    expect(await r.executeCommand('undo ip route-static all zorglub'))
      .toContain("position");
  });

  it('la route disparait aussi de la vue et de la configuration', async () => {
    const r = await routeur(['ip route-static 10.9.0.0 24 10.0.0.1']);
    expect(await vue(r)).toContain('10.9.0.0/24');

    await r.executeCommand('undo ip route-static 10.9.0.0 24 10.0.0.1');

    expect(await vue(r)).not.toContain('10.9.0.0/24');
    expect(await r.executeCommand('display current-configuration'))
      .not.toContain('ip route-static 10.9.0.0');
  });
});

describe('commutateur VRP : le meme `undo` que le routeur', () => {
  async function commutateur(commandes: readonly string[] = []): Promise<HuaweiSwitch> {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1');
    sw.powerOn();
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface Vlanif10');
    await sw.executeCommand('ip address 10.0.0.254 255.255.255.0');
    await sw.executeCommand('quit');
    for (const c of commandes) await sw.executeCommand(c);
    return sw;
  }

  it('`all` existe aussi sur le commutateur', async () => {
    const sw = await commutateur(['ip route-static 10.9.0.0 24 10.0.0.1']);

    expect(await sw.executeCommand('undo ip route-static all')).toBe('');
    expect(sw.getStaticRoutes()).toHaveLength(0);
  });

  it('un saut suivant qui ne correspond pas ne retire rien', async () => {
    const sw = await commutateur(['ip route-static 10.9.0.0 24 10.0.0.2']);

    expect(await sw.executeCommand('undo ip route-static 10.9.0.0 24 10.0.0.1'))
      .toContain('Route not found');
    expect(sw.getStaticRoutes()).toHaveLength(1);
  });

  it('le saut suivant qui correspond retire la route', async () => {
    const sw = await commutateur(['ip route-static 10.9.0.0 24 10.0.0.2']);

    expect(await sw.executeCommand('undo ip route-static 10.9.0.0 24 10.0.0.2')).toBe('');
    expect(sw.getStaticRoutes()).toHaveLength(0);
  });
});
