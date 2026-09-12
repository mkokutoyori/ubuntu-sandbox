/*
 * `no shutdown` en configuration GLOBALE : le commutateur l'acceptait,
 * le routeur le refusait, et la meme frappe n'avait donc pas la meme
 * reponse sur deux plateformes du meme constructeur.
 *
 *     this.configTrie.register('no shutdown', 'Enable interface', () => '');
 *
 * Mesure, avant correctif :
 *
 *   ROUTEUR  (config)# no shutdown     ^ % Invalid input detected
 *   CATALYST (config)# no shutdown     (rien)
 *
 *            no s ?  ->  ROUTEUR  : service, snmp-server, sntp
 *                        CATALYST : service, SHUTDOWN, snmp-server, ...
 *            no shutdown ?  ->  CATALYST : <cr>
 *
 * Quatre defauts dans une ligne, et ils s'ajoutent.
 *
 *   1. La commande n'existe pas la : IOS n'a pas de `shutdown` en
 *      configuration globale, et le routeur de ce depot le refuse deja.
 *   2. Elle est ANNONCEE — `no s ?` la propose — donc l'aide conduit
 *      l'operateur vers une frappe sans effet.
 *   3. Sa description promet « Enable interface » alors qu'aucune
 *      interface n'est selectionnee : c'est la description du VRAI
 *      `no shutdown`, celui du sous-mode d'interface, qui fuit vers un
 *      mode ou elle ne veut rien dire.
 *   4. Elle rend la chaine vide, donc elle est acceptee et jetee.
 *
 * L'asymetrie acheve la demonstration : `shutdown` tout court est
 * refuse par les DEUX plateformes en configuration globale. Le
 * commutateur offrait donc la negation d'une commande qu'il refuse —
 * une forme qui ne peut pas etre la negation de quoi que ce soit.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation : les deux
 * plateformes d'un meme constructeur repondent la MEME chose a la meme
 * frappe, et l'aide n'annonce que ce qui s'execute.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 3 des 10 cas
 * tombent, tous du cote commutateur — l'acceptation, l'annonce et le
 * `<cr>`. Les 7 autres sont nommes :
 *
 *   - les trois cas du ROUTEUR sont des NON-REGRESSIONS : il refusait
 *     deja, et le correctif ne doit pas l'atteindre.
 *   - `shutdown` nu refuse sur les deux plateformes passait deja : il
 *     est la pour montrer que le defaut etait une ASYMETRIE, et non un
 *     mode entierement permissif.
 *   - les deux TEMOINS d'interface sont l'essentiel : `shutdown` et
 *     `no shutdown` doivent continuer de fonctionner LA OU ils vivent.
 *     Sans eux, retirer la declaration globale pourrait emporter la
 *     bonne, et la sonde n'en saurait rien.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const nomsAnnonces = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

const PLATEFORMES: Array<[string, () => Cli, string]> = [
  ['routeur', () => new CiscoRouter(`R${serie++}`, 2, 2) as unknown as Cli,
    'GigabitEthernet0/0'],
  ['commutateur', () => new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli,
    'FastEthernet0/1'],
];

async function config(make: () => Cli, ...prelude: string[]): Promise<Cli> {
  const d = make();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

describe.each(PLATEFORMES)('%s — `shutdown` n\'est pas une commande globale',
  (_nom, make, iface) => {
    it('`no shutdown` est refuse en configuration globale', async () => {
      const d = await config(make);
      expect(await d.executeCommand('no shutdown')).toMatch(/Invalid input/);
    });

    it('`shutdown` est refuse en configuration globale', async () => {
      const d = await config(make);
      expect(await d.executeCommand('shutdown')).toMatch(/Invalid input/);
    });

    it('`no s ?` ne l\'annonce pas', async () => {
      const d = await config(make);
      expect(nomsAnnonces(d.cliHelp('no s'))).not.toContain('shutdown');
    });

    it('`no shutdown ?` ne promet pas `<cr>`', async () => {
      const d = await config(make);
      expect(annonceCr(d.cliHelp('no shutdown '))).toBe(false);
    });

    it('sur une INTERFACE, les deux formes marchent — les TEMOINS', async () => {
      const d = await config(make, `interface ${iface}`);
      expect(await d.executeCommand('shutdown'), 'shutdown refuse')
        .not.toMatch(/Invalid input|Incomplete/);
      expect(await d.executeCommand('no shutdown'), 'no shutdown refuse')
        .not.toMatch(/Invalid input|Incomplete/);
    });
  });
