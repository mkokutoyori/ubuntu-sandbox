/**
 * `distribute-list-in` etait declare enable/disable, donc la commande
 * REELLE etait refusee et une commande INEXISTANTE etait acceptee.
 *
 * La reference 6.0.4 en fait une CHAINE : `set distribute-list-in
 * {string}` — « Filter incoming routes. size[35] - datasource(s):
 * router.access-list.name, router.prefix-list.name » — et sa prose
 * ajoute « Limit route updates from the OSPF neighbor based on the NLRI
 * defined in the specified access list. You must create the access list
 * before it can be selected here. »
 *
 * Le schema la declarait `enable('distribute-list-in', …)`. Mesure sur
 * une machine neuve, avant correctif : `set distribute-list-in MALISTE`
 * repondait « allowed values: enable, disable. », tandis que `set
 * distribute-list-in enable` etait accepte, rendu par `show router
 * ospf` — donc rejoue a l'import d'une topologie — et lu par personne.
 * C'est pire qu'un reglage inerte : la machine refuse ce qu'une vraie
 * accepte et accepte ce qu'une vraie refuse.
 *
 * **`config router access-list` n'existait pas du tout** — `unknown
 * configuration path` — donc l'objet que cette commande DESIGNE etait
 * absent, et la reparer sans lui aurait produit une reference vers rien.
 * La grammaire est celle de la reference : `config rule / edit <id>` avec
 * `action`, `prefix`, `wildcard`, `exact-match`.
 *
 * **La regle d'evaluation est celle d'une liste d'acces** : les regles
 * sont ordonnees par identifiant, la premiere qui correspond decide, et
 * l'absence de correspondance REFUSE. Le refus implicite n'est pas une
 * precaution : c'est ce qui fait qu'une liste vide filtre tout plutot
 * que rien, et c'est la posture que ce depot applique partout ou un
 * critere ne peut pas etre tranche.
 *
 * **`exact-match` change le sens du prefixe**, et c'est la seule
 * subtilite du filtre : sans lui, `10.1.0.0 255.255.0.0` couvre tout ce
 * qui tombe DEDANS, y compris un /24 plus specifique ; avec lui, seul le
 * /16 exact correspond. Un cas epingle chacune des deux lectures, sans
 * quoi l'attribut serait range sans etre evalue.
 *
 * **Reutilisation plutot qu'une seconde arithmetique** : `core/ip.ts`
 * porte deja `ipToUint32`, `prefixLengthToMaskUint32` et surtout
 * `wildcardMatches`, dont le commentaire decrit exactement la semantique
 * que la reference appelle « Cisco-style wildcard ». `IpPrefixList`
 * (cote routeur Huawei) a ete lu et ECARTE : sa grammaire est celle de
 * `ip ip-prefix` — `greater-equal` / `less-equal`, et une egalite EXACTE
 * de longueur par defaut — la ou FortiOS couvre par defaut et n'a pas de
 * bornes ; l'y plier aurait demande de traduire `exact-match disable` en
 * `lessEqual: 32` et n'aurait rien su faire du masque generique.
 *
 * **Le schema gagne `optionalParts`**, parce qu'un vrai FortiGate ecrit
 * `set prefix any` (un jeton) ET `set prefix 10.1.0.0 255.255.0.0`
 * (deux) sous le MEME attribut, ce que l'arite fixe du validateur
 * n'admettait pas. La grammaire exacte est jugee dans `onCommit` par
 * `parseAccessListPrefix`, seule ecriture de la regle, que le
 * comparateur relit.
 *
 * Discrimine par `git stash push -- src/network/` : 9 des 12 cas
 * tombent. Les 3 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « sans filtre, la route du voisin est apprise » est le TEMOIN, et
 *     c'est son objet de passer des deux cotes. Il a d'ailleurs servi :
 *     la premiere version de ce fichier lisait `route.source` la ou la
 *     table porte `route.protocol`, si bien que TOUS les cas « la route
 *     est absente » passaient a vide et que seuls les cas « la route
 *     est la » echouaient. Sans temoin, un filtre trop large et un
 *     laboratoire mal lu auraient ete indiscernables ;
 *   - « une regle permit laisse passer la route » et « un prefixe
 *     couvrant accepte une route plus specifique » passaient avant
 *     parce que RIEN ne filtrait — l'acceptation etait garantie par
 *     l'absence de mecanisme ; ils valent desormais pour la regle et
 *     pour la couverture par defaut.
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

function apprises(fw: FortiGate): readonly string[] {
  return fw.getRouteTable().all()
    .filter(route => route.protocol === 'ospf')
    .map(route => route.network);
}

describe('distribute-list-in sur OSPF', () => {
  it('sans filtre, la route du voisin est apprise', async () => {
    const { fw, sh, horloge } = await laboratoire();
    ospfSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).toContain('172.16.0.0');
  });

  it('config router access-list existe et se rend', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config router access-list', 'edit "FILTRE"', 'config rule',
      'edit 1', 'set action deny', 'set prefix 172.16.0.0 255.255.255.0', 'next',
      'end', 'next', 'end');

    const rendu = sh.execute('show router access-list');
    expect(rendu).toContain('edit "FILTRE"');
    expect(rendu).toContain('set prefix 172.16.0.0 255.255.255.0');
  });

  it('la forme REELLE de la commande est acceptee', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config router access-list', 'edit "FILTRE"', 'next', 'end');
    ospfSurPareFeu(sh, 'set distribute-list-in "FILTRE"');

    expect(sh.execute('show router ospf')).toContain('set distribute-list-in "FILTRE"');
  });

  it('la forme enable/disable, qui n_existe pas, est refusee', async () => {
    const { sh } = await laboratoire();
    sh.execute('config router ospf');

    expect(sh.execute('set distribute-list-in enable')).toMatch(/Command fail/);
    sh.execute('abort');
  });

  it('une liste qui n_existe pas est refusee', async () => {
    const { sh } = await laboratoire();
    sh.execute('config router ospf');

    expect(sh.execute('set distribute-list-in "ABSENTE"'))
      .toContain('router access-list');
    sh.execute('abort');
  });

  it('une regle deny retire la route apprise', async () => {
    const { fw, sh, horloge } = await laboratoire();
    run(sh, 'config router access-list', 'edit "FILTRE"', 'config rule',
      'edit 1', 'set action deny', 'set prefix 172.16.0.0 255.255.255.0', 'next',
      'edit 2', 'set action permit', 'set prefix any', 'next',
      'end', 'next', 'end');
    ospfSurPareFeu(sh, 'set distribute-list-in "FILTRE"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).not.toContain('172.16.0.0');
  });

  it('une regle permit laisse passer la route', async () => {
    const { fw, sh, horloge } = await laboratoire();
    run(sh, 'config router access-list', 'edit "FILTRE"', 'config rule',
      'edit 1', 'set action permit', 'set prefix 172.16.0.0 255.255.255.0', 'next',
      'end', 'next', 'end');
    ospfSurPareFeu(sh, 'set distribute-list-in "FILTRE"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).toContain('172.16.0.0');
  });

  it('aucune regle correspondante REFUSE la route', async () => {
    const { fw, sh, horloge } = await laboratoire();
    run(sh, 'config router access-list', 'edit "FILTRE"', 'config rule',
      'edit 1', 'set action permit', 'set prefix 192.168.0.0 255.255.0.0', 'next',
      'end', 'next', 'end');
    ospfSurPareFeu(sh, 'set distribute-list-in "FILTRE"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).not.toContain('172.16.0.0');
  });

  it('un prefixe couvrant accepte une route plus specifique', async () => {
    const { fw, sh, horloge } = await laboratoire();
    run(sh, 'config router access-list', 'edit "FILTRE"', 'config rule',
      'edit 1', 'set action permit', 'set prefix 172.16.0.0 255.255.0.0', 'next',
      'end', 'next', 'end');
    ospfSurPareFeu(sh, 'set distribute-list-in "FILTRE"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).toContain('172.16.0.0');
  });

  it('exact-match exige la longueur exacte', async () => {
    const { fw, sh, horloge } = await laboratoire();
    run(sh, 'config router access-list', 'edit "FILTRE"', 'config rule',
      'edit 1', 'set action permit', 'set prefix 172.16.0.0 255.255.0.0',
      'set exact-match enable', 'next', 'end', 'next', 'end');
    ospfSurPareFeu(sh, 'set distribute-list-in "FILTRE"');

    horloge.advance(CONVERGENCE_MS);

    expect(apprises(fw)).not.toContain('172.16.0.0');
  });

  it('set prefix any est accepte, et deux jetons aussi', async () => {
    const { sh } = await laboratoire();
    const sortie = run(sh, 'config router access-list', 'edit "FILTRE"',
      'config rule', 'edit 1', 'set prefix any', 'next',
      'edit 2', 'set prefix 10.0.0.0 255.0.0.0', 'next', 'end', 'next', 'end');

    expect(sortie).toBe('');
    expect(sh.execute('show router access-list')).toContain('set prefix any');
  });

  it('un prefixe malforme est refuse en nommant les deux formes', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config router access-list', 'edit "FILTRE"', 'config rule', 'edit 1');

    expect(sh.execute('set prefix zorglub')).toContain('`any`');
    sh.execute('abort');
  });
});
