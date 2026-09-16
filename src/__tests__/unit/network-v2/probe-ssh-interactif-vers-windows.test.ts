/**
 * Sonde — une session SSH interactive vers Windows n'executait rien.
 *
 * Mesure AVANT (sur `65085c9c'), entree standard `user\n…\nexit\n' :
 *
 *   depuis un WindowsPC, ssh User@<windows> -> "Microsoft Windows
 *                                               [Version 10.0.22631…]
 *                                               (c) Microsoft …
 *                                               Connection to
 *                                               10.0.0.2 closed."
 *   depuis un WindowsPC, ssh bob@<linux>    -> "Welcome to Ubuntu …
 *                                               Connection to
 *                                               10.0.0.10 closed."
 *   depuis un LinuxPC,   ssh User@<windows> -> la session s'ouvre, mais
 *                                              `exit' repond « 'exit' is
 *                                              not recognized as an
 *                                              internal or external
 *                                              command »
 *
 * DEUX causes distinctes, l'une de chaque cote du fil.
 *
 * COTE CLIENT, Windows avait son PROPRE client SSH. `runWindowsSshClient'
 * resout la cible, rejoue la politique de connexion, ecrit son
 * `known_hosts', et pour finir appelle `remote.runSshCommand(...)' sur
 * l'OBJET du pair -- le raccourci que la regle 4 refuse. Sans commande
 * distante il n'ouvrait rien du tout : il recopiait le motd et la ligne
 * de fermeture. L'entree standard n'etait donc jamais lue. Or il existe
 * DEJA un client unique, `openWireSshConnection' (`terminal/ssh/
 * wireSshLogin.ts'), que le terminal graphique de Windows utilise, et
 * qui sait deja ou une machine Windows range ses fichiers
 * (`sshLocalFsFor' -> `WindowsSshLocalFs'). Une machine, deux clients.
 *
 * COTE SERVEUR, `WindowsPC.createVtyShell' construit sa pile de shells
 * par `ShellFactory', que SEULE une session de terminal graphique
 * remplissait (`installDefaultShells()'). Pour tout appel programmatique
 * -- c'est-a-dire pour `executeCommand' et donc pour ce depot entier --
 * le registre etait vide, la construction echouait, et le serveur
 * retombait sur un executeur a un coup qui ne connait ni `exit', ni
 * `cls', ni `powershell'. Le meme poste, sur le meme protocole,
 * repondait deux choses differentes a `exit' selon qu'un terminal avait
 * ete ouvert avant.
 *
 * SIX cas sur dix tombent avant la correction (discrimines sur
 * `65085c9c'). Les QUATRE autres sont NOMMES :
 *
 *   - `ssh <compte>@<windows> hostname' rend le nom du poste : TEMOIN.
 *     Il prouve que le laboratoire, le compte et le serveur sont bons,
 *     donc qu'une session muette est un chemin manquant et non un
 *     laboratoire casse.
 *   - sans justificatif, la banniere Windows est toujours rendue :
 *     NON-REGRESSION, et c'est la limite assumee de ce lot. Un `ssh
 *     <hote>' sans rien a offrir garde la confiance qu'il a toujours eue
 *     -- c'est ce dont vit `windows-lan-ssh-suite' -- alors qu'un secret
 *     FAUX, lui, est desormais refuse. La ligne est tracee la : ne rien
 *     offrir n'est pas offrir n'importe quoi.
 *   - la session se ferme UNE fois, en nommant l'hote tel qu'il a ete
 *     saisi : passe AVANT comme APRES, et c'est pourquoi il est ecrit.
 *     AVANT il passe A VIDE -- aucune session ne se terminait vraiment.
 *     Entre les deux il a attrape une regression que la correction du
 *     serveur venait d'ouvrir : le registre une fois rempli,
 *     `CrossVendorRemoteShell' ajoutait `Connection to <hote> closed.'
 *     de SON cote, avec le nom du SERVEUR, pendant que le client ecrivait
 *     la sienne avec l'hote saisi. Un vrai cmd ne dit rien sur `exit'
 *     (`WindowsCmdShell.getDeactivationBanner()' le savait deja) : la
 *     ligne appartient au client, et a lui seul.
 *   - un mot de passe FAUX ne rend jamais la sortie du poste distant :
 *     passe AVANT comme APRES, mais A VIDE avant, puisque aucune
 *     commande ne s'executait. Il est ecrit pour rester vrai APRES,
 *     maintenant qu'une bonne combinaison, elle, execute pour de bon.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');
const WIN_IP = '10.0.0.2';
const PC_IP = '10.0.0.10';

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

interface Lab { pc: LinuxPC; win: WindowsPC; client: WindowsPC }

async function lab(): Promise<Lab> {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const client = new WindowsPC('windows-pc', 'WIN2', 0, 0);
  const pc = new LinuxPC('linux-pc', 'P1');
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(client.getPorts()[0], sw.getPorts()[2]);
  pc.getPort('eth0')!.configureIP(new IPAddress(PC_IP), MASK);
  win.getPorts()[0].configureIP(new IPAddress(WIN_IP), MASK);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), MASK);
  await settle();
  return { pc, win, client };
}

async function linuxAccount(pc: LinuxPC, user: string, password: string): Promise<void> {
  const um = (pc as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd(user, { m: true, s: '/bin/bash' });
  um.setPassword(user, password);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('une session SSH interactive vers Windows execute vraiment', () => {
  it('temoin : `ssh <compte>@<windows> hostname` rend le nom du poste', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(`ssh User@${WIN_IP} hostname`)).toContain('WIN1');
  }, 30000);

  it('non-regression : sans justificatif, la banniere Windows est toujours rendue', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(`ssh User@${WIN_IP}`)).toContain('Microsoft Windows');
  }, 30000);

  it('Windows vers Windows : la commande saisie est reellement executee', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(`ssh User@${WIN_IP}`, 'user\nwhoami\nexit\n'))
      .toContain('WIN1\\User');
  }, 30000);

  it('Windows vers Windows : l\'invite du poste distant precede chaque ligne', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(`ssh User@${WIN_IP}`, 'user\nwhoami\nexit\n'))
      .toContain('C:\\Users\\User>whoami');
  }, 30000);

  it('`exit` est une commande interne de cmd, pas un mot inconnu', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`ssh User@${WIN_IP}`, 'user\nhostname\nexit\n'))
      .not.toContain('is not recognized as an internal or external command');
  }, 30000);

  it('`exit` ferme vraiment la session : rien ne s\'execute apres', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`ssh User@${WIN_IP}`, 'user\nhostname\nexit\nwhoami\n'))
      .not.toContain('WIN1\\User');
  }, 30000);

  it('la session se ferme UNE fois, en nommant l\'hote tel qu\'il a ete saisi', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(`ssh User@${WIN_IP}`, 'user\nwhoami\nexit\n');
    expect(out).not.toContain('Connection to WIN1 closed.');
    expect(out.split('\n').filter((l) => l.includes('Connection to')).length).toBe(1);
    expect(out).toContain(`Connection to ${WIN_IP} closed.`);
  }, 30000);

  it('Windows vers Linux : la commande saisie est reellement executee', async () => {
    const { pc, client } = await lab();
    await linuxAccount(pc, 'bob', 'pw');
    expect(await client.executeCommand(`ssh bob@${PC_IP}`, 'pw\nwhoami\nexit\n'))
      .toContain('bob');
  }, 30000);

  it('un mot de passe FAUX est refuse', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(`ssh User@${WIN_IP}`, 'WRONG\nwhoami\nexit\n'))
      .toContain('Permission denied');
  }, 30000);

  it('un mot de passe FAUX ne rend jamais la sortie du poste distant', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(`ssh User@${WIN_IP}`, 'WRONG\nwhoami\nexit\n'))
      .not.toContain('WIN1\\User');
  }, 30000);
});
