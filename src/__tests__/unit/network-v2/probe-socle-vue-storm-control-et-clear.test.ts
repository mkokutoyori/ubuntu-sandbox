/*
 * Une VUE dont le filtre est ignore montre plus qu'on ne lui a demande.
 *
 * `show storm-control` prenait un mot et faisait :
 *
 *     types.includes(filtre) ? [filtre] : types
 *
 * — c'est-a-dire que tout mot inconnu ne restreignait RIEN et la vue
 * rendait les trois sortes de trafic. `show storm-control zorglub`
 * repondait donc la meme table que `show storm-control`, sans un mot
 * pour dire que le filtre avait ete jete. C'est le defaut du critere
 * range sans etre evalue, vu du cote de la lecture : la reponse a l'air
 * juste, et elle repond a une autre question.
 *
 * La famille de POSE est passee au socle plus tot dans cette campagne,
 * avec ses trois sortes declarees. La vue lit desormais la MEME liste :
 * une seule autorite pour ce qu'est une sorte de tempete, du cote ou on
 * la configure comme du cote ou on la relit.
 *
 * `clear port-security` suit dans le meme lot pour une raison de forme :
 * ses quatre genres etaient deja des chemins, mais le filtre
 * `interface <nom>` etait relu mot a mot dans le gestionnaire, donc
 * jamais annonce par `?`.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. un filtre que la vue n'honore pas est REFUSE ;
 *   2. l'aide NOMME les valeurs que le moteur juge ;
 *   3. le filtre FILTRE — la vue restreinte ne montre pas ce que la vue
 *      complete montre ;
 *   4. `clear port-security` reste privilegie, et son filtre d'interface
 *      est annonce.
 *
 * Le point 3 est celui qui vaut la sonde : refuser `zorglub` sans que
 * `broadcast` restreigne quoi que ce soit serait un echange, pas une
 * correction. Le laboratoire pose donc DEUX seuils de sortes
 * differentes sur deux ports, et lit la vue trois fois.
 *
 * Discriminee contre l'etat d'avant : 7 des 17 cas tombent — les deux
 * filtres inventes desormais refuses, les trois sortes enfin annoncees,
 * et les quatre `clear` dont le filtre d'interface entre dans l'aide.
 *
 * Les 10 temoins disent precisement ou N'ETAIT PAS la faute, et c'est ce
 * qui empeche de la corriger de travers : le filtre FILTRAIT deja quand
 * on lui donnait une sorte connue — `broadcast` ne montrait deja que le
 * port broadcast — la vue se lisait deja en EXEC utilisateur, les quatre
 * genres d'effacement s'executaient deja, leur filtre d'interface
 * marchait deja, un nom d'interface invente etait deja refuse, et
 * l'effacement restait deja interdit avant `enable`. Le defaut tenait au
 * SEUL cas du mot inconnu, et la correction ne devait pas couter plus
 * que ce cas-la.
 */
import { describe, it, expect } from 'vitest';
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

let serie = 0;

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

/** Deux ports, deux sortes de tempete : de quoi voir un filtre filtrer. */
async function deuxSeuils(): Promise<Cli> {
  return commutateur('enable', 'configure terminal',
    'interface FastEthernet0/1', 'storm-control broadcast level 10', 'exit',
    'interface FastEthernet0/2', 'storm-control multicast level 20', 'end');
}

describe('le filtre de la vue est JUGE', () => {
  it.each(['show storm-control zorglub', 'show storm-control 42'])(
    '`%s` est refuse', async (frappe) => {
      const d = await deuxSeuils();
      expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
    });

  it('`show storm-control ?` nomme les trois sortes', async () => {
    const d = await commutateur('enable');
    expect(nomsAnnonces(d.cliHelp('show storm-control ')))
      .toEqual(expect.arrayContaining(['broadcast', 'multicast', 'unicast']));
  });
});

describe('le filtre FILTRE', () => {
  it('la vue complete montre les deux seuils — le TEMOIN', async () => {
    const d = await deuxSeuils();
    const out = String(await d.executeCommand('show storm-control'));
    expect(out, 'le seuil de Fa0/1 manque').toMatch(/Fa0\/1/);
    expect(out, 'le seuil de Fa0/2 manque').toMatch(/Fa0\/2/);
  });

  it('`show storm-control broadcast` ne montre que le sien', async () => {
    const d = await deuxSeuils();
    const out = String(await d.executeCommand('show storm-control broadcast'));
    expect(out, 'le seuil broadcast manque').toMatch(/Fa0\/1/);
    expect(out, 'le filtre ne filtre pas').not.toMatch(/Fa0\/2/);
  });

  it('`show storm-control multicast` ne montre que le sien', async () => {
    const d = await deuxSeuils();
    const out = String(await d.executeCommand('show storm-control multicast'));
    expect(out, 'le seuil multicast manque').toMatch(/Fa0\/2/);
    expect(out, 'le filtre ne filtre pas').not.toMatch(/Fa0\/1/);
  });

  it('la vue se lit aussi en EXEC utilisateur — le TEMOIN', async () => {
    const d = await deuxSeuils();
    await d.executeCommand('disable');
    expect(String(await d.executeCommand('show storm-control'))).toMatch(/Fa0\/1/);
  });
});

describe('`clear port-security` garde sa portee et gagne son filtre', () => {
  it.each(['all', 'configured', 'dynamic', 'sticky'])(
    '`clear port-security %s ?` annonce `interface`', async (genre) => {
      const d = await commutateur('enable');
      expect(nomsAnnonces(d.cliHelp(`clear port-security ${genre} `)))
        .toContain('interface');
    });

  it.each(['all', 'dynamic'])('`clear port-security %s` reste servi — le TEMOIN',
    async (genre) => {
      const d = await commutateur('enable');
      expect(await d.executeCommand(`clear port-security ${genre}`), genre)
        .not.toMatch(/Invalid|Incomplete/);
    });

  it('`clear port-security all interface FastEthernet0/1` passe — le TEMOIN', async () => {
    const d = await commutateur('enable');
    expect(await d.executeCommand('clear port-security all interface FastEthernet0/1'))
      .not.toMatch(/Invalid|Incomplete/);
  });

  it.each([
    'clear port-security zorglub',
    'clear port-security all interface zorglub',
  ])('`%s` reste refuse — le TEMOIN', async (frappe) => {
    const d = await commutateur('enable');
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });

  it('reste refuse avant `enable` — le TEMOIN', async () => {
    const d = await commutateur();
    expect(await d.executeCommand('clear port-security all')).toMatch(/Invalid input/);
  });
});
