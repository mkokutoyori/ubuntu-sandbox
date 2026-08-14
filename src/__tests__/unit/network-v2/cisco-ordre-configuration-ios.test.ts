/**
 * L'ORDRE des blocs d'une running-config, mesure contre des captures.
 *
 * L'audit relevait deux placements (F3 seconde moitie, F4) et donnait
 * pour les deux la meme raison — « rendu apres les interfaces ». La
 * mesure contre de vraies configurations dit que cette raison est
 * fausse pour l'une des deux et que le defaut est ailleurs.
 *
 * Reference : `ciscoconfparse`, `tests/fixtures/configs/sample_01.ios`
 * et `sample_08.ios` — du texte capture sur de vraies machines, et non
 * un exemple de documentation, dont le HTML ecrase les blancs et dont
 * les extraits ne montrent jamais le fichier entier. Ordre releve, deux
 * fois independamment :
 *
 *     interface Loopback0 … interface Dialer1
 *     router ospf 1
 *     ip route …
 *     ip access-list standard INTERNAL_NETWORKS
 *     access-list 11 permit any
 *     snmp-server community SoMeThaNGwIErd RW 99
 *     route-map IBGP_BLACKHOLE_IN permit 10
 *     control-plane
 *     banner login ^C
 *     line con 0
 *     ntp master
 *     end
 *
 * F4 — `snmp-server community` EST rendu apres les interfaces sur une
 * vraie machine : le constat mesurait donc un comportement correct. Ce
 * qui ne l'est pas, et que la capture montre, c'est qu'il passe AVANT
 * `route-map` ; la table du depot les avait invertis. Le constat visait
 * juste la commande, pour la mauvaise raison.
 *
 * F3 (seconde moitie) — les lignes `privilege …` n'etaient classees
 * NULLE PART : elles tombaient dans le rang des non-classees, c'est-a-dire
 * a une place que rien n'a choisie, entre les listes d'acces et les
 * route-maps. Or une regle `privilege` decrit QUI a le droit de faire
 * QUOI, comme `enable secret`, `aaa`, `parser view` et `username`, que
 * la capture montre toutes groupees dans le bloc de tete avant les
 * interfaces ; et la documentation Cisco enchaine partout `username …`
 * puis `privilege exec level …`. Elle est donc classee juste apres les
 * comptes.
 *
 * Ce qui est en jeu depasse l'affichage : cette configuration est
 * rejouee a l'import d'une topologie, et le dernier cas l'eprouve.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { orderCiscoConfigBlocks } from '@/network/devices/shells/cisco/ciscoConfigSerializer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function jouer(r: CiscoRouter, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await r.executeCommand(c);
  return derniere;
}

function routeur(nom = 'R1'): CiscoRouter {
  return new CiscoRouter(nom);
}

/** Le rang de la premiere ligne qui commence par ce texte. */
function rang(lignes: readonly string[], debut: string): number {
  return lignes.findIndex((l) => l.startsWith(debut));
}

describe('F4 — `snmp-server` passe avant `route-map`', () => {
  it('la regle de tri les met dans l ordre de la capture', () => {
    const rendu = orderCiscoConfigBlocks([
      'route-map IBGP_BLACKHOLE_IN permit 10',
      ' match ip address 11',
      'snmp-server community public RO',
      'access-list 11 permit any',
    ]);
    expect(rang(rendu, 'access-list 11')).toBeLessThan(rang(rendu, 'snmp-server community'));
    expect(rang(rendu, 'snmp-server community')).toBeLessThan(rang(rendu, 'route-map'));
  });

  it('sur une vraie machine aussi', async () => {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal',
      'access-list 11 permit any',
      'route-map BLACKHOLE permit 10', 'exit',
      'snmp-server community public RO',
      'end',
    ]);
    const lignes = (await r.executeCommand('show running-config')).split('\n');
    expect(rang(lignes, 'snmp-server community')).toBeGreaterThan(-1);
    expect(rang(lignes, 'route-map')).toBeGreaterThan(-1);
    expect(rang(lignes, 'snmp-server community')).toBeLessThan(rang(lignes, 'route-map'));
  });

  it('et il reste APRES les interfaces, comme sur la capture', async () => {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal', 'snmp-server community public RO',
      // Sans reglage, IOS ne rend pas de bloc `line con 0` du tout.
      'line console 0', 'exec-timeout 5 0', 'exit', 'end',
    ]);
    const lignes = (await r.executeCommand('show running-config')).split('\n');
    expect(rang(lignes, 'interface ')).toBeLessThan(rang(lignes, 'snmp-server community'));
    expect(rang(lignes, 'snmp-server community')).toBeLessThan(rang(lignes, 'line con'));
  });
});

