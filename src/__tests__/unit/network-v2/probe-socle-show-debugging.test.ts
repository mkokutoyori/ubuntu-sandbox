/*
 * `show debugging` etait ecrit TROIS fois, et l'abreviation a la main.
 *
 * Le routeur l'enregistrait dans deux fichiers distincts, avec la meme
 * expression mot pour mot :
 *
 *   CiscoDhcpCommands      show debug             -> getDebugService().format()
 *   CiscoIPSecShowCommands show debugging         -> getDebugService().format()
 *   CiscoSwitchShell       show debugging         -> getDebugService().format()
 *
 * `show debug` n'est pas une commande : c'est l'ABREVIATION de `show
 * debugging`, et IOS la sert parce que son analyseur abrege, pas parce
 * qu'un constructeur l'a ecrite deux fois. L'ecrire a la main est la
 * duplication que ce depot referme le plus souvent — deux ecritures d'un
 * fait ne restent pas egales, et celle-ci avait deja diverge : la forme
 * `condition` existait sous les deux orthographes du routeur et sous
 * AUCUNE du Catalyst, alors que les deux plateformes portent le meme
 * service de debogage, de la meme classe.
 *
 * Une declaration, deux plateformes, et l'abreviation rendue au moteur.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `show debug` repond ce que `show debugging` repond — c'est la
 *      meme commande, abregee ;
 *   2. un routeur et un Catalyst repondent pareil a la meme frappe ;
 *   3. la vue reste refusee avant `enable` ;
 *   4. ce que `debug` allume, `show debugging` le montre.
 *
 * Le point 4 est celui qui vaut la sonde. Une vue de debogage qui rend
 * toujours la meme phrase passerait les trois premiers points sans rien
 * prouver : le laboratoire allume donc un drapeau et le relit.
 *
 * Discriminee contre l'etat d'avant : 3 des 12 cas tombent, et ce sont
 * les trois qui portent sur le CATALYST — sa forme `condition`, l'aide
 * qui l'annonce, et l'egalite des deux plateformes. C'est la mesure de
 * la divergence : le meme service, la meme classe, et une vue qui
 * n'existait que d'un cote parce que deux constructeurs en avaient
 * decide separement.
 *
 * Les 9 temoins disent que la deduplication n'a rien coute : `show
 * debug` etait DEJA servi sur les deux plateformes — par une
 * declaration a la main sur le routeur, par l'abreviation de l'arbre
 * sur le Catalyst — les deux vues rendaient deja la meme phrase sur une
 * machine neuve, un drapeau allume se lisait deja, et la vue etait deja
 * refusee avant `enable`. Ce dernier compte double ici : la version du
 * Catalyst portait un garde `mode === 'user'` ecrit a la main, que le
 * socle rend par sa declaration de modes ; le temoin verifie qu'on n'a
 * pas perdu la barriere en retirant le garde.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

let serie = 0;

type Fabrique = () => Cli;

const ROUTEUR: Fabrique = () => new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
const CATALYST: Fabrique = () =>
  new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;

async function allumee(fabrique: Fabrique, ...prelude: string[]): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

const PLATEFORMES: ReadonlyArray<readonly [string, Fabrique, string]> = [
  ['routeur', ROUTEUR, 'debug ip packet'],
  ['commutateur', CATALYST, 'debug spanning-tree events'],
];

for (const [plateforme, fabrique, drapeau] of PLATEFORMES) {
  describe(`\`show debugging\`, sur un ${plateforme}`, () => {
    it('`show debug` rend ce que `show debugging` rend', async () => {
      const d = await allumee(fabrique, 'enable');
      const abrege = String(await d.executeCommand('show debug'));
      const entier = String(await d.executeCommand('show debugging'));
      expect(abrege, 'l abreviation est refusee').not.toMatch(/Invalid|Ambiguous/);
      expect(abrege, 'les deux orthographes divergent').toBe(entier);
    });

    it('`show debugging condition` est servi', async () => {
      const d = await allumee(fabrique, 'enable');
      expect(await d.executeCommand('show debugging condition'))
        .not.toMatch(/Invalid|Incomplete/);
    });

    it('ce que `debug` allume, la vue le MONTRE', async () => {
      const d = await allumee(fabrique, 'enable');
      const avant = String(await d.executeCommand('show debugging'));
      await d.executeCommand(drapeau);
      const apres = String(await d.executeCommand('show debugging'));
      expect(apres, `${drapeau} ne se lit pas dans la vue`).not.toBe(avant);
    });

    it('la vue reste refusee avant `enable` — le TEMOIN', async () => {
      const d = await allumee(fabrique);
      expect(await d.executeCommand('show debugging')).toMatch(/Invalid input/);
    });

    it('`show debugging ?` annonce `condition`', async () => {
      const d = await allumee(fabrique, 'enable');
      expect(d.cliHelp('show debugging ')).toMatch(/condition/);
    });
  });
}

describe('les deux plateformes repondent PAREIL', () => {
  it('`show debugging` sur une machine neuve', async () => {
    const r = await allumee(ROUTEUR, 'enable');
    const c = await allumee(CATALYST, 'enable');
    expect(String(await c.executeCommand('show debugging')))
      .toBe(String(await r.executeCommand('show debugging')));
  });

  it('`show debugging ?` rend le meme texte', async () => {
    const r = await allumee(ROUTEUR, 'enable');
    const c = await allumee(CATALYST, 'enable');
    expect(c.cliHelp('show debugging ')).toBe(r.cliHelp('show debugging '));
  });
});
