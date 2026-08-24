/**
 * Deux routes statiques vers le meme prefixe sont DEUX routes.
 *
 * Sur le commutateur, `SwitchSvi` indexait ses routes par `network/mask`
 * SEUL : `addStaticRoute` remplacait l'entree existante, donc
 *
 *   ip route-static 10.9.0.0 24 10.0.0.1
 *   ip route-static 10.9.0.0 24 10.0.0.2
 *   ip route-static 10.9.0.0 24 10.0.0.3 preference 100
 *
 * laissaient UNE route, la derniere. C'est ainsi qu'on ecrit une route
 * de secours ou un partage de charge, et une vraie machine en garde
 * trois. Consequences mesurees : `undo` de la premiere repondait
 * `Route not found.`, la configuration rendue n'en decrivait qu'une —
 * donc un rechargement perdait les autres — et `preference 100` etait
 * accepte, avale, et affiche `Pre 60`.
 *
 * Le magasin est desormais indexe par la route ENTIERE, `lookupRoute`
 * classe par prefixe puis par preference et prend la premiere dont le
 * saut suivant se resout — c'est ce qui fait qu'une route de secours
 * porte vraiment le trafic quand la principale ne mene nulle part —, et
 * `removeStaticRoute` retire celle qu'on lui nomme.
 *
 * Trouve en chemin : la commande d'AJOUT du commutateur portait sa
 * PROPRE analyse, distincte de celle du `undo` et de celle du routeur,
 * et c'est elle qui jetait la preference. Les trois lisent maintenant
 * `analyserTeteRouteStatiqueVrp` et `lireQueueRouteStatiqueVrp`, cette
 * derniere EXTRAITE du gestionnaire du routeur plutot que recopiee. Et
 * VRP compte les DESTINATIONS a part des routes : les deux nombres
 * etaient le meme tant qu'un prefixe ne pouvait porter qu'une route.
 *
 * Discrimination par `git stash` : 6 des 8 cas tombent. Les deux autres
 * sont nommes — « TEMOIN, une seule route se pose et se retire », dont
 * c'est l'objet de montrer que le chemin nominal n'a pas bouge ; et
 * « une meme route posee deux fois ne se dedouble pas », qui passait
 * avant pour une raison qui ne prouve rien : l'ancien magasin ecrasait
 * TOUTE route de meme prefixe, donc l'idempotence etait un effet de
 * bord du defaut.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

async function commutateurRoute(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW', 24, 0, 0);
  for (const c of ['system-view', 'ip routing-enable', 'vlan 10', 'quit',
    'interface Vlanif10', 'ip address 10.0.0.254 255.255.255.0', 'quit']) {
    await sw.executeCommand(c);
  }
  return sw;
}

describe('les routes statiques d un commutateur', () => {
  beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); });

  it('TEMOIN, une seule route se pose et se retire', async () => {
    const sw = await commutateurRoute();
    expect(await sw.executeCommand('ip route-static 10.9.0.0 24 10.0.0.1')).toBe('');
    expect(await sw.executeCommand('display ip routing-table')).toContain('10.9.0.0/24');
    expect(await sw.executeCommand('undo ip route-static 10.9.0.0 24 10.0.0.1')).toBe('');
    expect(await sw.executeCommand('display ip routing-table')).not.toContain('10.9.0.0/24');
  }, 30000);

  it('trois routes vers le meme prefixe restent trois', async () => {
    const sw = await commutateurRoute();
    for (const c of [
      'ip route-static 10.9.0.0 24 10.0.0.1',
      'ip route-static 10.9.0.0 24 10.0.0.2',
      'ip route-static 10.9.0.0 24 10.0.0.3 preference 100',
    ]) expect(await sw.executeCommand(c), c).toBe('');

    const vue = await sw.executeCommand('display ip routing-table');
    for (const nh of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) expect(vue, nh).toContain(nh);
    expect(vue).toContain('Destinations : 2       Routes : 4');
  }, 30000);

  it('une meme route posee deux fois ne se dedouble pas', async () => {
    const sw = await commutateurRoute();
    await sw.executeCommand('ip route-static 10.9.0.0 24 10.0.0.1');
    await sw.executeCommand('ip route-static 10.9.0.0 24 10.0.0.1');
    expect(await sw.executeCommand('display ip routing-table'))
      .toContain('Destinations : 2       Routes : 2');
  }, 30000);

  it('la preference est retenue, affichee et rendue dans la configuration', async () => {
    const sw = await commutateurRoute();
    await sw.executeCommand('ip route-static 10.9.0.0 24 10.0.0.3 preference 100');
    expect(await sw.executeCommand('display ip routing-table')).toMatch(/Static\s+100\s/);
    expect(await sw.executeCommand('display current-configuration'))
      .toContain('ip route-static 10.9.0.0 255.255.255.0 10.0.0.3 preference 100');
  }, 30000);

  it('une preference hors 1-255 est refusee', async () => {
    const sw = await commutateurRoute();
    for (const mauvais of ['0', '256', 'zorglub']) {
      expect(await sw.executeCommand(`ip route-static 10.9.0.0 24 10.0.0.3 preference ${mauvais}`), mauvais)
        .toContain('Error:');
    }
    expect(await sw.executeCommand('display ip routing-table')).not.toContain('10.9.0.0/24');
  }, 30000);

  it('`undo` retire la route qu on lui nomme, pas la premiere du prefixe', async () => {
    const sw = await commutateurRoute();
    await sw.executeCommand('ip route-static 10.9.0.0 24 10.0.0.1');
    await sw.executeCommand('ip route-static 10.9.0.0 24 10.0.0.2');

    expect(await sw.executeCommand('undo ip route-static 10.9.0.0 24 10.0.0.1')).toBe('');
    const vue = await sw.executeCommand('display ip routing-table');
    expect(vue).not.toContain('10.0.0.1');
    expect(vue).toContain('10.0.0.2');
  }, 30000);

  it('la configuration rendue reproduit les trois routes', async () => {
    const sw = await commutateurRoute();
    for (const c of [
      'ip route-static 10.9.0.0 24 10.0.0.1',
      'ip route-static 10.9.0.0 24 10.0.0.2',
      'ip route-static 10.9.0.0 24 10.0.0.3 preference 100',
    ]) await sw.executeCommand(c);

    const cfg = await sw.executeCommand('display current-configuration');
    expect(cfg).toContain('ip route-static 10.9.0.0 255.255.255.0 10.0.0.1');
    expect(cfg).toContain('ip route-static 10.9.0.0 255.255.255.0 10.0.0.2');
    expect(cfg).toContain('ip route-static 10.9.0.0 255.255.255.0 10.0.0.3 preference 100');
  }, 30000);

  it('la route de secours porte le trafic quand la principale ne mene nulle part', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW', 24, 0, 0);
    const relais = new LinuxPC('linux-pc', 'RELAIS');
    const source = new LinuxPC('linux-pc', 'SRC');
    new Cable('a').connect(relais.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
    new Cable('b').connect(source.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);
    for (const c of ['system-view', 'ip routing-enable', 'vlan 10', 'quit',
      'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 10', 'quit',
      'interface GigabitEthernet0/0/2', 'port link-type access', 'port default vlan 10', 'quit',
      'interface Vlanif10', 'ip address 10.0.0.254 255.255.255.0', 'quit',
      'ip route-static 10.9.0.0 24 172.31.9.9',
      'ip route-static 10.9.0.0 24 10.0.0.1 preference 100',
    ]) await sw.executeCommand(c);
    relais.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    source.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    const table = sw.getStaticRoutes();
    expect(table.length).toBe(2);
    expect(table.map(r => r.nextHop.toString())).toContain('172.31.9.9');
    expect(await sw.executeCommand('display ip routing-table'))
      .toContain('Destinations : 2       Routes : 3');
  }, 30000);
});
