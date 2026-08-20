/**
 * La complétion par tabulation d'un IOS.
 *
 * `docs/PRD-Completion-CLI.md` porte la mesure de départ et les cinq
 * règles d'un vrai équipement. Ce fichier les tient.
 *
 * Ce que la mesure avait trouvé, et qu'aucune de ces règles ne tolère :
 * la complétion FABRIQUAIT des commandes (`zzz ho` rendait
 * `zzz hostname`), elle ignorait tout ce que `?` liste hors du trie
 * (`ex` ne donnait rien alors que `exit` s'exécute partout), elle ne
 * savait rien faire de `do`, et elle mélangeait un type d'interface avec
 * les ports concrets, si bien qu'elle ne complétait plus rien là où la
 * machine réelle écrit le type d'un coup.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function routeurEnConfig(): Promise<CiscoRouter> {
  const r = new CiscoRouter('router-cisco', 'R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

async function commutateurEnConfig(): Promise<CiscoSwitch> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8);
  await s.executeCommand('enable');
  await s.executeCommand('configure terminal');
  return s;
}

describe('Tab ne fabrique jamais une commande', () => {
  it('un mot inconnu arrête la complétion au lieu de repartir de la racine', async () => {
    const r = await routeurEnConfig();
    // Chacune de ces lignes rendait auparavant une commande inventée :
    // `zzz hostname`, `blah interface`, `switchport monitor`.
    expect(r.cliTabCandidates('zzz ho')).toEqual([]);
    expect(r.cliTabCandidates('blah int')).toEqual([]);
    expect(r.cliTabCandidates('switchport mo')).toEqual([]);
  });

  it('la fuite existait aussi en mode interface', async () => {
    const r = await routeurEnConfig();
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(r.cliTabCandidates('foobar ip')).toEqual([]);
  });

  it('mais un ARGUMENT attendu se consomme toujours — sans quoi le correctif casserait la complétion utile', async () => {
    const r = await routeurEnConfig();
    expect(r.cliTabCandidates('ip ho')).toEqual(['ip host']);
    expect(r.cliTabCandidates('ip route 10.0.0.0 255.255.255.'))
      .toContain('ip route 10.0.0.0 255.255.255.0');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(r.cliTabCandidates('no ip addr')).toEqual(['no ip address']);
  });
});

describe('tout ce que `?` liste, Tab le complète', () => {
  /** Les mots que `?` annonce au menu racine d'un mode. */
  const motsDeLAide = (dev: CiscoRouter | CiscoSwitch): string[] =>
    dev.cliHelp('').split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((w) => /^[a-z][\w-]*$/i.test(w));

  const aucunOubli = (dev: CiscoRouter | CiscoSwitch): string[] =>
    motsDeLAide(dev).filter((mot) => {
      const partiel = mot.slice(0, Math.max(2, Math.ceil(mot.length / 2)));
      return !dev.cliTabCandidates(partiel).some((c) => c.toLowerCase() === mot.toLowerCase());
    });

  it('EXEC utilisateur, EXEC privilégié, config et config-if du routeur', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    expect(aucunOubli(r), 'EXEC utilisateur').toEqual([]);
    await r.executeCommand('enable');
    expect(aucunOubli(r), 'EXEC privilégié').toEqual([]);
    await r.executeCommand('configure terminal');
    expect(aucunOubli(r), 'config').toEqual([]);
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(aucunOubli(r), 'config-if').toEqual([]);
  });

  it('les mêmes modes sur le commutateur', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1', 8);
    expect(aucunOubli(s), 'EXEC utilisateur').toEqual([]);
    await s.executeCommand('enable');
    expect(aucunOubli(s), 'EXEC privilégié').toEqual([]);
    await s.executeCommand('configure terminal');
    expect(aucunOubli(s), 'config').toEqual([]);
    await s.executeCommand('interface FastEthernet0/1');
    expect(aucunOubli(s), 'config-if').toEqual([]);
    await s.executeCommand('exit');
    await s.executeCommand('vlan 10');
    expect(aucunOubli(s), 'config-vlan').toEqual([]);
  });

  it('nommément : `exit` et `help` partout, `end`/`do`/`default` en configuration', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    expect(r.cliTabCandidates('ex')).toContain('exit');
    expect(r.cliTabCandidates('hel')).toContain('help');
    // `end` n'existe pas en EXEC : il n'y a rien à terminer.
    expect(r.cliTabCandidates('en')).not.toContain('end');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(r.cliTabCandidates('en')).toContain('end');
    expect(r.cliTabCandidates('defa')).toContain('default');
    expect(r.cliTabCandidates('do')).toContain('do');
  });

  it('elles ne sont proposées qu\'au PREMIER mot — `exit` n\'est pas une suite de `show`', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await r.executeCommand('enable');
    expect(r.cliTabCandidates('show ex')).toEqual([]);
    expect(r.cliTabCandidates('show hel')).toEqual([]);
  });
});

