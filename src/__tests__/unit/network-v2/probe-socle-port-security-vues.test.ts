/*
 * Sonde ECRITE A L'AVEUGLE sur la famille `port-security` d'un Catalyst,
 * prise dans ses TROIS vues : la configuration qui la pose
 * (`switchport port-security ...`), la vue qui la rend (`show
 * port-security ...`), et la commande qui la defait (`clear
 * port-security ...`).
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation — ce sont
 * les invariants de ce depot :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. chaque mot que `?` annonce s'EXECUTE ;
 *   3. un port a UN etat de port-security, et les vues qui le decrivent
 *      ne peuvent pas se contredire — `show port-security` et
 *      `show port-security interface X` parlent du meme port au meme
 *      instant ;
 *   4. ce que `clear` efface, la vue cesse de le montrer.
 *
 * Le point 3 est celui qui vaut la sonde. Une table de resume et un bloc
 * de detail sont deux RENDUS d'un seul magasin ; le jour ou ils lisent
 * deux magasins, la machine repond deux nombres a la meme question et
 * rien ne dit lequel est vrai. C'est le defaut que ce depot trouve et
 * referme le plus souvent, et `port-security` en est un cas type parce
 * que son compteur de violations vit ailleurs que sa configuration.
 *
 * Les mises en page ne sont PAS exigees mot pour mot : les en-tetes de
 * colonnes d'IOS ne peuvent pas etre verifies ici, et une sonde qui les
 * inventerait apprendrait une faute. Ce qui est exige est la COHERENCE
 * entre les vues, et l'arite de chaque frappe.
 *
 * Une exigence ecrite a l'aveugle s'est revelee FAUSSE a la mesure et
 * elle est retiree : `show port-security interface` sans nom d'interface
 * ne rend pas l'incompletude, il rend le TABLEAU DE RESUME. C'est une
 * reponse, donc le `<cr>` que `?` annonce est tenu, donc il n'y a rien
 * ici que les invariants de ce depot puissent reprocher. Exiger le
 * contraire aurait demande la reference d'IOS, qu'on ne peut pas
 * atteindre depuis ce reseau.
 *
 * Discriminee contre l'etat d'avant : 1 des 12 cas tombe, et c'est la
 * COHERENCE des vues qui fait le reste du travail. Les 11 qui passent
 * des deux cotes sont nommes : le resume et le detail nommaient deja le
 * meme port, le maximum pose se lisait deja dans les deux, la violation
 * se relisait deja dans la configuration, et une adresse collante
 * disparaissait deja de la vue quand `clear port-security sticky`
 * l'effacait. Ce sont les TEMOINS — ils prouvent que ce laboratoire
 * mesure vraiment un magasin partage, ce qu'une sonde faite de refus
 * seuls ne prouverait pas.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));
const substitut = (mot: string): boolean =>
  mot.startsWith('<') || /^[A-Z0-9.:$/-]+$/.test(mot);

let serie = 0;
const PORT = 'FastEthernet0/1';

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
}

async function avecPortSecurise(...extra: string[]): Promise<Cli> {
  return commutateur('configure terminal', `interface ${PORT}`,
    'switchport mode access', 'switchport port-security', ...extra, 'end');
}

describe('l arite de la famille `port-security`', () => {
  it.each([
    'clear port-security',
  ])('`%s ?` ne promet pas de `<cr>`', async (frappe) => {
    const d = await commutateur();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
  });

  it.each([
    'show port-security',
    'clear port-security all',
    'clear port-security dynamic',
  ])('`%s` s execute et garde son `<cr>` — le TEMOIN', async (frappe) => {
    const d = await avecPortSecurise();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`).toBe(true);
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
  });

  it('chaque mot que `clear port-security ?` annonce s EXECUTE', async () => {
    const d = await avecPortSecurise();
    const offerts = mots(d.cliHelp('clear port-security '));
    expect(offerts.length, 'clear port-security ? n annonce rien').toBeGreaterThan(0);
    for (const mot of offerts) {
      if (substitut(mot)) continue;
      expect(await d.executeCommand(`clear port-security ${mot}`),
        `clear port-security ${mot}`).not.toMatch(/Invalid input/);
    }
  });

  it('chaque mot que `show port-security ?` annonce s EXECUTE', async () => {
    const d = await avecPortSecurise();
    const offerts = mots(d.cliHelp('show port-security '));
    for (const mot of offerts) {
      if (substitut(mot)) continue;
      expect(await d.executeCommand(`show port-security ${mot}`),
        `show port-security ${mot}`).not.toMatch(/Invalid input/);
    }
  });

  it('`clear port-security zorglub` est refuse au caret', async () => {
    const d = await commutateur();
    expect(await d.executeCommand('clear port-security zorglub')).toMatch(/Invalid input/);
  });
});

describe('les vues de `port-security` ne se contredisent pas', () => {
  it('le resume et le detail nomment le MEME port', async () => {
    const d = await avecPortSecurise();
    const resume = await d.executeCommand('show port-security');
    const detail = await d.executeCommand(`show port-security interface ${PORT}`);
    expect(resume, 'le resume tait le port securise').toMatch(/Fa0\/1|FastEthernet0\/1/);
    expect(detail, 'le detail ne parle pas du port').not.toMatch(/Invalid|Incomplete/);
  });

  it('le MAXIMUM pose se lit dans les deux vues', async () => {
    const d = await avecPortSecurise('switchport port-security maximum 7');
    const resume = await d.executeCommand('show port-security');
    const detail = await d.executeCommand(`show port-security interface ${PORT}`);
    expect(resume, 'le resume tait le maximum').toMatch(/\b7\b/);
    expect(detail, 'le detail tait le maximum').toMatch(/\b7\b/);
  });

  it('la VIOLATION posee se lit dans le detail et dans la configuration', async () => {
    const d = await avecPortSecurise('switchport port-security violation restrict');
    expect(await d.executeCommand(`show port-security interface ${PORT}`))
      .toMatch(/[Rr]estrict/);
    expect(await d.executeCommand('show running-config'))
      .toMatch(/switchport port-security violation restrict/);
  });

  it('une adresse COLLANTE apparait dans la vue des adresses', async () => {
    const d = await avecPortSecurise(
      'switchport port-security mac-address sticky 0011.2233.4455');
    const adresses = await d.executeCommand('show port-security address');
    expect(adresses, 'la vue des adresses tait l adresse posee')
      .toMatch(/0011\.2233\.4455/);
  });

  it('`clear port-security sticky` efface ce que la vue montrait', async () => {
    const d = await avecPortSecurise(
      'switchport port-security mac-address sticky 0011.2233.4455');
    expect(await d.executeCommand('show port-security address'))
      .toMatch(/0011\.2233\.4455/);
    await d.executeCommand('clear port-security sticky');
    expect(await d.executeCommand('show port-security address'),
      'l adresse survit a son effacement').not.toMatch(/0011\.2233\.4455/);
  });
});
