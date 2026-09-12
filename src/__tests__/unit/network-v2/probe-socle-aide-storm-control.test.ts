/*
 * La grammaire de `storm-control` etait JUGEE sans etre ANNONCEE.
 *
 * Une sonde anterieure (`probe-socle-storm-control`) a ferme le premier
 * defaut : le gestionnaire acceptait `storm-control zorglub level 250` et
 * le rendait tel quel. Il juge desormais les trois sortes, les bornes du
 * pourcentage et les deux actions — `parseStormControl` porte cette
 * grammaire, seul, et c'est lui l'autorite de ce qui suit.
 *
 * Ce qui restait est l'autre moitie : l'aide n'en disait RIEN.
 *
 *     storm-control ?                   ->  WORD  Interface storm-control
 *     storm-control broadcast ?         ->  WORD  Interface storm-control
 *                                           <cr>        puis % Incomplete
 *     storm-control broadcast level ?   ->  idem, et idem
 *
 * Un seul glouton portait la famille, donc `?` rendait sa description a
 * tous les rangs et `<cr>` a trois d'entre eux. L'operateur ne pouvait
 * decouvrir ni les trois sortes, ni `level`, ni `pps`/`bps`, ni les deux
 * actions — tout ce que la machine JUGE, elle le taisait — et elle lui
 * promettait par-dessus qu'il pouvait valider une commande incomplete.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. chaque mot que `?` annonce s'EXECUTE ;
 *   3. ce que le moteur JUGE, l'aide le NOMME — c'est la meme grammaire
 *      vue des deux cotes, et deux reponses a une question sont une de
 *      trop ;
 *   4. ce que l'aide annonce, la configuration le relit.
 *
 * Ce qui n'est PAS exige : la mise en page d'IOS, ni la borne haute des
 * formes `pps`/`bps`. Le moteur ne borne pas un debit, donc la place
 * n'annonce aucune plage — une plage annoncee est une plage appliquee, et
 * inventer celle d'IOS demanderait la reference.
 *
 * Discriminee contre l'etat d'avant : 17 des 32 cas tombent. Les 15 qui
 * passent des deux cotes sont les TEMOINS, et ils disent ce que cette
 * correction ne doit PAS changer — la grammaire elle-meme, qui etait deja
 * juste :
 *
 *   - les six frappes completes etaient deja acceptees et deja relues
 *     dans la configuration. La famille change de moteur, pas de
 *     comportement : le gestionnaire qui juge est LE MEME
 *     (`parseStormControl`), et c'est tout l'interet — declarer la
 *     grammaire au socle sans en ecrire une seconde ;
 *   - les sept saisies impossibles etaient deja refusees et deja absentes
 *     de la configuration. Une partie du refus remonte desormais a la
 *     place (`250` n'est plus un pourcentage des l'analyse), et la
 *     reponse ne change pas ;
 *   - les deux negations defaisaient deja ce que la pose avait ecrit.
 *     C'est le temoin qui compte le plus ici, parce que `no` cesse d'etre
 *     un chemin du trie pour devenir un MODIFICATEUR du socle : le
 *     mecanisme change entierement sous une reponse qui, elle, ne bouge
 *     pas.
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
const nomsAnnonces = (aide: string): string[] =>
  mots(aide).filter((m) => m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));
const substitut = (mot: string): boolean =>
  mot.startsWith('<') || /^[A-Z0-9.:$/-]+$/.test(mot);

let serie = 0;
const PORT = 'FastEthernet0/1';

async function surLePort(...cmds: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', `interface ${PORT}`, ...cmds]) {
    await d.executeCommand(c);
  }
  return d;
}

async function config(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show running-config'));
}

const INCOMPLETES = [
  'storm-control broadcast',
  'storm-control broadcast level',
  'storm-control broadcast level pps',
  'storm-control broadcast level bps',
  'storm-control action',
  'no storm-control',
  'srr-queue',
];

const COMPLETES = [
  'storm-control broadcast level 50',
  'storm-control multicast level 80 60',
  'storm-control unicast level pps 1000',
  'storm-control broadcast level bps 2000 1000',
  'storm-control action trap',
  'storm-control action shutdown',
];

describe('une frappe incomplete ne promet pas `<cr>`', () => {
  it.each(INCOMPLETES)('`%s ?`', async (frappe) => {
    const d = await surLePort();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
  });
});

describe('l aide NOMME la grammaire que le moteur juge', () => {
  it.each([
    ['storm-control', ['action', 'broadcast', 'multicast', 'unicast']],
    ['storm-control broadcast', ['level']],
    ['storm-control broadcast level', ['bps', 'pps']],
    ['storm-control action', ['shutdown', 'trap']],
    ['no storm-control', ['action', 'broadcast', 'multicast', 'unicast']],
  ] as Array<[string, string[]]>)('`%s ?`', async (frappe, attendus) => {
    const d = await surLePort();
    expect(nomsAnnonces(d.cliHelp(`${frappe} `)))
      .toEqual(expect.arrayContaining(attendus));
  });

  it('`storm-control broadcast level ?` annonce le POURCENTAGE', async () => {
    const d = await surLePort();
    expect(d.cliHelp('storm-control broadcast level ')).toMatch(/0\.00-100\.00/);
  });
});

describe('chaque mot annonce s EXECUTE', () => {
  it.each([
    'storm-control',
    'storm-control broadcast',
    'storm-control broadcast level',
    'storm-control action',
  ])('`%s ?`', async (base) => {
    const d = await surLePort();
    const offerts = nomsAnnonces(d.cliHelp(`${base} `));
    expect(offerts.filter((m) => !substitut(m)).length,
      `${base} ? n annonce aucun mot`).toBeGreaterThan(0);
    for (const mot of offerts) {
      if (substitut(mot)) continue;
      const essai = await surLePort();
      expect(String(await essai.executeCommand(`${base} ${mot}`)),
        `${base} ${mot}`).not.toMatch(/Invalid input/);
    }
  });
});

describe('la frappe COMPLETE garde son `<cr>` et se relit — les TEMOINS', () => {
  it.each(COMPLETES)('`%s`', async (frappe) => {
    const d = await surLePort();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`).toBe(true);
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
    expect(await config(d), `${frappe} ne se relit pas`).toContain(frappe);
  });
});

describe('ce que le moteur refusait, il le refuse encore — les TEMOINS', () => {
  it.each([
    'storm-control zorglub level 50',
    'storm-control broadcast level 250',
    'storm-control broadcast level -5',
    'storm-control broadcast level 100.01',
    'storm-control broadcast level 50 250',
    'storm-control broadcast level pps zorglub',
    'storm-control action reload',
  ])('`%s`', async (frappe) => {
    const d = await surLePort();
    expect(String(await d.executeCommand(frappe)), frappe).toContain('%');
    expect(await config(d), `${frappe} est rendu`).not.toContain(frappe);
  });
});

describe('la negation defait ce que la pose avait ecrit', () => {
  it('`no storm-control broadcast` retire le seuil', async () => {
    const d = await surLePort('storm-control broadcast level 50');
    expect(await config(d)).toContain('storm-control broadcast level 50');
    await d.executeCommand('configure terminal');
    await d.executeCommand(`interface ${PORT}`);
    await d.executeCommand('no storm-control broadcast');
    expect(await config(d), 'le seuil survit a son retrait')
      .not.toContain('storm-control broadcast level');
  });

  it('`no storm-control action` retire l action', async () => {
    const d = await surLePort('storm-control action trap');
    expect(await config(d)).toContain('storm-control action trap');
    await d.executeCommand('configure terminal');
    await d.executeCommand(`interface ${PORT}`);
    await d.executeCommand('no storm-control action');
    expect(await config(d), 'l action survit a son retrait')
      .not.toContain('storm-control action');
  });
});
