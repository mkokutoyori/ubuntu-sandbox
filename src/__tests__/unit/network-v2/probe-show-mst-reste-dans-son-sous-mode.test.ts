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
 * Le cas qui epinglait l'EGALITE des deux vues est tombe, comme il
 * annoncait qu'il le ferait : le tampon d'edition existe desormais
 * (`probe-region-mst-tampon-d-edition`), donc `pending` montre ce qui
 * vient d'etre tape et `current` ce qui est en service, et ils ne se
 * rejoignent qu'a la sortie du sous-mode. Le temoin d'ici ne porte plus
 * que sur ce qu'il a toujours voulu dire — les deux vues RENDENT, dans
 * ce sous-mode et nulle part ailleurs ; laquelle rend quoi est mesure
 * dans la sonde du tampon.
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
      expect(await d.executeCommand(ligne), ligne).toMatch(/Name\s+\[/);
    });

  it.each(['show running-config', 'show vlan brief'])(
    '`%s` traverse toujours depuis le sous-mode MST — les TEMOINS', async (ligne) => {
      const d = await commutateur(...MST);
      expect(await d.executeCommand(ligne), ligne).not.toMatch(/Invalid input/);
    });

  it('les deux vues se separent pendant l\'edition', async () => {
    const d = await commutateur(...MST, 'name LAB', 'revision 7');
    expect(await d.executeCommand('show pending'))
      .not.toBe(await d.executeCommand('show current'));
  });
});
