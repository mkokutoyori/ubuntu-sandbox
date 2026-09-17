/**
 * Sonde — la derniere plateforme ou `ssh <hote>' n'executait rien.
 *
 * Mesure AVANT (sur `affd0a7b'), meme serveur, meme compte, meme entree
 * standard `pw\nwhoami\nhostname\nexit\n' :
 *
 *   depuis un WindowsPC -> "Welcome to Ubuntu …
 *                           bob@SRV:~$ whoami
 *                           bob
 *                           bob@SRV:~$ hostname
 *                           linux-server
 *                           bob@SRV:~$ exit
 *                           Connection to 10.0.0.2 closed."
 *   depuis un LinuxPC   -> "Ubuntu 22.04.4 LTS
 *                           Last login: … from 10.0.0.10
 *                           Welcome to Ubuntu …
 *                           Connection to 10.0.0.2 closed."
 *
 * Un serveur, deux clients, deux reponses. Le client Linux etait le
 * dernier a ignorer l'entree standard d'une session interactive, et
 * c'est lui qui avait tort.
 *
 * La cause est une garde que j'avais posee moi-meme au lot des
 * equipements non Linux : la session filaire n'etait demandee que s'il y
 * avait une commande distante OU que le pair n'etait pas Linux. Elle
 * servait a ne pas allonger le chemin de six cas dont le `setup' lance
 * un `ssh' SANS l'attendre (`void l.pc1.executeCommand(...)'), si bien
 * que le `known_hosts' et l'`auth.log' n'etaient plus ecrits avant le
 * `cat' qui les lit. Ces six `setup' attendent desormais ce qu'ils
 * lancent -- une ligne chacun, et la garde disparait : un `ssh' ouvre
 * une session filaire, point.
 *
 * TROIS cas sur dix tombent avant la correction (discrimines sur
 * `affd0a7b'). Les SEPT autres sont NOMMES, et trois d'entre eux ont
 * attrape un defaut :
 *
 *   - depuis Windows la meme session executait deja la commande :
 *     TEMOIN. Il prouve que le laboratoire, le compte et le serveur sont
 *     bons, donc qu'un client muet est un chemin manquant et non un
 *     laboratoire casse.
 *   - sans entree standard le transcrit ne change pas : NON-REGRESSION,
 *     au caractere pres. Un `ssh <hote>' sans rien a taper rend la meme
 *     banniere, le meme `Last login', le meme motd et la meme ligne de
 *     fermeture qu'avant.
 *   - `ssh hote commande' rend toujours sa sortie : NON-REGRESSION du
 *     chemin exec, qui passait deja par le fil.
 *   - le mot de passe n'est jamais rejoue comme une commande : passe
 *     AVANT comme APRES, mais A VIDE avant -- aucune ligne n'etait
 *     executee, donc aucune ne pouvait etre rejouee.
 *
 *   - la session ne traine pas dans `who' : passe AVANT comme APRES, et
 *     il a attrape un defaut que j'avais INTRODUIT. `openSshSessionRecord'
 *     OUVRE l'inscription quand le fil a authentifie et
 *     `scheduleSshLogout' la FERME : ce sont une paire, pas un doublon.
 *     Les avoir pris pour un doublon laissait `bob pts/0' ouvert dans
 *     `who' apres la fin de la session.
 *   - une seule ouverture est inscrite dans le journal : meme famille,
 *     il garde l'inscription unique que la paire ci-dessus rend possible.
 *   - `StrictHostKeyChecking=yes' refuse un hote inconnu : passe AVANT
 *     comme APRES, et il a attrape le second defaut introduit. La
 *     session filaire se connectait en `accept-new' quoi qu'ait demande
 *     l'operateur, donc elle ecrivait l'entree `known_hosts' AVANT que
 *     le refus ne soit evalue -- le critere devenait decoratif. Le
 *     reglage voyage maintenant jusqu'au fil, et la poignee de main
 *     elle-meme refuse plutot que de demander a un operateur qui n'est
 *     pas la.
 *
 * (`exit' ferme vraiment la session : ce cas tombe, mais pour une raison
 * qui precede ce lot. `handleExitInSession' repond depuis toujours a la
 * question « cette sortie termine-t-elle le shell de connexion, ou
 * depile-t-elle un `su' ? » -- et le contexte SSH Linux ne l'appelait
 * pas. Le defaut etait invisible tant qu'aucune ligne ne s'executait ;
 * il se voit des que la premiere le fait.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const SRV_IP = '10.0.0.2';

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

interface Lab { srv: LinuxServer; pc: LinuxPC; win: WindowsPC }

async function lab(): Promise<Lab> {
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  const pc = new LinuxPC('linux-pc', 'P1');
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c3').connect(win.getPorts()[0], sw.getPorts()[2]);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), MASK);
  srv.getPort('eth0')!.configureIP(new IPAddress(SRV_IP), MASK);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), MASK);
  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('bob', { m: true, s: '/bin/bash' });
  um.setPassword('bob', 'pw');
  await settle();
  return { srv, pc, win };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('`ssh <hote Linux>` execute ce qu\'on lui tape', () => {
  it('temoin : depuis Windows, la meme session executait deja la commande', async () => {
    const { win } = await lab();
    expect(await win.executeCommand(`ssh bob@${SRV_IP}`, 'pw\nwhoami\nexit\n'))
      .toContain('bob@SRV');
  }, 30000);

  it('la commande saisie est reellement executee', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`ssh bob@${SRV_IP}`, 'pw\nhostname\nexit\n'))
      .toContain('linux-server');
  }, 30000);

  it('l\'invite du shell distant precede chaque ligne', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`ssh bob@${SRV_IP}`, 'pw\nwhoami\nexit\n'))
      .toContain('bob@SRV:~$ whoami');
  }, 30000);

  it('`exit` ferme la session : rien ne s\'execute apres', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`ssh bob@${SRV_IP}`, 'pw\nwhoami\nexit\nhostname\n');
    expect(out).toContain('bob');
    expect(out).not.toContain('linux-server');
  }, 30000);

  it('non-regression : sans entree, le transcrit ne change pas', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`ssh bob@${SRV_IP}`);
    expect(out).toContain('Welcome to Ubuntu');
    expect(out).toContain(`Connection to ${SRV_IP} closed.`);
    expect(out).not.toContain('bob@SRV:~$');
  }, 30000);

  it('non-regression : le mot de passe n\'est jamais rejoue comme une commande', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`ssh bob@${SRV_IP}`, 'pw\nwhoami\nexit\n');
    expect(out).not.toContain('bob@SRV:~$ pw');
    expect(out).not.toContain('pw: command not found');
  }, 30000);

  it('non-regression : la session ne traine pas dans `who`', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand(`ssh bob@${SRV_IP}`, 'pw\nwhoami\nexit\n');
    expect(String(await srv.executeCommand('who'))).not.toContain('bob');
  }, 30000);

  it('non-regression : une seule ouverture est inscrite dans le journal', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand(`ssh bob@${SRV_IP}`, 'pw\nwhoami\nexit\n');
    const journal = String(await srv.executeCommand('sudo journalctl -u ssh --no-pager'));
    expect(journal.split('\n').filter((l) => l.includes('Accepted password')).length).toBe(1);
  }, 30000);

  it('non-regression : `StrictHostKeyChecking=yes` refuse un hote inconnu', async () => {
    const { pc } = await lab();
    await pc.executeCommand('rm -f ~/.ssh/known_hosts');
    const out = await pc.executeCommand(
      `ssh -o StrictHostKeyChecking=yes bob@${SRV_IP}`, 'pw\nwhoami\nexit\n');
    expect(out).toMatch(/Host key verification failed|not known/i);
    expect(out).not.toContain('bob@SRV:~$');
  }, 30000);

  it('non-regression : `ssh hote commande` rend toujours sa sortie', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`ssh bob@${SRV_IP} whoami`, 'pw\n')).toContain('bob');
  }, 30000);
});
