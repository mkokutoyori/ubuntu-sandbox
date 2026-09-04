/**
 * Un serveur reel se VOIT, et `max-connections` plafonne pour de bon.
 *
 * `RealServerPool` est un vrai repartiteur : cinq methodes de choix,
 * poids, etat vivant/mort tenu par de VRAIS moniteurs de sante
 * (`config firewall ldb-monitor`, qui envoie un ping ou ouvre une
 * connexion TCP), et un decompte de sessions actives lu sur la table de
 * sessions. **Rien de tout cela n'avait de porte** : `diagnose firewall
 * vip list` ecarte explicitement une VIP de repartition
 * (`destinationTranslation.kind !== 'static-ip'`), donc un serveur
 * virtuel etait INVISIBLE dans toutes les vues de diagnostic — un cas
 * l'epingle, et c'est le TEMOIN de ce lot. Un operateur dont un serveur
 * de grappe tombe n'avait aucun moyen de savoir lequel.
 *
 * **`max-connections` etait un critere range et evalue par PERSONNE.**
 * Le schema le lit, `show` le rend, `RealServer` le porte — et `pick()`
 * ne le regardait pas : un serveur plafonne a une session en recevait
 * autant qu'on voulait. C'est la regle « on ne range pas un critere
 * qu'on n'evalue pas », et son effet est mesurable ici : le plafond
 * atteint, le choix se REPORTE sur l'autre serveur.
 *
 * La mise en forme vient d'une transcription reelle — `vd root/0 vs
 * vs/2 addr 10.31.101.30:80 status 1/1` puis `conn: max 0 active 0
 * attempts 0 success 0 drop 0 fail 0` — et non de la reference 6.0.4,
 * qui documente `execute` et pas `diagnose`.
 *
 * **Ce que chaque compteur MESURE, et pourquoi aucun n'est un ornement.**
 * `status` est administratif/operationnel : le premier chiffre est
 * `set status`, le second le verdict du moniteur, et les DEUX sont
 * distincts a dessein — un serveur desactive a la main affiche `0/1`,
 * parce que le moniteur n'a jamais dit qu'il etait malade, et les
 * confondre ferait accuser la sante d'une decision d'operateur.
 * `active` est le nombre de sessions que la table porte reellement vers
 * ce serveur, la meme lecture que la methode `least-session` utilise
 * pour choisir. `attempts` compte les fois ou le repartiteur a DESIGNE
 * ce serveur, `drop` celles ou il l'a ensuite refuse pour cause de
 * plafond, `success` celles qui ont abouti. `fail` reste a zero et
 * c'est la VERITE de ce simulateur, non un remplissage : le champ
 * compte les echecs internes apres designation, et il n'existe aucun
 * chemin d'echec entre le choix et la traduction.
 *
 * `diagnose firewall vip realserver clear` arrive avec la vue, pour la
 * meme raison que pour les routes de politique : un compteur qu'on peut
 * lire et pas remettre a zero se relit faux au laboratoire suivant. Il
 * ne touche ni `active` ni `max`, qui ne sont pas des compteurs mais
 * l'etat courant et la configuration.
 *
 * Discrimine par `git stash push -- src/network/` : 11 des 13 cas
 * tombent. Les 2 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « une VIP de repartition est absente de `vip list` » est le
 *     TEMOIN, et c'est son objet de passer des deux cotes : il dit
 *     POURQUOI cette vue manquait ;
 *   - « un mot inconnu sous realserver est refuse » passe parce
 *     qu'avant correctif le chemin ENTIER est inconnu, donc le refus
 *     est bien la — mais il ne porte pas sur le mot, ce qui est
 *     precisement ce que ce cas garde une fois la famille declaree.
 *
 * « sans serveur virtuel, la vue est vide » etait annonce comme non
 * discriminant et la mesure a dit le contraire : le refus n'est pas la
 * chaine vide, donc le cas tombe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const CLIENT = '203.0.113.10';
const VIP = '203.0.113.100';
const SERVEUR_A = '192.168.1.10';
const SERVEUR_B = '192.168.1.11';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); },
    Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 150);
  const client = new LinuxPC('linux-pc', 'PC', 200, 0);
  const a = new LinuxServer('linux-server', 'A', -200, 0);
  const b = new LinuxServer('linux-server', 'B', -200, 120);
  for (const d of [commutateur, client, a, b]) d.powerOn();

  new Cable('c1').connect(fw.getPort('port1')!, commutateur.getPort('eth0')!);
  new Cable('c2').connect(a.getPorts()[0], commutateur.getPort('eth1')!);
  new Cable('c3').connect(b.getPorts()[0], commutateur.getPort('eth2')!);
  new Cable('c4').connect(fw.getPort('port2')!, client.getPorts()[0]);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(a, ['ip link set eth0 up', `ip addr add ${SERVEUR_A}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(b, ['ip link set eth0 up', `ip addr add ${SERVEUR_B}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(client, ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);

  for (const serveur of [a, b]) {
    serveur.getTcpStack().listen(80, {
      onAccept: (socket: { write(data: string): void }) => { socket.write('ok'); },
    });
  }

  return { fw, sh, client, a, b };
}

function grappe(sh: FortiShell, ...extra: string[]): void {
  run(sh,
    'config firewall vip', 'edit "SLB"',
    'set type server-load-balance',
    `set extip ${VIP}`,
    'set extintf "port2"',
    'set server-type tcp',
    'set ldb-method round-robin',
    'set extport 80',
    ...extra,
    'config realservers',
    'edit 1', `set ip ${SERVEUR_A}`, 'set port 80', 'next',
    'edit 2', `set ip ${SERVEUR_B}`, 'set port 80', 'next',
    'end', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "SLB"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');
}

async function joint(fw: FortiGate, client: LinuxPC): Promise<string | undefined> {
  await client.tcpConnect(VIP, 80);
  const sessions = fw.getSessionTable().view().all();
  return sessions[sessions.length - 1]?.translation?.translatedDest;
}

function ligneDe(vue: string, adresse: string): string {
  const lignes = vue.split('\n');
  const index = lignes.findIndex(l => l.includes(`addr ${adresse}:`));
  return index < 0 ? '' : `${lignes[index]}\n${lignes[index + 1] ?? ''}`;
}

describe('diagnose firewall vip realserver list', () => {
  it('sans serveur virtuel, la vue est vide', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('diagnose firewall vip realserver list')).toBe('');
  });

  it('une VIP de repartition est absente de `vip list`', async () => {
    const { sh } = await laboratoire();
    grappe(sh);

    expect(sh.execute('diagnose firewall vip list')).toBe('');
  });

  it('liste chaque serveur reel avec son domaine et son adresse', async () => {
    const { sh } = await laboratoire();
    grappe(sh);

    const vue = sh.execute('diagnose firewall vip realserver list');
    expect(vue).toContain(`vd root/0 vs SLB/1 addr ${SERVEUR_A}:80 status 1/1`);
    expect(vue).toContain(`vd root/0 vs SLB/1 addr ${SERVEUR_B}:80 status 1/1`);
    expect(vue).toContain('conn: max 0 active 0 attempts 0 success 0 drop 0 fail 0');
  });

  it('active suit la table de sessions', async () => {
    const { fw, sh, client } = await laboratoire();
    grappe(sh);

    const choisi = await joint(fw, client);
    expect(choisi).toBeDefined();

    expect(ligneDe(sh.execute('diagnose firewall vip realserver list'), choisi!))
      .toContain('active 1');
  });

  it('attempts et success comptent les designations reelles', async () => {
    const { fw, sh, client } = await laboratoire();
    grappe(sh);

    await joint(fw, client);
    await joint(fw, client);

    const vue = sh.execute('diagnose firewall vip realserver list');
    expect(ligneDe(vue, SERVEUR_A)).toContain('attempts 1 success 1 drop 0');
    expect(ligneDe(vue, SERVEUR_B)).toContain('attempts 1 success 1 drop 0');
  });

  it('max-connections refuse le serveur plafonne, et le compte en drop', async () => {
    const { fw, sh, client } = await laboratoire();
    grappe(sh);

    await joint(fw, client);
    await joint(fw, client);

    run(sh, 'config firewall vip', 'edit "SLB"', 'config realservers',
      'edit 1', 'set max-connections 1', 'next', 'end', 'next', 'end');

    await joint(fw, client);

    expect(ligneDe(sh.execute('diagnose firewall vip realserver list'), SERVEUR_A))
      .toContain('max 1 active 1 attempts 2 success 1 drop 1');
  });

  it('le plafond REPORTE la session sur l autre serveur', async () => {
    const { fw, sh, client } = await laboratoire();
    grappe(sh);

    await joint(fw, client);
    await joint(fw, client);

    run(sh, 'config firewall vip', 'edit "SLB"', 'config realservers',
      'edit 1', 'set max-connections 1', 'next', 'end', 'next', 'end');

    expect(await joint(fw, client)).toBe(SERVEUR_B);
  });

  it('un serveur desactive a la main est 0/1, pas 0/0', async () => {
    const { sh } = await laboratoire();
    grappe(sh);

    run(sh, 'config firewall vip', 'edit "SLB"', 'config realservers',
      'edit 2', 'set status disable', 'next', 'end', 'next', 'end');

    const vue = sh.execute('diagnose firewall vip realserver list');
    expect(ligneDe(vue, SERVEUR_B)).toContain('status 0/1');
    expect(ligneDe(vue, SERVEUR_A)).toContain('status 1/1');
  });

  it('un moniteur qui echoue rend 1/0', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config firewall ldb-monitor', 'edit "HC"',
      'set type ping', 'next', 'end');
    grappe(sh, 'set monitor "HC"');

    for (let i = 0; i < 3; i++) await fw.runLdbMonitors();
    expect(ligneDe(sh.execute('diagnose firewall vip realserver list'), SERVEUR_A))
      .toContain('status 1/1');

    a.powerOff();
    for (let i = 0; i < 3; i++) await fw.runLdbMonitors();

    const vue = sh.execute('diagnose firewall vip realserver list');
    expect(ligneDe(vue, SERVEUR_A)).toContain('status 1/0');
    expect(ligneDe(vue, SERVEUR_B)).toContain('status 1/1');
  });

  it('clear vide les compteurs sans toucher active ni max', async () => {
    const { fw, sh, client } = await laboratoire();
    grappe(sh);
    run(sh, 'config firewall vip', 'edit "SLB"', 'config realservers',
      'edit 1', 'set max-connections 4', 'next', 'end', 'next', 'end');

    const choisi = await joint(fw, client);
    expect(sh.execute('diagnose firewall vip realserver list'))
      .toContain('attempts 1');

    expect(sh.execute('diagnose firewall vip realserver clear')).toBe('');

    const vue = sh.execute('diagnose firewall vip realserver list');
    expect(vue).not.toContain('attempts 1');
    expect(ligneDe(vue, choisi!)).toContain('active 1');
    expect(ligneDe(vue, SERVEUR_A)).toContain('max 4');
  });

  it('un serveur retire de la grappe emporte ses compteurs', async () => {
    const { fw, sh, client } = await laboratoire();
    grappe(sh);
    await joint(fw, client);

    run(sh, 'config firewall vip', 'edit "SLB"', 'config realservers',
      'delete 1', 'end', 'next', 'end');

    const vue = sh.execute('diagnose firewall vip realserver list');
    expect(vue).not.toContain(SERVEUR_A);
    expect(vue).toContain(SERVEUR_B);
  });

  it('l aide annonce la famille et ses deux commandes', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('diagnose firewall vip ?')).toContain('realserver');
    const aide = sh.execute('diagnose firewall vip realserver ?');
    expect(aide).toContain('list');
    expect(aide).toContain('clear');
  });

  it('un mot inconnu sous realserver est refuse', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('diagnose firewall vip realserver zorglub'))
      .toContain('unknown command');
  });
});
