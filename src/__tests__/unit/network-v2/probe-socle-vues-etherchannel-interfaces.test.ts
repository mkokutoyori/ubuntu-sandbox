/*
 * `show etherchannel zorglub` repondait « EtherChannel: no detail ».
 *
 * Le glouton reconnaissait quatre mots — `summary`, `detail`,
 * `load-balance`, `port-channel` — et tout le reste tombait dans un
 * `return 'EtherChannel: no detail'` final. C'est une phrase qu'aucun
 * IOS ne rend, et elle a l'air d'une reponse : l'operateur qui se trompe
 * de mot croit avoir interroge quelque chose qui n'a rien a dire, alors
 * que sa frappe n'existe pas.
 *
 * Une autre forme etait perdue de la meme facon. Le gestionnaire lit
 * `args[0] === 'port-channel'` OU `args[1] === 'port-channel'` — donc
 * `show etherchannel 1 port-channel` marche — mais `show etherchannel 1
 * detail`, qui est la forme d'IOS pour un seul groupe, n'est reconnue
 * nulle part et tombait dans la phrase creuse.
 *
 * Les trois vues d'interface du meme lot n'avaient pas de defaut d'arite
 * — `show queuing interface` exigeait deja son port — mais elles
 * restaient dans l'ancien moteur, et leur place d'interface etait relue
 * mot a mot plutot que declaree.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. un mot que la vue n'honore pas est REFUSE, pas commente ;
 *   2. l'aide NOMME les formes que le moteur juge ;
 *   3. les vues repondent aux DEUX portees d'EXEC ;
 *   4. une place d'interface refuse un port que le chassis n'a pas.
 *
 * Ce que la sonde n'exige PAS : la forme `show etherchannel <groupe>
 * detail`. Le gestionnaire ne la lit pas, et lui inventer un sens
 * demanderait de decider ce qu'IOS y montre — hors de portee depuis ce
 * reseau. Elle est donc REFUSEE, ce qui est la reponse honnete pour une
 * forme que le moteur ne sait pas servir, et c'est ecrit ici pour que la
 * prochaine lecture ne la prenne pas pour un oubli.
 *
 * Discriminee contre l'etat d'avant : 5 des 32 cas tombent — les trois
 * frappes que la phrase creuse absorbait, `load-balance` enfin annonce,
 * et la place de `show interfaces counters` enfin nommee.
 *
 * `load-balance` merite d'etre souligne : le moteur l'HONORE depuis
 * toujours et l'aide ne l'a jamais nomme. C'est le defaut inverse de
 * celui que ce depot rencontre d'habitude — d'ordinaire l'aide annonce
 * plus que le moteur ne tient — et il est plus discret, parce qu'une
 * fonction qu'on ne peut pas decouvrir ressemble a une fonction qui
 * n'existe pas.
 *
 * Les 27 temoins portent le risque de ce lot, qui RESSERRE une vue : les
 * neuf frappes justes repondent encore aux DEUX portees d'EXEC — dix-huit
 * cas a elles seules — `show etherchannel sum` se complete toujours,
 * `show queuing interface` exige toujours son port, un port absent est
 * toujours refuse, et les trois vues lisent toujours ce que la machine
 * porte : un groupe pose, la politique de repartition, un port en
 * jonction.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  cliTabCandidates: (s: string) => string[];
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

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

const VUES = [
  'show etherchannel',
  'show etherchannel summary',
  'show etherchannel detail',
  'show etherchannel load-balance',
  'show etherchannel port-channel',
  'show interfaces trunk',
  'show interfaces counters',
  'show interfaces counters FastEthernet0/1',
  'show queuing interface FastEthernet0/1',
];

for (const [portee, prelude] of
  [['utilisateur', []], ['privilegie', ['enable']]] as Array<[string, string[]]>) {
  describe(`les vues repondent en EXEC ${portee} — les TEMOINS`, () => {
    it.each(VUES)('`%s`', async (frappe) => {
      const d = await commutateur(...prelude);
      const out = String(await d.executeCommand(frappe));
      expect(out, `${frappe} est refuse`).not.toMatch(/^%/m);
    });
  });
}

describe('un mot que la vue n honore pas est REFUSE', () => {
  it.each([
    'show etherchannel zorglub',
    'show etherchannel 1 detail',
    'show etherchannel summary detail',
  ])('`%s`', async (frappe) => {
    const d = await commutateur('enable');
    const out = String(await d.executeCommand(frappe));
    expect(out, `${frappe} rend une phrase`).toMatch(/Invalid input/);
    expect(out, 'la phrase creuse survit').not.toMatch(/no detail/);
  });
});

describe('l aide NOMME les formes que le moteur juge', () => {
  it('`show etherchannel ?` annonce ses quatre formes', async () => {
    const d = await commutateur('enable');
    expect(nomsAnnonces(d.cliHelp('show etherchannel ')))
      .toEqual(expect.arrayContaining(
        ['detail', 'load-balance', 'port-channel', 'summary']));
  });

  it('`show etherchannel sum` se complete — le TEMOIN', async () => {
    const d = await commutateur('enable');
    expect(d.cliTabCandidates('show etherchannel sum'))
      .toEqual(['show etherchannel summary']);
  });

  it('`show etherchannel ?` garde son `<cr>` — le TEMOIN', async () => {
    const d = await commutateur('enable');
    expect(annonceCr(d.cliHelp('show etherchannel '))).toBe(true);
  });

  it('`show interfaces counters ?` annonce la place et garde `<cr>`', async () => {
    const d = await commutateur('enable');
    const aide = d.cliHelp('show interfaces counters ');
    expect(annonceCr(aide), 'la vue globale est perdue').toBe(true);
    // `IFACE` est le rendu que ce depot donne au type INTERFACE.
    expect(aide, 'la place n est pas annoncee').toMatch(/IFACE/);
  });

  it('`show queuing interface ?` ne promet pas `<cr>` — le TEMOIN', async () => {
    const d = await commutateur('enable');
    expect(annonceCr(d.cliHelp('show queuing interface '))).toBe(false);
    expect(await d.executeCommand('show queuing interface'))
      .toMatch(/Incomplete command/);
  });
});

describe('une place d interface refuse un port absent — les TEMOINS', () => {
  it.each([
    'show interfaces counters zorglub',
    'show queuing interface zorglub',
    'show interfaces counters FastEthernet9/9',
  ])('`%s`', async (frappe) => {
    const d = await commutateur('enable');
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });
});

describe('les vues disent ce que la machine porte — les TEMOINS', () => {
  it('`show etherchannel summary` compte les groupes poses', async () => {
    const d = await commutateur('enable', 'configure terminal',
      'interface FastEthernet0/1', 'channel-group 1 mode active', 'end');
    const out = String(await d.executeCommand('show etherchannel summary'));
    expect(out, 'le groupe pose ne se lit pas').toMatch(/Fa0\/1/);
  });

  it('`show etherchannel load-balance` rend la politique', async () => {
    const d = await commutateur('enable');
    expect(String(await d.executeCommand('show etherchannel load-balance')))
      .toMatch(/src-dst-ip|Load-Balancing/);
  });

  it('`show interfaces trunk` rend sa table', async () => {
    const d = await commutateur('enable', 'configure terminal',
      'interface FastEthernet0/1', 'switchport mode trunk', 'end');
    expect(String(await d.executeCommand('show interfaces trunk'))).toMatch(/Fa0\/1/);
  });
});
