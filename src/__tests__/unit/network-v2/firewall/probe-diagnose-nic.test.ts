/**
 * Les compteurs d'un port etaient mesures et lus par personne.
 *
 * `Port` tient depuis toujours ce que la RFC 2863 appelle l'`ifTable` —
 * `framesIn`/`framesOut`, `bytesIn`/`bytesOut`, `errorsIn`/`errorsOut`,
 * `dropsIn`/`dropsOut`, `multicastIn` — et les incremente aux vrais
 * points d'emission, de reception et de rejet. AUCUNE commande de la
 * CLI FortiOS ne les lisait : ni `get system interface`, ni `diagnose
 * netlink`, rien. Sur une vraie machine c'est `diagnose hardware
 * deviceinfo nic <interface>` qui les montre, et c'est la premiere
 * commande de tout diagnostic de couche 1 ou 2 — « l'interface
 * compte-t-elle des erreurs ? » n'avait pas de reponse.
 *
 * Aucun magasin n'a ete cree : c'est un moteur sans porte, pas un
 * moteur absent. Les dix champs de la ligne `stat:` attestee — `rxp
 * txp rxb txb rxe txe rxd txd mc collision` — sont tous deja mesures,
 * `collision` excepte, qui vaut zero et **le vaut pour de bon** : ce
 * simulateur n'a ni demi-duplex ni CSMA/CD, donc zero est la verite et
 * non un remplissage.
 *
 * **Ce qui est rendu, et ce qui ne l'est pas.** Les transcriptions
 * attestees viennent toutes de materiel a deport (NP6LITE, NP7) et ne
 * portent pas les memes champs l'une que l'autre : blocs `==== Host
 * Counters ====`, `pm_mode`, `SerDes_if`, `eif_id`. Rien de tout cela
 * n'est ecrit ici, et pas par prudence — ce simulateur ne modelise
 * AUCUN deport materiel, donc ces blocs decriraient une puce absente.
 * `Description` et `Driver Name` sont omis pour la meme raison : le
 * profil de ce pare-feu ne porte aucun nom de carte, et l'inventer
 * serait exactement le defaut qu'on referme. Ne restent que les champs
 * que la machine sait mesurer, dans la mise en forme attestee — nom
 * cale sur 22 colonnes, deux-points colle a la valeur sauf pour les
 * deux adresses.
 *
 * **Un defaut a ete trouve en chemin et corrige avec.** `permanentMacOf`
 * lisait `aggregateSavedMacs`, le magasin de RESTAURATION de
 * l'agregation, alors qu'il existe un SECOND magasin de restauration —
 * `permanentMacs`, celui de la grappe FGCP. Sur un pare-feu en grappe,
 * la question « quelle est l'adresse d'usine ? » recevait donc
 * l'adresse VIRTUELLE, ce qui est l'inverse de la reponse : c'est
 * precisement le couple `Current_HWaddr`/`Permanent_HWaddr` qui existe
 * pour montrer que la grappe a pris la main. Le defaut etait deja
 * visible dans la vue LACP (`permanent MAC addr:`) des qu'une grappe
 * etait configuree. Les deux magasins de restauration RESTENT, chacun
 * rendant sa couche ; ce qui est unifie est la QUESTION, par un
 * `factoryMacs` rempli au premier ecrasement, quel qu'il soit, donc
 * juste dans les deux ordres possibles.
 *
 * Discrimine par `git stash push -- src/network/` : 9 des 11 cas
 * tombent. Les 2 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « le trafic traverse vraiment » est le TEMOIN, et c'est son objet
 *     de passer des deux cotes : sans lui, des compteurs a zero et un
 *     laboratoire qui ne transporte rien seraient indiscernables ;
 *   - « la vue LACP nomme toujours l'adresse d'usine du membre » garde
 *     que l'unification de `permanentMacOf` n'a pas casse son seul
 *     lecteur d'avant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const pc = new LinuxPC('linux-pc', 'PC', 200, 0);
  pc.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, pc.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end');

  await runOn(pc, 'ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0');

  return { fw, sh, pc };
}

function statOf(vue: string): Record<string, number> {
  const ligne = vue.split('\n').find(l => l.startsWith('stat: ')) ?? '';
  const champs: Record<string, number> = {};
  for (const paire of ligne.slice('stat: '.length).split(' ')) {
    const [nom, valeur] = paire.split('=');
    if (nom !== undefined && valeur !== undefined) champs[nom] = Number(valeur);
  }
  return champs;
}

describe('diagnose hardware deviceinfo nic', () => {
  it('le trafic traverse vraiment', async () => {
    const { pc } = await laboratoire();

    expect(await runOn(pc, 'ping -c 3 10.1.1.1')).toContain('0% packet loss');
  });

  it('les compteurs suivent un trafic reel', async () => {
    const { sh, pc } = await laboratoire();
    const avant = statOf(sh.execute('diagnose hardware deviceinfo nic port1'));

    await runOn(pc, 'ping -c 3 10.1.1.1');

    const apres = statOf(sh.execute('diagnose hardware deviceinfo nic port1'));
    expect(apres.rxp).toBeGreaterThan(avant.rxp);
    expect(apres.txp).toBeGreaterThan(avant.txp);
    expect(apres.rxb).toBeGreaterThan(avant.rxb);
    expect(apres.txb).toBeGreaterThan(avant.txb);
  });

  it('la ligne stat porte les dix champs attestes, dans l ordre', async () => {
    const { sh } = await laboratoire();

    const ligne = sh.execute('diagnose hardware deviceinfo nic port1')
      .split('\n').find(l => l.startsWith('stat: ')) ?? '';
    expect(ligne.slice('stat: '.length).split(' ').map(p => p.split('=')[0]))
      .toEqual(['rxp', 'txp', 'rxb', 'txb', 'rxe', 'txe', 'rxd', 'txd', 'mc', 'collision']);
  });

  it('un port sans cable est operationnellement bas mais administrativement haut', async () => {
    const { sh } = await laboratoire();

    const vue = sh.execute('diagnose hardware deviceinfo nic port2');
    expect(vue).toContain('Admin                 :up');
    expect(vue).toContain('link_status           :Down');
    expect(vue).toContain('netdev status         :down');
  });

  it('`set status down` descend l etat administratif', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config system interface', 'edit "port1"',
      'set status down', 'next', 'end');

    const vue = sh.execute('diagnose hardware deviceinfo nic port1');
    expect(vue).toContain('Admin                 :down');
    expect(vue).toContain('link_status           :Down');
  });

  it('les compteurs survivent a la descente de l interface', async () => {
    const { sh, pc } = await laboratoire();
    await runOn(pc, 'ping -c 3 10.1.1.1');
    const avant = statOf(sh.execute('diagnose hardware deviceinfo nic port1'));
    expect(avant.rxp).toBeGreaterThan(0);

    run(sh, 'config system interface', 'edit "port1"',
      'set status down', 'next', 'end');

    expect(statOf(sh.execute('diagnose hardware deviceinfo nic port1')).rxp)
      .toBe(avant.rxp);
  });

  it('sans grappe, l adresse courante est l adresse d usine', async () => {
    const { fw, sh } = await laboratoire();

    const vue = sh.execute('diagnose hardware deviceinfo nic port1');
    const mac = fw.getPort('port1')!.getMAC().toString();
    expect(vue).toContain(`Current_HWaddr        ${mac}`);
    expect(vue).toContain(`Permanent_HWaddr      ${mac}`);
  });

  it('une grappe FGCP separe l adresse courante de l adresse d usine', async () => {
    const { fw, sh } = await laboratoire();
    const usine = fw.getPort('port2')!.getMAC().toString();

    run(sh, 'config system ha',
      'set group-name "cluster-paris"', 'set group-id 10', 'set mode a-p',
      'set password "SecretHA"', 'set hbdev "port7" 50',
      'set priority 200', 'end');

    const vue = sh.execute('diagnose hardware deviceinfo nic port2');
    expect(vue).toContain(`Permanent_HWaddr      ${usine}`);
    expect(vue).toContain('Current_HWaddr        00:09:0f:09:0a:');
    expect(vue).not.toContain(`Current_HWaddr        ${usine}`);
  });

  it('la vue LACP nomme toujours l adresse d usine du membre', async () => {
    const { fw, sh } = await laboratoire();
    const usine = fw.getPort('port4')!.getMAC().toString();

    run(sh, 'config system interface', 'edit "bond0"',
      'set type aggregate', 'set member "port4" "port5"', 'next', 'end');

    expect(fw.permanentMacOf('port4')).toBe(usine);
  });

  it('sans nom, chaque interface est listee sous son nom', async () => {
    const { sh } = await laboratoire();

    const vue = sh.execute('diagnose hardware deviceinfo nic');
    expect(vue.split('\n')[0]).toBe('port1');
    expect(vue).toContain('\nport2\n');
    expect(vue.split('stat: ').length - 1).toBeGreaterThan(1);
  });

  it('une interface inconnue est nommee comme telle', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('diagnose hardware deviceinfo nic zorglub'))
      .toContain('"zorglub" does not exist');
  });
});
