/*
 * La configuration GLOBALE, la derniere branche ou `?` promettait de
 * valider sans le tenir.
 *
 * Le balayage de l'aide, promene a quatre rangs, en rendait vingt-deux
 * sur un Catalyst et quatorze sur un routeur. Les quatorze sont les
 * memes des deux cotes — c'est la famille `aaa`, partagee :
 *
 *     aaa authentication login ?   ->  <cr>  puis  % Incomplete command.
 *     aaa accounting exec ?        ->  <cr>  puis  % Incomplete command.
 *     ... quatorze services, trois phases
 *
 * Une seule place `REST` portait « le nom de la liste, puis les
 * methodes ». Elle prenait toute la fin de la ligne, donc UN mot la
 * remplissait et l'aide declarait la commande valide des le service.
 *
 * Les huit autres sont propres au Catalyst : `monitor session`,
 * `udld message`, `vlan access-map`, `vlan filter`, et leurs quatre
 * miroirs sous `default`.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. l'aide NOMME ce que le moteur juge — les quatre types
 *      d'enregistrement de la comptabilite, le niveau que `commands`
 *      exige, la borne de l'intervalle UDLD ;
 *   3. un routeur et un Catalyst repondent pareil a `aaa …` ;
 *   4. la negation se tape comme sur IOS, sans redire les methodes.
 *
 * Le point 4 est celui qui a decide la forme de la correction. Exiger
 * les methodes rendait `no aaa authentication login default` incomplet ;
 * les rendre facultatives reposait le `<cr>` un rang plus loin, sur
 * `aaa authentication login default ?`. La forme courte est donc
 * declaree comme n'existant QUE niee — ce que le socle sait dire — et
 * les deux frappes redeviennent justes en meme temps.
 *
 * Ce que la sonde n'exige PAS : la borne haute de l'intervalle UDLD ni
 * le libelle exact d'un type d'enregistrement. Elle exige que la borne
 * ANNONCEE soit celle qui est APPLIQUEE, ce que le code porte deja
 * (`UDLD_MESSAGE_TIME_RANGE`).
 *
 * Discriminee contre l'etat d'avant : 48 des 63 cas tombent. Les 15 qui
 * passent des deux cotes sont les TEMOINS, et ils bornent une correction
 * qui RESSERRE quatre grammaires d'un coup :
 *
 *   - les trois formes AAA completes — une authentification, une
 *     autorisation par niveau de commande, une comptabilite avec son
 *     type d'enregistrement — s'executaient deja. Ce sont les trois
 *     chemins que la nouvelle declaration distingue, et ils devaient
 *     traverser le decoupage de la place unique en deux ;
 *   - `no aaa authentication login default` se tapait deja sans les
 *     methodes, et se tape encore : c'est la contrainte qui a decide de
 *     la forme du correctif, et sans ce temoin une declaration qui
 *     exigerait les methodes partout aurait paru juste ;
 *   - `aaa <phase> ?` rendait deja le MEME texte sur les deux
 *     plateformes. La famille est partagee, et elle devait le rester ;
 *   - `udld message time 30`, `vlan access-map`, `vlan filter` et la
 *     chaine SPAN entiere — poser une source, une destination, la lire
 *     dans `show monitor session`, la retirer — fonctionnaient deja. Ce
 *     dernier temoin est le plus lourd du lot : quatre familles quittent
 *     le trie pour le socle, et ce qu'elles font ne change pas.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const nomsAnnonces = (aide: string): string[] =>
  mots(aide).filter((m) => m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

async function routeur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

const SERVICES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['authentication', ['dot1x', 'enable', 'login', 'ppp']],
  ['authorization', ['commands', 'config-commands', 'exec', 'network', 'reverse-access']],
  ['accounting', ['commands', 'connection', 'exec', 'network', 'system']],
];

const AAA_INCOMPLETES = SERVICES.flatMap(([phase, services]) =>
  services.filter((s) => s !== 'commands').map((s) => `aaa ${phase} ${s}`))
  .concat([
    'aaa authorization commands',
    'aaa accounting commands',
    'aaa authorization commands 15',
    'aaa authentication login default',
    'aaa accounting exec default',
    'aaa accounting exec default start-stop',
  ]);

for (const [plateforme, fabrique] of
  [['routeur', routeur], ['commutateur', commutateur]] as Array<[string, typeof routeur]>) {
  describe(`la famille \`aaa\`, sur un ${plateforme}`, () => {
    it.each(AAA_INCOMPLETES)('`%s ?` ne promet pas `<cr>`', async (frappe) => {
      const d = await fabrique('aaa new-model');
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
    });

    it.each([
      'aaa authentication login default local',
      'aaa authorization commands 15 default group tacacs+',
      'aaa accounting exec default start-stop group tacacs+',
    ])('`%s` garde son `<cr>` et s execute — le TEMOIN', async (frappe) => {
      const d = await fabrique('aaa new-model');
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`).toBe(true);
      expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
    });

    it('`no aaa authentication login default` se tape sans les methodes', async () => {
      const d = await fabrique('aaa new-model', 'aaa authentication login default local');
      expect(await d.executeCommand('no aaa authentication login default'))
        .not.toMatch(/Invalid|Incomplete/);
    });

    it.each([
      ['aaa accounting exec default',
        ['none', 'start-stop', 'stop-only', 'wait-start']],
      ['aaa authorization commands', ['<0-15>']],
      ['aaa authentication login', ['default']],
    ] as Array<[string, string[]]>)('`%s ?` nomme ce que le moteur juge',
      async (frappe, attendus) => {
        const d = await fabrique('aaa new-model');
        expect(nomsAnnonces(d.cliHelp(`${frappe} `)))
          .toEqual(expect.arrayContaining(attendus));
      });
  });
}

describe('`aaa ?` repond la MEME chose sur les deux plateformes', () => {
  it.each(SERVICES.map(([phase]) => phase))('`aaa %s ?`', async (phase) => {
    const c = await commutateur('aaa new-model');
    const r = await routeur('aaa new-model');
    expect(c.cliHelp(`aaa ${phase} `)).toBe(r.cliHelp(`aaa ${phase} `));
  });
});

describe('les quatre tetes propres au Catalyst', () => {
  it.each([
    'monitor session',
    'udld message',
    'vlan access-map',
    'vlan filter',
  ])('`%s ?` ne promet pas `<cr>`', async (frappe) => {
    const d = await commutateur();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
  });

  /*
   * `no udld` tout seul eteint UDLD, et `udld` tout seul est incomplet.
   * La premiere declaration de cette famille avait perdu la forme nue —
   * chaque mode portait sa negation, personne ne portait celle de la
   * famille — et `no udld` laissait `udld aggressive` dans la
   * configuration. C'est `lacp-udld-span-slice` qui l'a dit ; le cas
   * entre ici pour que la prochaine declaration ne le reperde pas.
   */
  it('`no udld` eteint ce que `udld aggressive` avait pose', async () => {
    const d = await commutateur('udld aggressive');
    await d.executeCommand('end');
    expect(await d.executeCommand('show running-config')).toMatch(/^udld aggressive$/m);
    await d.executeCommand('configure terminal');
    expect(await d.executeCommand('no udld')).not.toMatch(/Invalid|Incomplete/);
    await d.executeCommand('end');
    expect(await d.executeCommand('show running-config'),
      'le mode survit a son retrait').not.toMatch(/^udld aggressive$/m);
  });

  it('`udld ?` ne promet pas `<cr>`', async () => {
    const d = await commutateur();
    expect(annonceCr(d.cliHelp('udld '))).toBe(false);
    expect(await d.executeCommand('udld')).toMatch(/Incomplete command/);
  });

  it('`udld message ?` annonce la borne qu il applique', async () => {
    const d = await commutateur();
    expect(nomsAnnonces(d.cliHelp('udld message '))).toContain('time');
    expect(d.cliHelp('udld message time ')).toMatch(/1-90/);
  });

  it('`monitor session 1 ?` nomme source et destination', async () => {
    const d = await commutateur();
    expect(nomsAnnonces(d.cliHelp('monitor session 1 ')))
      .toEqual(expect.arrayContaining(['destination', 'source']));
  });

  it.each([
    ['udld message time 30', ''],
    ['vlan access-map CARTE 10', 'config-access-map'],
  ] as Array<[string, string]>)('`%s` s execute — le TEMOIN', async (frappe) => {
    const d = await commutateur();
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
  });

  it('la famille SPAN fonctionne encore de bout en bout — le TEMOIN', async () => {
    const d = await commutateur();
    expect(await d.executeCommand(
      'monitor session 1 source interface FastEthernet0/1 rx'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(await d.executeCommand(
      'monitor session 1 destination interface FastEthernet0/8'))
      .not.toMatch(/Invalid|Incomplete/);
    await d.executeCommand('end');
    expect(await d.executeCommand('show monitor session 1')).toMatch(/Fa0\/1|FastEthernet0\/1/);
    await d.executeCommand('configure terminal');
    expect(await d.executeCommand('no monitor session 1'))
      .not.toMatch(/Invalid|Incomplete/);
  });

  it('`vlan filter CARTE vlan-list 10` s execute — le TEMOIN', async () => {
    const d = await commutateur('vlan access-map CARTE 10', 'exit');
    expect(await d.executeCommand('vlan filter CARTE vlan-list 10'))
      .not.toMatch(/Invalid|Incomplete/);
  });
});
