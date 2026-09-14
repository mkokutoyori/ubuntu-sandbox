/*
 * Une suite de glouton que le gestionnaire lit en PREMIERE position
 * n'etait jamais annoncee par `?`.
 *
 *   show traffic-shape statistics  ->  « No traffic shaping statistics. »
 *   show traffic-shape ?           ->  WORD / <cr>        (pas `statistics`)
 *
 * La commande s'execute, la frappe est honoree, et l'aide l'ignore :
 * l'aide et l'execution cessent de repondre a la meme question, qui est
 * l'invariant que cette campagne tient depuis le debut.
 *
 * La cause est dans l'adaptateur. Un glouton migre recoit une place
 * `REST` attrape-tout, et `continuationsPourLeSocle` marque TOUTES ses
 * suites `afterArguments: true`. Le chemin declare est donc
 *
 *   show traffic-shape <reste> statistics
 *
 * ou aucune frappe ne peut atteindre `statistics` : la place `REST` a
 * deja tout pris. Le gestionnaire, lui, relit la ligne entiere et
 * reconnait le mot.
 *
 * CE QUI N'EST PAS LE DEFAUT, et pourquoi un correctif EN BLOC serait
 * faux. Le drapeau `afterArguments` est DELIBERE et un test l'epingle
 * deja : `area <n> stub` prend son numero AVANT son mot-cle, et offrir
 * `stub` a la place du numero serait un mensonge. Sur les 62 suites
 * mesurees que `?` n'annonce pas, la majorite est dans ce cas — le
 * moteur REFUSE le mot en tete, et l'aide a raison de le taire :
 *
 *   channel-group active   ->  refus au caret (il faut `channel-group 1
 *                              mode active`)
 *   router ospf vrf        ->  refus au caret (il faut le numero)
 *   ipv6 address eui-64    ->  refus au caret
 *
 * Un troisieme groupe execute sans erreur mais n'honore RIEN : le mot y
 * est avale comme VALEUR. `sntp server prefer` repond « Translating
 * "prefer"... % Bad IP address » — `prefer` y est un nom d'hote, pas un
 * mot-cle. `route-map deny` cree une route-map NOMMEE `deny`. Les
 * annoncer serait un mensonge de plus, pas une correction.
 *
 * Le discriminateur retenu n'est donc ni la documentation ni la sortie,
 * mais le GESTIONNAIRE : branche-t-il sur `args[0]` ? Il a ete lu pour
 * chacune des neuf entrees corrigees ici, et pour chacune de celles qui
 * ne le sont pas. Trois entrees que la mesure laissait suspectes ont
 * ainsi ete ECARTEES apres lecture — `ip flow monitor output` est en
 * `args[1]`, `crypto isakmp keepalive on-demand` et `crypto ipsec
 * security-policy in|out` en `args[2]`.
 *
 * Deux entrees de la table restent non tranchees et ne sont pas
 * corrigees : `clear crypto session remote` et `tunnel
 * path-mtu-discovery age-timer|min-mtu` n'ont aucun glouton a lire sous
 * `devices/shells/`, donc le discriminateur ne s'y applique pas.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 13 des 51 cas
 * tombent — les treize annonces. Les 38 autres sont ce qui empeche de
 * confondre ce correctif avec un correctif EN BLOC :
 *
 *  - TEMOINS d'execution : les treize memes frappes doivent rester
 *    HONOREES. Une suite qu'on annonce et que la commande refuse serait
 *    le meme mensonge dans l'autre sens.
 *  - GARDES du groupe « apres la place » : dix suites doivent rester
 *    refusees en tete ET non annoncees. Ce sont elles qui tombent si on
 *    promeut tout, et c'est exactement le cas `area <n> stub` que le
 *    commentaire de `suitesDeclarees` defend.
 *  - GARDES du groupe « avalee comme valeur » : `sntp server prefer` et
 *    `route-map deny` ne doivent PAS etre annonces, parce que le moteur
 *    ne les honore pas — il en fait un nom d'hote et un nom de
 *    route-map.
 *  - TEMOINS de la forme APRES la place : `show traffic-shape Gi0/0
 *    statistics` et `ip nhrp network-id 42` doivent survivre. Le second
 *    est tombe pendant l'ecriture de ce correctif et l'a corrige :
 *    promouvoir une suite sans lui rendre sa propre queue la coupait de
 *    son argument.
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

const motsDe = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

let serie = 0;

async function routeur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`R${serie++}`, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

async function catalyst(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

const CONFIG_IF_R = ['enable', 'configure terminal', 'interface GigabitEthernet0/0'];
const CONFIG_IF_S = ['enable', 'configure terminal', 'interface FastEthernet0/1'];

type Cas = readonly [string, string, () => Promise<Cli>];

const EN_TETE: readonly Cas[] = [
  ['show traffic-shape', 'statistics', () => routeur('enable')],
  ['show traffic-shape', 'statistics', () => routeur()],
  ['show parser view', 'all', () => routeur('enable')],
  ['show monitor session', 'all', () => catalyst()],
  ['negotiation', 'auto', () => routeur(...CONFIG_IF_R)],
  ['ip nhrp', 'authentication', () => routeur(...CONFIG_IF_R)],
  ['ip nhrp', 'network-id', () => routeur(...CONFIG_IF_R)],
  ['frame-relay', 'interface-dlci', () => routeur(...CONFIG_IF_R)],
  ['frame-relay', 'lmi-type', () => routeur(...CONFIG_IF_R)],
  ['udld port', 'aggressive', () => catalyst(...CONFIG_IF_S)],
  ['dot1x timeout', 'quiet-period', () => catalyst(...CONFIG_IF_S)],
  ['switchport mode private-vlan trunk', 'host', () => catalyst(...CONFIG_IF_S)],
  ['switchport mode private-vlan trunk', 'promiscuous', () => catalyst(...CONFIG_IF_S)],
];

describe('une suite lue en premiere position est ANNONCEE en premiere position', () => {
  it.each(EN_TETE)('`%s ?` annonce `%s`', async (chemin, mot, ouvrir) => {
    const d = await ouvrir();
    expect(motsDe(d.cliHelp(`${chemin} `)), `${chemin} ?`).toContain(mot);
  });

  it.each(EN_TETE)('et `%s %s` est bien honore — le TEMOIN', async (chemin, mot, ouvrir) => {
    const d = await ouvrir();
    expect(await d.executeCommand(`${chemin} ${mot}`), `${chemin} ${mot}`)
      .not.toMatch(/Invalid input/);
  });
});

const APRES_LA_PLACE: readonly Cas[] = [
  ['channel-group', 'active', () => catalyst(...CONFIG_IF_S)],
  ['channel-group', 'mode', () => catalyst(...CONFIG_IF_S)],
  ['router ospf', 'vrf', () => routeur('enable', 'configure terminal')],
  ['ipv6 address', 'eui-64', () => routeur(...CONFIG_IF_R)],
  ['ipv6 ospf', 'area', () => routeur(...CONFIG_IF_R)],
  ['spanning-tree', 'disable', () => catalyst(...CONFIG_IF_S)],
  ['track', 'interface', () => catalyst('enable', 'configure terminal')],
  ['ip igmp snooping', 'immediate-leave', () => catalyst('enable', 'configure terminal')],
  ['login block-for', 'attempts', () => routeur('enable', 'configure terminal')],
  ['ip flow-cache', 'active', () => routeur('enable', 'configure terminal')],
];

describe('une suite que le moteur REFUSE en tete n\'y est pas annoncee', () => {
  it.each(APRES_LA_PLACE)('`%s %s` reste refuse', async (chemin, mot, ouvrir) => {
    const d = await ouvrir();
    expect(await d.executeCommand(`${chemin} ${mot}`), `${chemin} ${mot}`)
      .toMatch(/Invalid input|Incomplete command/);
  });

  it.each(APRES_LA_PLACE)('et `%s ?` ne l\'annonce pas', async (chemin, mot, ouvrir) => {
    const d = await ouvrir();
    expect(motsDe(d.cliHelp(`${chemin} `)), `${chemin} ? offre ${mot}`).not.toContain(mot);
  });
});

describe('une suite AVALEE comme valeur n\'est pas promue non plus', () => {
  it.each([
    ['sntp server', 'prefer', () => routeur('enable', 'configure terminal')],
    ['route-map', 'deny', () => routeur('enable', 'configure terminal')],
  ] as readonly Cas[])('`%s ?` n\'annonce pas `%s`', async (chemin, mot, ouvrir) => {
    const d = await ouvrir();
    expect(motsDe(d.cliHelp(`${chemin} `)), `${chemin} ?`).not.toContain(mot);
  });
});

describe('la forme APRES la place survit — les TEMOINS', () => {
  it('`show traffic-shape Gi0/0 statistics` reste accepte', async () => {
    const d = await routeur('enable');
    expect(await d.executeCommand('show traffic-shape GigabitEthernet0/0 statistics'))
      .not.toMatch(/Invalid input/);
  });

  it('`ip nhrp network-id 42` reste accepte', async () => {
    const d = await routeur(...CONFIG_IF_R);
    expect(await d.executeCommand('ip nhrp network-id 42')).not.toMatch(/Invalid input/);
  });

  it('`show traffic-shape ?` garde sa place libre', async () => {
    const d = await routeur('enable');
    expect(motsDe(d.cliHelp('show traffic-shape '))).toContain('WORD');
  });
});
