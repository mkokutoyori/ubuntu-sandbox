/*
 * `show access-lists ?` annoncait deux mots que la vue ne lit pas.
 *
 * Sa table de completion declare `interface` et `address` — copies de
 * celle de `show port-security`, qui les honore — alors que le
 * gestionnaire de la vue ACL ne lit qu'UN argument, et le prend pour un
 * NOM de liste :
 *
 *     showAccessListsFrom(listes, args[0])
 *
 * Donc `show access-lists interface` cherche une liste nommee
 * « interface », n'en trouve pas, et rend une vue vide sans un mot. Un
 * mot annonce que le moteur n'evalue pas est le pire des trois etats que
 * ce depot distingue : il a toutes les apparences d'exister sauf
 * l'effet.
 *
 * `show port-security` porte les MEMES deux mots et les honore
 * vraiment. Les deux vues se ressemblaient donc a l'aide et divergeaient
 * a l'execution, ce qui est la facon la plus sure d'egarer un
 * operateur : il a appris la forme sur l'une.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. l'aide n'annonce que ce que le moteur evalue ;
 *   2. ce que le moteur evalue, l'aide le nomme ;
 *   3. un mot que la vue n'honore pas est REFUSE ;
 *   4. les vues repondent aux DEUX portees d'EXEC.
 *
 * Ce que la sonde n'exige PAS : que `show port-security interface` sans
 * nom soit incomplet. Il rend le TABLEAU DE RESUME, une sonde
 * anterieure l'a mesure et c'est une reponse — donc le `<cr>` que `?`
 * annonce la est tenu. La place de l'interface est declaree
 * FACULTATIVE pour cette raison.
 *
 * Discriminee contre l'etat d'avant : 3 des 21 cas tombent — les deux
 * mots retires de l'aide de la vue ACL, et les deux queues que
 * `show port-security` absorbait en silence.
 *
 * Un temoin dit la divergence mieux que les cas qui tombent :
 * `show ip access-lists ?` n'annoncait DEJA pas `interface`. Les deux
 * vues partagent le meme gestionnaire, et une seule des deux portait la
 * table de completion recopiee — donc les deux soeurs ne se decrivaient
 * pas pareil alors qu'elles repondent pareil. C'est la duplication vue
 * par son symptome le plus discret.
 *
 * Les 18 autres temoins portent le resserrement : les cinq vues
 * repondent encore aux DEUX portees d'EXEC, `show port-security
 * interface` garde le `<cr>` qu'il tient, et les deux filtres filtrent
 * toujours — la liste nommee et le maximum d'un port.
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
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;
const PORT = 'FastEthernet0/1';

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

async function avecAcl(...prelude: string[]): Promise<Cli> {
  return commutateur('enable', 'configure terminal',
    'ip access-list standard TRIAGE', 'permit 10.0.0.0 0.0.0.255', 'exit',
    ...prelude, 'end');
}

describe('l aide n annonce que ce que la vue EVALUE', () => {
  it.each(['show access-lists', 'show ip access-lists'])(
    '`%s ?` n annonce pas `interface` ni `address`', async (frappe) => {
      const d = await avecAcl();
      const offerts = nomsAnnonces(d.cliHelp(`${frappe} `));
      expect(offerts, 'un mot que la vue ne lit pas est annonce')
        .not.toContain('interface');
      expect(offerts, 'un mot que la vue ne lit pas est annonce')
        .not.toContain('address');
    });

  it.each(['show access-lists', 'show ip access-lists'])(
    '`%s ?` annonce le NOM qu il attend', async (frappe) => {
      const d = await avecAcl();
      const offerts = nomsAnnonces(d.cliHelp(`${frappe} `));
      expect(offerts.length, `${frappe} ? n annonce rien`).toBeGreaterThan(0);
    });

  it('`show port-security ?` annonce ses deux mots — le TEMOIN', async () => {
    const d = await commutateur('enable');
    expect(nomsAnnonces(d.cliHelp('show port-security ')))
      .toEqual(expect.arrayContaining(['address', 'interface']));
  });
});

describe('un mot que la vue n honore pas est REFUSE', () => {
  it.each([
    'show port-security zorglub',
    'show port-security address zorglub',
  ])('`%s`', async (frappe) => {
    const d = await commutateur('enable');
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });
});

describe('les vues filtrent ce qu elles disent filtrer', () => {
  it('`show access-lists TRIAGE` ne rend que la sienne', async () => {
    const d = await avecAcl('ip access-list standard AUTRE', 'permit any', 'exit');
    const out = String(await d.executeCommand('show access-lists TRIAGE'));
    expect(out, 'la liste demandee manque').toMatch(/TRIAGE/);
    expect(out, 'le filtre ne filtre pas').not.toMatch(/AUTRE/);
  });

  it('`show port-security interface <port>` decrit CE port', async () => {
    const d = await commutateur('enable', 'configure terminal',
      `interface ${PORT}`, 'switchport mode access', 'switchport port-security',
      'switchport port-security maximum 7', 'end');
    const out = String(await d.executeCommand(`show port-security interface ${PORT}`));
    expect(out, 'le maximum pose ne se lit pas').toMatch(/\b7\b/);
  });
});

for (const [portee, prelude] of
  [['utilisateur', []], ['privilegie', ['enable']]] as Array<[string, string[]]>) {
  describe(`les vues repondent en EXEC ${portee} — les TEMOINS`, () => {
    it.each([
      'show access-lists',
      'show ip access-lists',
      'show port-security',
      'show port-security address',
      'show port-security interface',
    ])('`%s`', async (frappe) => {
      const d = await commutateur(...prelude);
      const out = String(await d.executeCommand(frappe));
      expect(out, `${frappe} est refuse`).not.toMatch(/Invalid input|Incomplete/);
    });

    it('`show port-security interface ?` garde son `<cr>` — le TEMOIN', async () => {
      const d = await commutateur(...prelude);
      expect(annonceCr(d.cliHelp('show port-security interface '))).toBe(true);
    });
  });
}
