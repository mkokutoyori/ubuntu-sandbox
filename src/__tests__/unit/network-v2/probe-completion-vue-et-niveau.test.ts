/**
 * `?` et `Tab` repondent a la MEME question, donc au meme verdict.
 *
 * Defaut mesure (audit completion, C1) : dans une vue CLI qui n'inclut
 * que `show version`, la tabulation proposait — et INSERAIT —
 * `show ip route`, une commande que la vue exclut et que l'execution
 * refuse. `?` filtrait correctement au meme instant.
 *
 * La cause n'est pas un filtre absent mais un filtre CONTOURNE :
 * `tabCandidates` filtre bien ses candidats par `laSessionVoit`, puis
 * AJOUTE derriere les regles `privilege` accordees, sans les soumettre a
 * quoi que ce soit. L'ajout existe pour une bonne raison — une commande
 * descendue depuis l'arbre privilegie n'est pas dans l'arbre
 * utilisateur, donc la marche du trie ne peut pas la trouver — mais il
 * doit passer par la meme porte que le reste.
 *
 * Le pendant cote `?` (`completionsAccordeesParNiveau`) etait protege
 * PAR ACCIDENT : ses gardes sur le mode et sur le niveau (« ni 1, ni
 * 15 ») ecartent le cas de la vue sans jamais parler de vue. Un garde
 * qui protege pour une raison qui n'est pas la sienne protege jusqu'au
 * jour ou la raison change ; les deux injections consultent desormais le
 * meme predicat.
 *
 * Ce que la non-regression garde, et c'est le point delicat : hors
 * d'une vue, la tabulation doit TOUJOURS proposer une commande
 * deleguee. Sans ce temoin, on ne distinguerait pas un filtre correct
 * d'un filtre qui a tout ecarte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

type Routeur = CiscoRouter & {
  cliHelp(s: string): string;
  cliTabCandidates(s: string): string[];
  cliTabComplete(s: string): string | null;
};

async function jouer(r: CiscoRouter, cmds: string[]): Promise<void> {
  for (const c of cmds) await r.executeCommand(c);
}

/**
 * Un routeur qui porte LES DEUX mecanismes a la fois : une regle
 * `privilege` qui descend `show ip route` au niveau 5, et une vue qui ne
 * contient que `show version`. C'est leur coexistence qui revele la
 * fuite — une vue seule ne la produit pas.
 */
async function labo(nom: string): Promise<Routeur> {
  const r = new CiscoRouter(nom) as Routeur;
  await jouer(r, [
    'enable', 'configure terminal',
    'enable secret Coffre15!',
    'enable secret level 5 Tech5!',
    'privilege exec level 1 show',
    'privilege exec level 5 show ip route',
    'aaa new-model',
    'parser view NOC', 'secret Vue@NOC2026',
    'commands exec include show version', 'exit',
    'end',
  ]);
  return r;
}

describe('C1 — dans une vue, Tab ne propose pas ce que la vue exclut', () => {
  it('la tabulation ne cite pas une commande hors de la vue', async () => {
    const r = await labo('R1');
    await r.executeCommand('enable view NOC', { passwordInput: 'Vue@NOC2026' });
    expect(await r.executeCommand('show parser view')).toBe("Current view is 'NOC'");
    for (const saisie of ['sh', 'show ', 'show ip', 'show i']) {
      expect(r.cliTabCandidates(saisie), saisie).not.toContain('show ip route');
    }
  });

  it('et ne la complete pas non plus', async () => {
    const r = await labo('R2');
    await r.executeCommand('enable view NOC', { passwordInput: 'Vue@NOC2026' });
    const complete = r.cliTabComplete('show ip');
    expect(complete === null || !complete.includes('route')).toBe(true);
  });

  it('ce que la vue INCLUT reste complete', async () => {
    const r = await labo('R3');
    await r.executeCommand('enable view NOC', { passwordInput: 'Vue@NOC2026' });
    expect(r.cliTabCandidates('sh')).toContain('show');
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
  });

  it('`?` disait deja la verite — les deux portes s accordent', async () => {
    const r = await labo('R4');
    await r.executeCommand('enable view NOC', { passwordInput: 'Vue@NOC2026' });
    const aide = r.cliHelp('show ');
    expect(aide).toContain('version');
    expect(aide).not.toContain('route');
    // Ce que `?` offre a ce rang, la tabulation doit pouvoir le servir,
    // et rien de plus : aucun candidat ne doit sortir de la vue.
    for (const c of r.cliTabCandidates('show ')) {
      expect(String(await r.executeCommand(c)), c).not.toContain('Invalid input');
    }
  });
});

describe('non-regression — hors d une vue, la delegation reste completable', () => {
  it('au niveau 5, Tab propose la commande deleguee', async () => {
    const r = await labo('R5');
    await r.executeCommand('disable');
    await r.executeCommand('enable 5', { passwordInput: 'Tech5!' });
    expect(await r.executeCommand('show privilege')).toContain('level is 5');
    expect(r.cliTabCandidates('show ip r')).toContain('show ip route');
    expect(await r.executeCommand('show ip route')).toContain('Codes:');
  });

  it('au niveau 1, elle ne l est pas — le niveau decide encore', async () => {
    const r = await labo('R6');
    await r.executeCommand('disable');
    expect(await r.executeCommand('show privilege')).toContain('level is 1');
    expect(r.cliTabCandidates('show ip r')).not.toContain('show ip route');
  });

  it('au niveau 15, la tabulation ordinaire fonctionne', async () => {
    const r = await labo('R7');
    expect(r.cliTabCandidates('show ver')).toContain('show version');
    expect(r.cliTabComplete('show ver')).toBe('show version ');
  });
});
