/*
 * L'adresse du questionneur IGMP etait validee par une expression
 * reguliere qui accepte `999.999.999.999`.
 *
 *     if (on && !/^\d{1,3}(\.\d{1,3}){3}$/.test(rest[1])) return INVALID;
 *
 * C'est l'exemple que ce depot cite mot pour mot dans sa regle sur les
 * types : quatre groupes de un a trois chiffres ne font pas une adresse,
 * et le controle qui s'en contente laisse entrer un etat impossible. Le
 * questionneur pose son adresse dans les requetes qu'il emet ; une
 * adresse hors domaine n'est pas une faute d'affichage, c'est une source
 * que rien sur le reseau ne peut joindre.
 *
 * Les VUES de cette famille sont passees au socle plus tot dans cette
 * campagne. La CONFIGURATION restait a l'arbre, sous deux gloutons qui
 * relisaient leur grammaire mot a mot. Une famille dont on a migre la
 * lecture et pas l'ecriture est le pire des deux etats : il faut se
 * demander, pour chaque frappe, quel moteur repond.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. une adresse est une ADRESSE — `999.999.999.999` est refuse ;
 *   2. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   3. une borne annoncee est une borne appliquee ;
 *   4. ce que la configuration pose, la vue le montre — les deux cotes
 *      de la famille lisent le meme agent.
 *
 * Le point 4 est celui qui vaut la sonde : la pose et la vue viennent
 * desormais du meme moteur, et c'est verifiable en allumant le
 * questionneur puis en le relisant.
 *
 * UNE INCOHERENCE TROUVEE PAR CE POINT, ET FERMEE. `ip pim snooping`
 * s'acceptait, l'agent le retenait, `show ip pim snooping` le montrait —
 * et `show running-config` n'en portait AUCUNE trace. Un export de
 * topologie perdait donc le reglage en silence, et le reimport rendait
 * un commutateur qui ne surveille plus le PIM sans qu'un mot le dise.
 * Deux vues d'un seul etat qui se contredisaient : le defaut que ce
 * depot trouve et referme le plus souvent. Son voisin IGMP avait son
 * serialiseur depuis toujours ; PIM n'en avait pas.
 *
 * Discriminee contre l'etat d'avant : 15 des 26 cas tombent. Les 11 qui
 * passent des deux cotes sont les TEMOINS, et ils disent ce que les
 * gloutons faisaient DEJA bien : `zorglub` etait refuse (le controle
 * existait, il etait seulement trop large), les bornes de l'intervalle
 * etaient deja appliquees aux trois valeurs mesurees, les identifiants
 * de VLAN etaient deja juges des deux cotes, `ip igmp snooping ?`
 * nommait deja ses deux suites, et les deux vues relisaient deja ce que
 * la configuration avait pose. Le defaut tenait au DOMAINE de l'adresse
 * et a l'arite — pas au reste.
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

async function config(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

describe('une adresse est une ADRESSE', () => {
  it.each([
    'ip igmp snooping querier address 999.999.999.999',
    'ip igmp snooping querier address 10.0.0.256',
    'ip igmp snooping querier address zorglub',
    'ip igmp snooping vlan 10 querier address 999.999.999.999',
  ])('`%s` est refuse', async (frappe) => {
    const d = await config('vlan 10', 'exit');
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });

  it('`ip igmp snooping querier address 10.0.0.1` reste accepte — le TEMOIN', async () => {
    const d = await config();
    expect(await d.executeCommand('ip igmp snooping querier address 10.0.0.1'))
      .not.toMatch(/Invalid|Incomplete/);
  });
});

describe('les bornes annoncees sont les bornes appliquees', () => {
  it('`ip igmp snooping querier query-interval ?` annonce sa plage', async () => {
    const d = await config();
    expect(nomsAnnonces(d.cliHelp('ip igmp snooping querier query-interval ')))
      .toContain('<1-18000>');
  });

  it.each([
    'ip igmp snooping querier query-interval 0',
    'ip igmp snooping querier query-interval 18001',
  ])('`%s` est refuse — le TEMOIN', async (frappe) => {
    const d = await config();
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });

  it('`ip igmp snooping querier query-interval 125` passe — le TEMOIN', async () => {
    const d = await config();
    expect(await d.executeCommand('ip igmp snooping querier query-interval 125'))
      .not.toMatch(/Invalid|Incomplete/);
  });

  it('`ip igmp snooping vlan ?` annonce l identifiant', async () => {
    const d = await config();
    expect(nomsAnnonces(d.cliHelp('ip igmp snooping vlan '))).toContain('<1-4094>');
  });

  it.each([
    'ip igmp snooping vlan 5000',
    'ip pim snooping vlan 5000',
  ])('`%s` est refuse — le TEMOIN', async (frappe) => {
    const d = await config();
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });
});

describe('une frappe incomplete le dit, et son aide aussi', () => {
  it.each([
    'ip igmp snooping querier address',
    'ip igmp snooping querier query-interval',
    'ip igmp snooping vlan',
    'ip igmp snooping vlan 10 mrouter',
    'ip igmp snooping vlan 10 mrouter interface',
    'ip pim snooping vlan',
  ])('`%s ?`', async (frappe) => {
    const d = await config('vlan 10', 'exit');
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
  });
});

describe('l aide NOMME la grammaire que le moteur juge', () => {
  it.each([
    ['ip igmp snooping', ['querier', 'vlan']],
    ['ip igmp snooping querier', ['address', 'query-interval']],
    ['ip igmp snooping vlan 10', ['immediate-leave', 'mrouter', 'querier']],
    ['ip pim snooping', ['vlan']],
  ] as Array<[string, string[]]>)('`%s ?`', async (frappe, attendus) => {
    const d = await config('vlan 10', 'exit');
    expect(nomsAnnonces(d.cliHelp(`${frappe} `)))
      .toEqual(expect.arrayContaining(attendus));
  });
});

describe('ce que la configuration pose, la VUE le montre', () => {
  it('le questionneur allume se relit dans la vue', async () => {
    const d = await config('ip igmp snooping', 'ip igmp snooping querier',
      'ip igmp snooping querier address 10.0.0.1');
    await d.executeCommand('end');
    const vue = String(await d.executeCommand('show ip igmp snooping querier'));
    expect(vue, 'la vue tait l adresse posee').toMatch(/10\.0\.0\.1/);
  });

  it('un port mrouter statique se relit dans la vue', async () => {
    const d = await config('vlan 10', 'exit', 'ip igmp snooping',
      'ip igmp snooping vlan 10 mrouter interface FastEthernet0/1');
    await d.executeCommand('end');
    const vue = String(await d.executeCommand('show ip igmp snooping mrouter'));
    expect(vue, 'la vue tait le port statique').toMatch(/Fa0\/1|FastEthernet0\/1/);
  });

  it('le VLAN active se relit dans la configuration — le TEMOIN', async () => {
    const d = await config('vlan 10', 'exit', 'no ip igmp snooping vlan 10');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')))
      .toMatch(/no ip igmp snooping vlan 10/);
  });

  it('`ip pim snooping` pose et relu — le TEMOIN', async () => {
    const d = await config('ip pim snooping');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')))
      .toMatch(/ip pim snooping/);
  });
});