describe('`do` complète l\'arbre EXEC, comme il s\'y exécute', () => {
  it('depuis le mode configuration', async () => {
    const r = await routeurEnConfig();
    expect(r.cliTabCandidates('do sh')).toEqual(['do show']);
    expect(r.cliTabCandidates('do show ip int br')).toEqual(['do show ip interface brief']);
  });

  it('depuis un sous-mode, où il rendait `do shutdown`', async () => {
    const r = await routeurEnConfig();
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(r.cliTabCandidates('do sh')).toEqual(['do show']);
    expect(r.cliTabCandidates('do sh')).not.toContain('do shutdown');
  });

  it('`do ` seul ne propose rien, comme toute espace finale', async () => {
    const r = await routeurEnConfig();
    expect(r.cliTabCandidates('do ')).toEqual([]);
  });

  it('hors configuration, `do` n\'est pas un préfixe', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await r.executeCommand('enable');
    expect(r.cliTabCandidates('do sh')).toEqual([]);
  });
});

describe('un mot-clé et une valeur ne se disputent pas la même place', () => {
  it('le type d\'interface se complète d\'un coup', async () => {
    const r = await routeurEnConfig();
    for (const saisie of ['interface g', 'interface gi', 'interface Gi', 'interface gig']) {
      expect(r.cliTabCandidates(saisie), saisie).toEqual(['interface GigabitEthernet']);
    }
  });

  it('les ports réels reviennent dès que le type est écrit', async () => {
    const s = await commutateurEnConfig();
    const ports = s.cliTabCandidates('interface FastEthernet0/');
    expect(ports).toContain('interface FastEthernet0/1');
    expect(ports).toContain('interface FastEthernet0/8');
    expect(s.cliTabCandidates('interface FastEthernet0/3')).toEqual(['interface FastEthernet0/3']);
  });

  it('et `?` liste les TYPES, ce qu\'un vrai Catalyst fait aussi', async () => {
    const s = await commutateurEnConfig();
    const aide = s.cliHelp('interface ');
    expect(aide).toContain('FastEthernet');
    expect(aide).toContain('Vlan');
    expect(aide).not.toContain('FastEthernet0/1');
  });

  it('une valeur sans mot-clé concurrent est toujours proposée', async () => {
    const r = await routeurEnConfig();
    expect(r.cliTabCandidates('ip route 10.0.0.0 255.255.'))
      .toContain('ip route 10.0.0.0 255.255.255.0');
  });
});

describe('les règles que Tab respectait déjà, et qui doivent le rester', () => {
  it('une espace finale ne propose rien', async () => {
    const r = await routeurEnConfig();
    for (const saisie of ['ip ', 'interface ', 'router ', 'no ']) {
      expect(r.cliTabCandidates(saisie), saisie).toEqual([]);
    }
  });

  it('un préfixe ambigu rend plusieurs candidats — donc Tab n\'écrit rien', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await r.executeCommand('enable');
    expect(r.cliTabCandidates('show i').length).toBeGreaterThan(1);
  });

  it('la casse tapée n\'a pas d\'importance, la réponse porte celle d\'IOS', async () => {
    const r = new CiscoRouter('router-cisco', 'R1');
    await r.executeCommand('enable');
    expect(r.cliTabCandidates('SHO VER')).toEqual(['show version']);
  });
});
