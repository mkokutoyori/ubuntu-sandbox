/**
 * La complétion par tabulation d'un VRP.
 *
 * Suite du volet Cisco (`probe-completion-tabulation-cisco.test.ts`) ;
 * la mesure de départ et les arbitrages sont dans
 * `docs/PRD-Completion-CLI.md`.
 *
 * Manque mesuré : `quit` et `return` CHANGENT bien de vue — vérifié en
 * lisant l'invite avant et après — et n'étaient annoncés nulle part, ni
 * par `?`, ni par la tabulation, dans aucune vue, sur aucune des deux
 * plateformes. Ce sont les deux commandes les plus tapées d'un VRP.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

/**
 * Le second manque mesuré ici — `interface ?` ne listant aucun type — a
 * été fermé en parallèle par `huaweiInterfaceHelp.ts`, qui DÉRIVE les
 * types de la table du résolveur au lieu d'en tenir une seconde liste à
 * la main : une meilleure réponse que la mienne, et la mienne a été
 * retirée plutôt que gardée à côté.
 *
 * Son arbitrage sur la tabulation diverge du volet Cisco, et c'est
 * juste : sur IOS une ambiguïté rend Tab MUET, donc replier les ports
 * sur le type fait gagner une frappe ; sur VRP la tabulation est
 * CYCLIQUE, donc proposer les ports réels les rend tous atteignables.
 * La même règle donnerait deux résultats opposés — c'est la politique
 * de tabulation de la plateforme qui décide, pas la règle.
 *
 * Les cas ci-dessous ne redisent pas ce que
 * `probe-vrp-aide-et-machine.test.ts` vérifie déjà ; ils tiennent la
 * frontière entre les deux lots, qui est exactement ce qu'une fusion
 * peut casser sans que personne s'en aperçoive.
 */
describe('la frontière avec l\'autre lot tient', () => {
  it('`?` nomme les types, la tabulation rend les ports réels', async () => {
    const s = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await s.executeCommand('system-view');
    expect(listeParAide(s.cliHelp('interface '))).toContain('GigabitEthernet');
    const ports = s.cliTabCandidates('interface Gig');
    expect(ports).toContain('interface GigabitEthernet0/0/1');
  });

  it('et les commandes communes ne parasitent pas cette position', async () => {
    const s = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await s.executeCommand('system-view');
    expect(s.cliTabCandidates('interface qu')).toEqual([]);
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
