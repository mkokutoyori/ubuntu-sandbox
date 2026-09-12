/*
 * `show current` et `show pending` s'executaient en EXEC PRIVILEGIE,
 * ou IOS ne les connait pas.
 *
 *     Switch# show cu?
 *       current  Show current MST config
 *     Switch# show current
 *     Name      []
 *     Revision  0     Instances configured 1
 *     ...
 *
 * Ces deux commandes n'existent que dans `spanning-tree mst
 * configuration`. Elles etaient pourtant ANNONCEES et EXECUTABLES a
 * l'invite privilegiee, et la raison etait structurelle, pas un oubli :
 *
 *     if (this.isConfigMode() && lower.startsWith('show ')) {
 *       this.mode = 'privileged';
 *       const output = this.executeOnTrie(cmdPart);
 *
 * Le repartiteur renvoyait TOUT `show ` tape en configuration vers
 * l'arbre privilegie. Le sous-mode MST avait donc beau declarer ses deux
 * vues sur son propre arbre, elles n'etaient jamais consultees — d'ou la
 * seconde declaration sur l'arbre privilegie, et son commentaire qui
 * l'assumait : « The base redirects `show …` in config modes to the
 * privileged trie, so `show current` must also resolve there ». Le
 * contournement marchait, au prix d'exposer la commande dans un mode qui
 * ne la porte pas.
 *
 * Le repartiteur demande maintenant d'abord a l'arbre du mode COURANT
 * s'il resout la ligne, et ne se rabat sur l'arbre privilegie que
 * sinon. `match` repond sans executer, et il connait les abreviations —
 * ce qu'un test par chemin exact aurait perdu. Les deux declarations en
 * double disparaissent.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation : une
 * commande n'est annoncee et executable que dans les modes ou elle
 * existe, et les autres `show` continuent de passer.
 *
 * CE QUI N'EST PAS CORRIGE, et qui est une LIMITE et non un defaut de ce
 * lot : `show current` et `show pending` rendent le MEME texte, parce
 * que ce moteur applique les editions MST immediatement. Sur IOS la
 * distinction est tout l'objet de la paire — `pending` montre le tampon
 * en cours, `current` la configuration active, et elles ne se rejoignent
 * qu'a la sortie du sous-mode. Ici il n'y a pas de tampon, donc les deux
 * vues coincident par CONSTRUCTION, et aucune des deux ne ment sur
 * l'etat de cette machine. Modeler le tampon est un lot en soi. La sonde
 * epingle donc leur egalite comme un fait mesure, pour que le jour ou le
 * tampon existera, ce cas tombe et rappelle qu'il faut le mettre a jour.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 4 des 10 cas
 * tombent — les deux commandes executees en EXEC privilegie, leur
 * annonce par `show cu?`, et `show current` accepte en configuration
 * GLOBALE. Ce quatrieme cas n'etait pas prevu en ecrivant la sonde, et
 * il decoule de la meme cause : le renvoi vers l'arbre privilegie
 * partait de n'importe quel mode de configuration, donc la fuite valait
 * aussi hors du sous-mode MST. Les 6 autres sont ce qui rend la sonde
 * utile plutot que seulement severe : les deux vues doivent CONTINUER de marcher dans le
 * sous-mode MST, l'abreviation aussi, et `show running-config` comme
 * `show vlan brief` doivent continuer de traverser vers l'arbre
 * privilegie depuis ce meme sous-mode. Sans ces quatre derniers, fermer
 * la fuite en cassant le repartiteur passerait pour un succes.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

let serie = 0;

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
}

const MST = ['configure terminal', 'spanning-tree mst configuration'];

describe('`show current`/`show pending` n\'existent que dans le sous-mode MST', () => {
  it.each(['show current', 'show pending'])(
    '`%s` est refuse en EXEC privilegie', async (ligne) => {
      const d = await commutateur();
      expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
    });

  it('`show cu?` ne les annonce pas en EXEC privilegie', async () => {
    const d = await commutateur();
    expect(d.cliHelp('show cu')).not.toMatch(/current/);
  });

  it('`show current` est refuse en configuration globale', async () => {
    const d = await commutateur('configure terminal');
    expect(await d.executeCommand('show current')).toMatch(/Invalid input/);
  });

  it.each(['show current', 'show pending', 'show curr'])(
    '`%s` marche dans le sous-mode MST — les TEMOINS', async (ligne) => {
      const d = await commutateur(...MST, 'name LAB');
      expect(await d.executeCommand(ligne), ligne).toMatch(/Name\s+\[LAB\]/);
    });

  it.each(['show running-config', 'show vlan brief'])(
    '`%s` traverse toujours depuis le sous-mode MST — les TEMOINS', async (ligne) => {
      const d = await commutateur(...MST);
      expect(await d.executeCommand(ligne), ligne).not.toMatch(/Invalid input/);
    });

  /*
   * Le tampon d'edition n'existe pas : les deux vues coincident par
   * construction. Ce cas est un FAIT mesure, pas une exigence — le jour
   * ou le tampon sera modele, il tombera, et ce sera le rappel qu'il
   * faut le reecrire.
   */
  it('les deux vues coincident, faute de tampon d\'edition', async () => {
    const d = await commutateur(...MST, 'name LAB', 'revision 7');
    expect(await d.executeCommand('show pending'))
      .toBe(await d.executeCommand('show current'));
  });
});
