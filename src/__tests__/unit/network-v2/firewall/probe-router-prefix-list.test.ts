/**
 * `router prefix-list`, second magasin nomme par `distribute-list-in`,
 * n'existait pas.
 *
 * Le lot precedent a rendu `distribute-list-in` a sa vraie forme — une
 * chaine nommant un objet — et n'a pu declarer qu'UNE des deux sources
 * de donnees que la reference lui donne (`router.access-list.name`,
 * `router.prefix-list.name`). Nommer une liste de prefixes etait donc
 * refuse comme une reference inconnue : honnete tant que l'objet
 * n'existe pas, et un manque des qu'on peut le combler.
 *
 * **La reference dit ce qu'est une liste de prefixes et ce qui la
 * distingue** : « prefix lists … are enhanced versions of an access
 * list that allows you to control the length of the prefix netmask.
 * Each rule … consists of a prefix (IP address and netmask), the action
 * to take for this prefix (permit or deny), and maximum and minimum
 * prefix length settings. » La regle de decision est la MEME que celle
 * de la liste d'acces, et elle est citee plutot que deduite : « attempts
 * to match … starting at the top of the list. If it finds a match … it
 * takes the action specified for that prefix. If no match is found the
 * default action is deny. »
 *
 * **`IpPrefixList` est REUTILISE, et c'est le retournement de la
 * decision precedente.** Le lot `distribute-list-in` avait lu ce module
 * et l'avait ECARTE pour la liste d'acces, sa grammaire etant celle de
 * `ip ip-prefix` — `greater-equal` / `less-equal`, avec une egalite
 * EXACTE de longueur par defaut — la ou une liste d'acces couvre par
 * defaut et n'a pas de bornes. Ici c'est exactement la bonne
 * grammaire : `ge` et `le` SONT `greaterEqual` et `lessEqual`, et le
 * defaut exact est celui d'une liste de prefixes. Ecrire un second
 * comparateur aurait donne deux reponses possibles a « ce prefixe
 * correspond-il ? ». Le transport est `IpPrefixEntry` lui-meme, pour
 * qu'aucune couche de traduction ne s'interpose entre la CLI et le
 * comparateur.
 *
 * **`any` ne veut PAS dire la meme chose dans les deux objets**, et
 * c'est la difference que ce fichier existe pour epingler. Dans une
 * liste d'acces, `set prefix any` couvre tout — sans bornes de longueur,
 * il ne pourrait rien vouloir dire d'autre. Dans une liste de prefixes,
 * `any` est `0.0.0.0/0` et la regle standard s'applique : sans `ge`/`le`
 * il ne correspond qu'a la route par defaut, ce que la reference
 * confirme en ecrivant « A prefix-list should be used to match the
 * default route 0.0.0.0/0 » — et c'est pourquoi l'idiome reel pour tout
 * prendre est `set prefix any` AVEC `set ge 0` et `set le 32`.
 *
 * Discrimine par `git stash push -- src/network/` : 6 des 12 cas
 * tombent. Les 6 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « sans filtre, la route du voisin est apprise » est le TEMOIN ;
 *   - « une regle permit sur le prefixe exact laisse passer », « le
 *     meme prefixe avec ge et le couvre le plus specifique » et « any
 *     avec ge 0 et le 32 prend tout » passaient par VACUITE : nommer la
 *     liste etait refuse, donc aucun filtre n'etait pose et la route
 *     entrait de toute facon ; ils valent desormais pour la regle, pour
 *     les bornes et pour l'idiome ;
 *   - « dans une liste d'ACCES, any prend tout sans aucune borne »
 *     passe des deux cotes parce que la liste d'acces existe depuis le
 *     lot precedent : c'est le cas de CONTRASTE, celui qui donne son
 *     sens a la difference entre les deux objets, et il ne prouve rien
 *     seul ;
 *   - « ge hors des bornes attestees est refuse » passait parce que
 *     `ge` n'existait pas du tout, donc le refus etait indiscernable de
 *     l'absence ; il vaut desormais pour la borne.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (device: Cmd, commands: string[]) =>
  commands.reduce(async (previous, command) => {
    await previous;
    await device.executeCommand(command);
  }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const CONVERGENCE_MS = 45_000;

async function laboratoire() {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  const horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const voisin = new CiscoRouter('R1', 200, 0);
  new Cable('transit').connect(
    fw.getPort('port2')!, voisin.getPort('GigabitEthernet0/0')!);

  run(sh, 'config system interface',
    'edit "port2"', 'set mode static', 'set ip 10.0.0.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end');

  await runOn(voisin, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
    'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 172.16.0.1 255.255.255.0',
    'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2',
    'network 10.0.0.0 0.0.0.255 area 0',
    'network 172.16.0.0 0.0.0.255 area 0', 'end',
  ]);

  return { fw, sh, horloge };
}

function ospfSurPareFeu(sh: FortiShell, ...extra: readonly string[]): string {
  return run(sh, 'config router ospf', 'set router-id 1.1.1.1',
    'config area', 'edit 0.0.0.0', 'next', 'end',
    'config network', 'edit 1', 'set prefix 10.0.0.0 255.255.255.0',
    'set area 0.0.0.0', 'next', 'end',
    ...extra, 'end');
}

function listeDePrefixes(sh: FortiShell, ...regles: readonly string[]): void {
  run(sh, 'config router prefix-list', 'edit "PL"', 'config rule',
    ...regles, 'end', 'next', 'end');
}

function apprises(fw: FortiGate): readonly string[] {
  return fw.getRouteTable().all()
    .filter(route => route.protocol === 'ospf')
    .map(route => route.network);
}

describe('router prefix-list', () => {
  it('sans filtre, la route du voisin est apprise', async () => {
    const { fw, sh, horloge } = await laboratoire();
    ospfSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).toContain('172.16.0.0');
  });

  it('config router prefix-list existe et se rend', async () => {
    const { sh } = await laboratoire();
    listeDePrefixes(sh,
      'edit 1', 'set action permit', 'set prefix 172.16.0.0 255.255.255.0',
      'set ge 24', 'set le 32', 'next');

    const rendu = sh.execute('show router prefix-list');
    expect(rendu).toContain('edit "PL"');
    expect(rendu).toContain('set ge 24');
    expect(rendu).toContain('set le 32');
  });

  it('distribute-list-in accepte une liste de prefixes', async () => {
    const { sh } = await laboratoire();
    listeDePrefixes(sh, 'edit 1', 'set prefix any', 'next');
    ospfSurPareFeu(sh, 'set distribute-list-in "PL"');

    expect(sh.execute('show router ospf')).toContain('set distribute-list-in "PL"');
  });

  it('une regle permit sur le prefixe exact laisse passer', async () => {
    const { fw, sh, horloge } = await laboratoire();
    listeDePrefixes(sh,
      'edit 1', 'set action permit', 'set prefix 172.16.0.0 255.255.255.0', 'next');
    ospfSurPareFeu(sh, 'set distribute-list-in "PL"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).toContain('172.16.0.0');
  });

  it('une regle deny retire la route', async () => {
    const { fw, sh, horloge } = await laboratoire();
    listeDePrefixes(sh,
      'edit 1', 'set action deny', 'set prefix 172.16.0.0 255.255.255.0', 'next',
      'edit 2', 'set action permit', 'set prefix any', 'set ge 0', 'set le 32', 'next');
    ospfSurPareFeu(sh, 'set distribute-list-in "PL"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).not.toContain('172.16.0.0');
  });

  it('aucune regle correspondante REFUSE la route', async () => {
    const { fw, sh, horloge } = await laboratoire();
    listeDePrefixes(sh,
      'edit 1', 'set action permit', 'set prefix 192.168.0.0 255.255.0.0', 'next');
    ospfSurPareFeu(sh, 'set distribute-list-in "PL"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).not.toContain('172.16.0.0');
  });

  it('un prefixe couvrant SANS ge ni le ne correspond pas au plus specifique', async () => {
    const { fw, sh, horloge } = await laboratoire();
    listeDePrefixes(sh,
      'edit 1', 'set action permit', 'set prefix 172.16.0.0 255.255.0.0', 'next');
    ospfSurPareFeu(sh, 'set distribute-list-in "PL"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).not.toContain('172.16.0.0');
  });

  it('le meme prefixe avec ge et le couvre le plus specifique', async () => {
    const { fw, sh, horloge } = await laboratoire();
    listeDePrefixes(sh,
      'edit 1', 'set action permit', 'set prefix 172.16.0.0 255.255.0.0',
      'set ge 16', 'set le 24', 'next');
    ospfSurPareFeu(sh, 'set distribute-list-in "PL"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).toContain('172.16.0.0');
  });

  it('any seul ne prend que la route par defaut, pas tout', async () => {
    const { fw, sh, horloge } = await laboratoire();
    listeDePrefixes(sh, 'edit 1', 'set action permit', 'set prefix any', 'next');
    ospfSurPareFeu(sh, 'set distribute-list-in "PL"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).not.toContain('172.16.0.0');
  });

  it('any avec ge 0 et le 32 prend tout, l_idiome reel', async () => {
    const { fw, sh, horloge } = await laboratoire();
    listeDePrefixes(sh, 'edit 1', 'set action permit', 'set prefix any',
      'set ge 0', 'set le 32', 'next');
    ospfSurPareFeu(sh, 'set distribute-list-in "PL"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).toContain('172.16.0.0');
  });

  it('dans une liste d_ACCES, any prend tout sans aucune borne', async () => {
    const { fw, sh, horloge } = await laboratoire();
    run(sh, 'config router access-list', 'edit "AL"', 'config rule',
      'edit 1', 'set action permit', 'set prefix any', 'next',
      'end', 'next', 'end');
    ospfSurPareFeu(sh, 'set distribute-list-in "AL"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).toContain('172.16.0.0');
  });

  it('ge hors des bornes attestees est refuse', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config router prefix-list', 'edit "PL"', 'config rule', 'edit 1');

    expect(sh.execute('set ge 33')).toMatch(/Command fail/);
    sh.execute('abort');
  });
});
