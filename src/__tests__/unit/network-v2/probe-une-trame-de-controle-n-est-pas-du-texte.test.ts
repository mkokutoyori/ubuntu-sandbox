/*
 * Les trames de CONTROLE de la connexion arrivaient dans le flux du
 * terminal.
 *
 * Mesure de depart, sur un canal shell REEL ouvert vers un serveur dont
 * `sshd_config` porte `ClientAliveInterval 1`, en ecoutant ce que le
 * canal remet a ses abonnes `onData` — c'est-a-dire exactement ce qu'un
 * terminal affiche — pendant deux secondes et demie sans rien taper :
 *
 *   recu = ["{\"op\":\"keepalive\",\"seq\":1}",
 *           "{\"op\":\"keepalive\",\"seq\":1}"]
 *
 * Ce JSON est le protocole du simulateur, pas la sortie d'un shell. Un
 * operateur ne voit JAMAIS cela sur une vraie machine : OpenSSH echange
 * ses messages de controle (SSH_MSG_GLOBAL_REQUEST
 * « keepalive@openssh.com », SSH_MSG_DISCONNECT) dans le TRANSPORT, sous
 * les canaux, et le terminal ne rend que ce que le shell distant a
 * ecrit. C'est la meme chose qu'on lisait dans l'interface graphique
 * sous la forme `{"op":"disconnect","reason":"exec-timeout"}` juste
 * avant `Connection to … closed.`
 *
 * LA CAUSE EST UNE PORTE DE SORTIE TROP LARGE. `SshShellChannel.onWire`
 * connait `shell_output`, `editor_view`, `shell_complete_result` et les
 * reponses de commande ; tout le reste finit sur :
 *
 *     // Any other JSON payload: pass through verbatim for advanced consumers.
 *     for (const h of this.dataHandlers) h(raw);
 *
 * Or le serveur emet QUATRE trames qui ne portent aucun `channelId` —
 * `keepalive`, et `disconnect` pour `max_startups`, `throttled` et
 * `exec-timeout`. Aucune ne correspond a une branche, et le filtre par
 * `channelId` les laisse passer faute d'en porter un : toutes tombent
 * dans le verbatim et deviennent du texte a l'ecran.
 *
 * CE QUI N'EST PAS EN CAUSE, ET QUI A ETE MESURE PLUTOT QUE SUPPOSE. La
 * premiere hypothese ecrite ici etait que la garde de vie ne gardait
 * rien : `ClientAliveCountMax` compte, chez OpenSSH, les messages RESTES
 * SANS REPONSE — sshd(8), « the number of client alive messages which
 * may be sent without sshd receiving any messages back from the client »
 * — et une trame affichee au lieu d'etre repondue laisserait le compteur
 * mesurer le temps ecoule. La mesure dit le contraire : `seq` reste a 1
 * d'un battement a l'autre, donc quelque chose REMET le compteur a zero.
 * C'est `SshSession`, qui repond `keepalive_ack` des la reception, sous
 * les canaux. La garde fonctionne, et les deux cas qui le verifient
 * restent ici comme TEMOINS — ce sont eux qui font de ce lot un defaut
 * de RENDU et non de protocole.
 *
 * Le correctif est donc d'un seul cote : le canal RECONNAIT les trames
 * de controle de la connexion et ne les remet pas a ses abonnes.
 *
 * Ecrite a l'aveugle contre `ssh(1)`, `sshd_config(5)` et RFC 4254.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 2 des 6 cas tombent. Les 4 autres sont nommes ici :
 *
 *  - TEMOIN DU CANAL : la sortie d'une commande atteint bien les
 *    abonnes. Sans lui, « le canal ne remet plus de JSON » et « le canal
 *    ne remet plus rien » seraient indiscernables.
 *  - TEMOINS DE LA GARDE : la session survit a plus de battements que
 *    `ClientAliveCountMax` n'en tolere sans reponse, et le canal y
 *    repond encore. Ils passent des DEUX cotes, et c'est le point : la
 *    reponse au battement existait deja, seul son affichage etait faux.
 *
 * LE CANAL D'EXEC PORTE LE MEME DEFAUT, EN PIRE, ET IL EST FERME SANS
 * CAS QUI TOMBE — ce qui est dit ici plutot que maquille. `SshExecChannel`
 * analyse la trame en JSON et en fait SON RESULTAT : un battement arrive
 * pendant qu'une commande est en vol resout la promesse avec
 * `{op:'keepalive'}`, donc une sortie vide et un code de retour invente.
 * Ce n'est pas un defaut d'affichage mais de CORRECTION. Je n'ai PAS
 * reussi a faire atterrir un battement dans la fenetre de vol d'un exec
 * depuis ce laboratoire : la reponse du serveur revient avant le premier
 * battement, y compris avec une commande longue. Le garde est donc pose
 * par LECTURE du chemin, pas par mesure, et le cas d'exec ci-dessous est
 * un TEMOIN de non-regression — il passe des deux cotes. Les deux canaux
 * lisent le meme predicat pour que la question n'ait qu'une reponse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import type { ISshExecChannel, ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';

const SRV_IP = '10.0.0.2';
const PC_IP = '10.0.0.10';
const MASK = new SubnetMask('255.255.255.0');
const SECRET = 'pw';

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isOk = <T,>(r: unknown): r is { value: T } =>
  typeof r === 'object' && r !== null && 'value' in (r as object);

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire(gardeDeVie: string): Promise<{
  canal: ISshShellChannel; recu: string[]; session: SshSession;
}> {
  const pc = new LinuxPC('linux-pc', 'P1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  pc.getPort('eth0')!.configureIP(new IPAddress(PC_IP), MASK);
  srv.getPort('eth0')!.configureIP(new IPAddress(SRV_IP), MASK);

  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('bob', { m: true, s: '/bin/bash' });
  um.setPassword('bob', SECRET);

  const vfs = (srv as unknown as { executor: { vfs: {
    writeFile(p: string, c: string, u: number, g: number, m: number): void;
  } } }).executor.vfs;
  vfs.writeFile('/etc/ssh/sshd_config', gardeDeVie, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');

  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: {
      readFile: () => null, writeFile: () => undefined,
      resolveInode: () => null, mkdirp: () => undefined,
    } as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host(SRV_IP).user('bob').password(SECRET).strictHostKeyChecking('no').build();
  const connecte = await session.connect(opts);
  if (!isOk(connecte)) throw new Error('connexion SSH refusee');
  const ouvert = session.openShellChannel();
  if (!isOk<ISshShellChannel>(ouvert)) throw new Error('canal shell refuse');

  const recu: string[] = [];
  ouvert.value.onData((d) => recu.push(d));
  return { canal: ouvert.value, recu, session };
}

const BAT_RAPIDE = 'PasswordAuthentication yes\nClientAliveInterval 1\nClientAliveCountMax 2\n';
const SANS_BAT = 'PasswordAuthentication yes\n';

describe('le canal remet bien ce que le shell ecrit — le TEMOIN', () => {
  it('la sortie d\'une commande atteint les abonnes', async () => {
    const { canal, recu } = await laboratoire(SANS_BAT);

    await canal.runLine('whoami');

    expect(recu.join('')).toContain('bob');
  }, 30000);
});

describe('aucune trame de controle n\'atteint le flux du terminal', () => {
  it('le flux ne porte aucun objet JSON du protocole', async () => {
    const { recu } = await laboratoire(BAT_RAPIDE);

    await pause(2600);

    expect(recu.join('|'), recu.join('|')).not.toMatch(/\{"op":/);
  }, 30000);

  it('ni le mot `keepalive`', async () => {
    const { recu } = await laboratoire(BAT_RAPIDE);

    await pause(2600);

    expect(recu.join('|'), recu.join('|')).not.toMatch(/keepalive/);
  }, 30000);
});

describe('un battement ne resout pas une commande en vol', () => {
  it('le canal d\'exec rend la sortie de SA commande', async () => {
    const { session } = await laboratoire(BAT_RAPIDE);
    const exec = session.openExecChannel('whoami');
    if (!isOk<ISshExecChannel>(exec)) throw new Error('canal exec refuse');

    const attente = exec.value.execute();
    await pause(1400);
    const resultat = await attente;

    expect(resultat.stdout, JSON.stringify(resultat)).toContain('bob');
  }, 30000);
});

describe('la garde de vie compte les battements SANS REPONSE', () => {
  it('un client qui repond garde sa session au-dela de ClientAliveCountMax', async () => {
    const { canal, recu } = await laboratoire(BAT_RAPIDE);

    await pause(3600);
    await canal.runLine('whoami');

    expect(recu.join(''), recu.join('')).toContain('bob');
  }, 30000);

  it('et le canal est toujours ouvert — le TEMOIN de l\'attente', async () => {
    const { canal } = await laboratoire(BAT_RAPIDE);

    await pause(3600);

    expect(canal.isOpen).toBe(true);
  }, 30000);
});