describe('F3 — une regle `privilege` est classee avec ce qu elle decrit', () => {
  it('elle suit les comptes et precede les interfaces', async () => {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal',
      'username joe privilege 5 secret joe',
      'privilege exec level 5 show ip route',
      'end',
    ]);
    const lignes = (await r.executeCommand('show running-config')).split('\n');
    expect(rang(lignes, 'username joe')).toBeLessThan(rang(lignes, 'privilege exec level 5'));
    expect(rang(lignes, 'privilege exec level 5')).toBeLessThan(rang(lignes, 'interface '));
  });

  it('les quatre espaces sortent groupes, dans l ordre de leur ecriture', async () => {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal',
      'privilege exec level 5 show ip route',
      'privilege configure level 10 interface',
      'privilege interface level 10 shutdown',
      'privilege line level 10 exec-timeout',
      'end',
    ]);
    const lignes = (await r.executeCommand('show running-config')).split('\n');
    const rangs = ['privilege exec', 'privilege configure', 'privilege interface', 'privilege line']
      .map((p) => rang(lignes, p));
    expect(rangs.every((n) => n > -1)).toBe(true);
    expect([...rangs].sort((a, b) => a - b)).toEqual(rangs);
    expect(Math.max(...rangs)).toBeLessThan(rang(lignes, 'interface '));
  });

  it('`privilege level` d une LIGNE reste dans son bloc', async () => {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal',
      'privilege exec level 5 show ip route',
      'line console 0', 'privilege level 15', 'exit', 'end',
    ]);
    const lignes = (await r.executeCommand('show running-config')).split('\n');
    expect(rang(lignes, 'line con')).toBeGreaterThan(-1);
    expect(rang(lignes, ' privilege level 15')).toBeGreaterThan(rang(lignes, 'line con'));
  });
});

describe('l ordre rendu est celui de la capture, de bout en bout', () => {
  it('chaque famille est a sa place', async () => {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal',
      'hostname CORE',
      'enable secret Coffre@2026',
      'aaa new-model',
      'username joe privilege 5 secret joe',
      'privilege exec level 5 show ip route',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
      'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
      'ip route 0.0.0.0 0.0.0.0 10.0.0.254',
      'access-list 11 permit any',
      'snmp-server community public RO',
      'route-map BLACKHOLE permit 10', 'exit',
      'banner motd #ACCES RESERVE#',
      'line console 0', 'exec-timeout 5 0', 'exit',
      'ntp server 10.0.0.9',
      'end',
    ]);
    const lignes = (await r.executeCommand('show running-config')).split('\n');
    const attendu = [
      'hostname CORE',
      'enable secret',
      'aaa new-model',
      'username joe',
      'privilege exec level 5',
      'interface GigabitEthernet0/0',
      'router ospf 1',
      'ip route 0.0.0.0',
      'access-list 11',
      'snmp-server community',
      'route-map BLACKHOLE',
      'banner motd',
      'line con',
      'ntp server',
      'end',
    ];
    const rangs = attendu.map((p) => rang(lignes, p));
    for (let i = 0; i < attendu.length; i++) {
      expect(rangs[i], attendu[i]).toBeGreaterThan(-1);
    }
    expect([...rangs].sort((a, b) => a - b), lignes.join('\n')).toEqual(rangs);
  });

  it('un routeur qui rejoue cette configuration porte les memes regles', async () => {
    const r = routeur('R1');
    await jouer(r, [
      'enable', 'configure terminal',
      'username joe privilege 5 secret joe',
      'privilege exec level 5 show ip route',
      'privilege exec level 1 show',
      'snmp-server community public RO',
      'route-map BLACKHOLE permit 10', 'exit',
      'end',
    ]);
    const avant = await r.executeCommand('show running-config');

    const neuf = routeur('R2');
    await neuf.executeCommand('enable');
    await neuf.executeCommand('configure terminal');
    for (const l of avant.split('\n')) {
      const t = l.trim();
      if (t === '' || t === '!' || t === 'end' || l.startsWith('Building')
        || l.startsWith('Current configuration')) continue;
      await neuf.executeCommand(t);
    }
    await neuf.executeCommand('end');
    const apres = await neuf.executeCommand('show running-config');
    const utiles = (t: string) => t.split('\n')
      .filter((l) => /^(username|privilege|snmp-server|route-map)/.test(l));
    expect(utiles(apres)).toEqual(utiles(avant));
  });
});
