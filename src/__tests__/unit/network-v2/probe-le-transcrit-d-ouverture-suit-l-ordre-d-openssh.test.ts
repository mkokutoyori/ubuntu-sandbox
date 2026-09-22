/*
 * Le MOTD s'affichait DEUX fois, et l'avis de cle d'hote arrivait apres
 * la banniere au lieu de la preceder.
 *
 * CE LOT CORRIGE UNE REGRESSION QUE J'AI INTRODUITE, et le dire est le
 * premier interet de cette sonde. Un lot precedent a fait voyager le
 * MOTD dans l'accuse d'ouverture de canal pour que le client puisse le
 * rendre avant la premiere invite. Il l'a fait en le PREPOSANT dans
 * `relayScriptedShell` — alors que les DEUX appelants de ce relais,
 * `LinuxSshClient` et `WindowsSshClient`, composent deja leur propre
 * banniere d'ouverture. Le meme texte venait donc de deux endroits.
 *
 * Mesure de depart, session interactive vers un serveur dont
 * `/etc/motd` porte une ligne reconnaissable :
 *
 *   Ubuntu 22.04.4 LTS
 *   Last login: … from 10.0.0.1
 *   CUSTOM MOTD LINE                      <- la banniere du client
 *   Warning: Permanently added '10.0.0.2' (ssh-ed25519) …
 *   CUSTOM MOTD LINE                      <- le prefixe du relais
 *   alice@srv:~$ whoami
 *
 * Deux defauts s'y lisent. Le MOTD est ecrit deux fois. Et l'avis de
 * cle d'hote — un message CLIENT, emis pendant la verification, donc
 * AVANT toute authentification — tombe au milieu de la banniere que le
 * serveur envoie APRES. Il y arrivait parce que les avis etaient
 * episses dans la sortie de la session relayee, et que le client ajoute
 * cette sortie apres sa propre banniere.
 *
 * L'AUTORITE EST OPENSSH, dont l'ordre est celui-ci et pas un autre :
 * l'avis de `known_hosts` d'abord, puis la banniere du serveur, puis
 * `Last login`, puis le MOTD, puis la session.
 *
 * Les deux moities se ferment au meme endroit — celui qui COMPOSE le
 * transcrit. Le relais cesse de preposer un MOTD que son appelant ecrit
 * deja ; et les avis d'avant authentification voyagent comme tels
 * (`wireNotices`) jusqu'a l'en-tete du client, qui les place en tete
 * avec les autres messages d'avant session au lieu de les recevoir
 * melanges a la session.
 *
 * Ecrite contre `ssh(1)` et contre le transcrit d'une vraie ouverture.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network
 * src/terminal`) : 2 des 5 cas tombent. Les 3 autres sont nommes ici :
 *
 *  - TEMOIN DU MOTD : il est bien RENDU. Sans lui, « il n'apparait plus
 *    deux fois » et « il n'apparait plus du tout » seraient
 *    indiscernables — et c'est precisement l'erreur qu'on corrige, donc
 *    le temoin compte double.
 *  - TEMOIN DE LA SESSION : la commande tapee s'execute et la session
 *    se ferme sur le mot d'OpenSSH. Retirer du texte ne doit pas
 *    retirer la session.
 *  - NON-REGRESSION : `PrintMotd no` supprime toujours le MOTD, ce
 *    qu'un lot precedent venait de rendre vrai.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SRV_IP = '10.0.0.2';
const PC_IP = '10.0.0.1';
const MASK = new SubnetMask('255.255.255.0');
const MOTD = 'CUSTOM MOTD LINE';
const SECRET = 'admin';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire(sshdConfig = 'PasswordAuthentication yes\n'): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), MASK);
  srv.getPorts()[0].configureIP(new IPAddress(SRV_IP), MASK);

  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', SECRET);

  const vfs = (srv as unknown as { executor: { vfs: {
    writeFile(p: string, c: string, u: number, g: number, m: number): void;
  } } }).executor.vfs;
  vfs.writeFile('/etc/motd', `${MOTD}\n`, 0, 0, 0o022);
  vfs.writeFile('/etc/ssh/sshd_config', sshdConfig, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
  return pc;
}

const ouvrir = (pc: LinuxPC) =>
  pc.executeCommand(`ssh alice@${SRV_IP}`, `${SECRET}\nwhoami\nexit\n`);

describe('le MOTD est rendu — le TEMOIN', () => {
  it('la ligne de `/etc/motd` figure au transcrit', async () => {
    const pc = await laboratoire();

    expect(await ouvrir(pc)).toContain(MOTD);
  }, 30000);
});

describe('le transcrit d\'ouverture suit l\'ordre d\'OpenSSH', () => {
  it('le MOTD n\'y figure qu\'UNE fois', async () => {
    const pc = await laboratoire();

    const transcrit = await ouvrir(pc);

    expect((transcrit.match(new RegExp(MOTD, 'g')) ?? []).length, transcrit).toBe(1);
  }, 30000);

  it('l\'avis de cle d\'hote PRECEDE la banniere du serveur', async () => {
    const pc = await laboratoire();

    const transcrit = await ouvrir(pc);

    const avis = transcrit.indexOf('Permanently added');
    const banniere = transcrit.indexOf(MOTD);
    expect(avis, transcrit).toBeGreaterThanOrEqual(0);
    expect(avis, transcrit).toBeLessThan(banniere);
  }, 30000);
});

describe('ce que le correctif ne doit pas emporter', () => {
  it('la session execute et se ferme sur le mot d\'OpenSSH — le TEMOIN', async () => {
    const pc = await laboratoire();

    const transcrit = await ouvrir(pc);

    expect(transcrit).toContain('alice');
    expect(transcrit).toContain(`Connection to ${SRV_IP} closed.`);
  }, 30000);

  it('`PrintMotd no` le supprime toujours', async () => {
    const pc = await laboratoire('PasswordAuthentication yes\nPrintMotd no\n');

    expect(await ouvrir(pc)).not.toContain(MOTD);
  }, 30000);
});
