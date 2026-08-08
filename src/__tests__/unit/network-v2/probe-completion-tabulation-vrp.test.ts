/**
 * La complétion par tabulation d'un VRP.
 *
 * Suite du volet Cisco (`probe-completion-tabulation-cisco.test.ts`) ;
 * la mesure de départ et les arbitrages sont dans
 * `docs/PRD-Completion-CLI.md`.
 *
 * Deux manques mesurés, et le second était pire que son équivalent IOS :
 *
 *  - `quit` et `return` CHANGENT bien de vue — vérifié en lisant
 *    l'invite avant et après — et n'étaient annoncés nulle part : ni
 *    par `?`, ni par la tabulation, dans aucune vue, sur aucune des
 *    deux plateformes. Ce sont les deux commandes les plus tapées d'un
 *    VRP.
 *  - `interface ?` ne listait aucun type : le routeur répondait `WORD`,
 *    le commutateur `range`. Faute de types dans l'arbre, `interface Gi`
 *    ne complétait rien sur le routeur — ses ports s'appellent
 *    `GE0/0/0`, et aucun ne commence par « Gi ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import {
  VRP_ROUTER_INTERFACE_TYPES,
  VRP_SWITCH_INTERFACE_TYPES,
} from '@/network/devices/shells/huawei/vrpCommonCommands';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

const listeParAide = (texte: string): string[] =>
  texte.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((w) => w.length > 0);

describe('`quit` et `return` sont annoncés là où ils agissent', () => {
  it('ils changent réellement de vue — la référence de tout le reste', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GigabitEthernet0/0/0');
    expect(r.getPrompt()).toBe('[router-huawei-GigabitEthernet0/0/0]');
    await r.executeCommand('quit');
    expect(r.getPrompt()).toBe('[router-huawei]');
    await r.executeCommand('return');
    expect(r.getPrompt()).toBe('<router-huawei>');
  });

  it('`?` les liste maintenant, dans chaque vue du routeur', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    expect(listeParAide(r.cliHelp(''))).toContain('quit');
    await r.executeCommand('system-view');
    expect(listeParAide(r.cliHelp(''))).toContain('quit');
    expect(listeParAide(r.cliHelp(''))).toContain('return');
    await r.executeCommand('interface GigabitEthernet0/0/0');
    expect(listeParAide(r.cliHelp(''))).toContain('quit');
    expect(listeParAide(r.cliHelp(''))).toContain('return');
  });

  it('la tabulation les complète, dans les mêmes vues', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    expect(r.cliTabCandidates('qu')).toContain('quit');
    await r.executeCommand('system-view');
    expect(r.cliTabCandidates('qu')).toContain('quit');
    expect(r.cliTabCandidates('ret')).toContain('return');
    await r.executeCommand('interface GigabitEthernet0/0/0');
    expect(r.cliTabCandidates('qu')).toContain('quit');
    expect(r.cliTabCandidates('ret')).toContain('return');
  });

  it('le commutateur suit la même règle — un seul module derrière les deux', async () => {
    const s = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    expect(s.cliTabCandidates('qu')).toContain('quit');
    await s.executeCommand('system-view');
    expect(s.cliTabCandidates('ret')).toContain('return');
    expect(listeParAide(s.cliHelp(''))).toContain('return');
    await s.executeCommand('interface GigabitEthernet0/0/1');
    expect(s.cliTabCandidates('qu')).toContain('quit');
    expect(s.cliTabCandidates('ret')).toContain('return');
  });

  it('`return` n\'est PAS proposé en vue utilisateur — il n\'y a rien à remonter', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    expect(r.cliTabCandidates('ret')).toEqual([]);
    expect(listeParAide(r.cliHelp(''))).not.toContain('return');
  });

  it('et jamais en continuation d\'une autre commande', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    expect(r.cliTabCandidates('display qu')).toEqual([]);
    expect(r.cliTabCandidates('display ret')).toEqual([]);
  });
});

describe('`interface ?` liste les types, et la tabulation les écrit', () => {
  it('le routeur annonce exactement les types qu\'il ouvre', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    const listés = listeParAide(r.cliHelp('interface '));
    for (const t of VRP_ROUTER_INTERFACE_TYPES) expect(listés, t.keyword).toContain(t.keyword);
  });

  /**
   * La garde qui empêche la liste de s'écarter de l'analyseur : chaque
   * type annoncé est OUVERT pour de bon, et l'invite le prouve. Une
   * liste recopiée d'une documentation aurait proposé `Ethernet`, que
   * cette plateforme refuse.
   */
  it('et chacun de ces types ouvre réellement une vue', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    const numéro: Record<string, string> = {
      'GigabitEthernet': '0/0/1', 'LoopBack': '0', 'NULL': '0',
      'Vlanif': '1', 'Tunnel': '0/0/1', 'Eth-Trunk': '1',
    };
    for (const t of VRP_ROUTER_INTERFACE_TYPES) {
      const out = await r.executeCommand(`interface ${t.keyword}${numéro[t.keyword]}`);
      expect(String(out), t.keyword).not.toContain('Error');
      expect(r.getPrompt(), t.keyword).toContain(t.keyword);
      await r.executeCommand('quit');
    }
  });

  it('le commutateur a SA liste : ni `NULL` ni `Tunnel`, qu\'il refuse', async () => {
    const s = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await s.executeCommand('system-view');
    const listés = listeParAide(s.cliHelp('interface '));
    for (const t of VRP_SWITCH_INTERFACE_TYPES) expect(listés, t.keyword).toContain(t.keyword);
    expect(listés).not.toContain('NULL');
    expect(listés).not.toContain('Tunnel');
    expect(await s.executeCommand('interface NULL0')).toContain('Error');
  });

  it('`interface Gi` écrit le type, sur les deux plateformes', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    for (const saisie of ['interface g', 'interface Gi', 'interface Gig']) {
      expect(r.cliTabCandidates(saisie), saisie).toEqual(['interface GigabitEthernet']);
    }
    expect(r.cliTabCandidates('interface L')).toEqual(['interface LoopBack']);
    const s = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await s.executeCommand('system-view');
    expect(s.cliTabCandidates('interface Gig')).toEqual(['interface GigabitEthernet']);
  });

  it('les ports concrets restent atteignables, sous le nom que la machine leur donne', async () => {
    // Le routeur nomme ses ports `GE0/0/x` — et `GE` n'est pas un
    // préfixe de `GigabitEthernet`, donc les deux voies coexistent sans
    // se gêner, chacune vraie de la machine.
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    expect(r.cliTabCandidates('interface GE0/0/')).toContain('interface GE0/0/1');
    expect(await r.executeCommand('interface GigabitEthernet0/0/2')).not.toContain('Error');

    const s = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await s.executeCommand('system-view');
    const ports = s.cliTabCandidates('interface GigabitEthernet0/0/');
    expect(ports).toContain('interface GigabitEthernet0/0/1');
    expect(ports.length).toBeGreaterThan(4);
  });
});

describe('les règles que le VRP respectait déjà, et qui doivent le rester', () => {
  it('un mot inconnu n\'ouvre pas la racine', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    expect(r.cliTabCandidates('zzz di')).toEqual([]);
  });

  it('une espace finale ne propose rien', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    expect(r.cliTabCandidates('ip ')).toEqual([]);
  });

  it('`undo` et `display` complètent toujours leurs sous-arbres', async () => {
    const r = new HuaweiRouter('router-huawei', 'AR1');
    await r.executeCommand('system-view');
    expect(r.cliTabCandidates('undo ip ro')).toContain('undo ip route-static');
    expect(r.cliTabCandidates('display ip int')).toEqual(['display ip interface']);
  });
});
