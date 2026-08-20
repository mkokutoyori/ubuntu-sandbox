/**
 * `show mac address-table` montrait « No entries » sur un commutateur
 * qui avait appris.
 *
 * Le défaut a été trouvé en cherchant tout autre chose — vérifier que
 * DHCP fait bien circuler des trames. Il en fait circuler ; c'est la
 * VUE qui mentait, et elle mentait pour tout le trafic, pas seulement
 * pour DHCP.
 *
 * Deux causes superposées, et la seconde est la plus instructive :
 *
 *   1. `CiscoShellBase` lisait `dev.getMacTable?.()` — minuscule — que
 *      AUCUN appareil ne porte : celui de `Switch` s'appelle
 *      `getMACTable()`. Le lecteur rendait donc `undefined`, et la vue
 *      répondait « No entries » quoi qu'il arrive. C'est exactement le
 *      défaut de `_getRunningConfigText` déjà décrit dans ce même
 *      fichier, à trois lignes de là.
 *   2. Cette inscription MASQUAIT celle de `CiscoSwitchShell`, qui est
 *      complète — filtres, tri, colonnes. Le commutateur possédait donc
 *      une vue juste que personne n'atteignait, et lequel des deux
 *      gagnait tenait au seul ORDRE des inscriptions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

let r: CiscoRouter;
let sw: CiscoSwitch;
let pc: LinuxPC;

beforeEach(async () => {
  r = new CiscoRouter('R1');
  sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  pc = new LinuxPC('PC');
  pc.powerOn();
  sw.powerOn();
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  r.getPort('GigabitEthernet0/0')!
    .configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  pc.getPort('eth0')!
    .configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
});

describe('la table d\'adresses MAC est VISIBLE', () => {
  it('un ping suffit à peupler la vue', async () => {
    expect(await pc.executeCommand('ping -c 1 10.0.0.1')).toContain('1 received');

    const vue = await sw.executeCommand('show mac address-table');
    // La table interne en portait deux depuis toujours ; c'est la vue
    // qui les cachait.
    expect(sw.getMACTable()).toHaveLength(2);
    expect(vue).not.toContain('No entries');
    expect(vue).toContain(pc.getPort('eth0')!.getMAC().toString());
    expect(vue).toContain('FastEthernet0/2');
  });

  it('la vue et la table interne disent le même nombre', async () => {
    await pc.executeCommand('ping -c 1 10.0.0.1');
    const vue = await sw.executeCommand('show mac address-table');
    for (const e of sw.getMACTable()) {
      expect(vue, e.mac).toContain(e.mac);
      expect(vue, e.port).toContain(e.port);
    }
  });

  it('les colonnes sont celles d\'IOS', async () => {
    await pc.executeCommand('ping -c 1 10.0.0.1');
    const vue = await sw.executeCommand('show mac address-table');
    expect(vue).toContain('Vlan    Mac Address       Type        Ports');
    expect(vue).toContain('DYNAMIC');
    expect(vue).toContain('Total Mac Addresses for this criterion:');
  });

  it('un commutateur qui n\'a rien vu dit « No entries », et c\'est vrai', async () => {
    // Le garde-fou : la vue doit pouvoir être vide, sinon elle ne
    // mesure toujours rien.
    const vierge = new CiscoSwitch('switch-cisco', 'SW2', 4);
    vierge.powerOn();
    expect(await vierge.executeCommand('show mac address-table')).toContain('No entries');
  });
});

describe('les filtres de `CiscoSwitchShell` étaient inatteignables', () => {
  it('`dynamic` ne montre que les entrées apprises', async () => {
    await pc.executeCommand('ping -c 1 10.0.0.1');
    const vue = await sw.executeCommand('show mac address-table dynamic');
    expect(vue).toContain('DYNAMIC');
    expect(vue).not.toContain('No entries');
  });

  it('`count` compte, au lieu de rendre la table', async () => {
    await pc.executeCommand('ping -c 1 10.0.0.1');
    // Ces sous-commandes existaient et étaient masquées : la vue de la
    // base absorbait tout ce qui suivait `show mac address-table`.
    expect(await sw.executeCommand('show mac address-table count'))
      .toContain('Total Mac Addresses for this criterion: 2');
  });

  it('`aging-time` rend le délai de vieillissement', async () => {
    expect(await sw.executeCommand('show mac address-table aging-time'))
      .toContain('Aging Time');
  });

  it('`interface` restreint à un port', async () => {
    await pc.executeCommand('ping -c 1 10.0.0.1');
    const vue = await sw.executeCommand('show mac address-table interface FastEthernet0/2');
    expect(vue).toContain(pc.getPort('eth0')!.getMAC().toString());
    expect(vue).not.toContain(r.getPort('GigabitEthernet0/0')!.getMAC().toString());
  });
});

describe('DHCP fait bien circuler des trames — ce qui a mené au défaut', () => {
  it('un DORA laisse le commutateur avoir appris le client', async () => {
    const pc2 = new LinuxPC('PC2');
    pc2.powerOn();
    new Cable('c').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
    for (const c of ['enable', 'configure terminal',
      'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
      'exit', 'ip dhcp excluded-address 10.0.0.1 10.0.0.5', 'end']) {
      await r.executeCommand(c);
    }
    await pc2.executeCommand('dhclient eth0');

    // L'échange DORA traverse réellement le fil : le commutateur a vu
    // passer les trames du client et l'a appris sur son port.
    expect(await pc2.executeCommand('ip -4 addr show eth0')).toMatch(/inet 10\.0\.0\.\d+/);
    const vue = await sw.executeCommand('show mac address-table');
    expect(vue).toContain(pc2.getPort('eth0')!.getMAC().toString());
    expect(vue).toContain('FastEthernet0/3');
  });
});
