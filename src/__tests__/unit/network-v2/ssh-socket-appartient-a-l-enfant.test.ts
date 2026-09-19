/**
 * Sonde — une connexion SSH acceptee appartient au PROCESSUS ENFANT,
 * et `ss` ne l'ecrit qu'une fois.
 *
 * Releve AVANT :
 *
 *   ssh alice@10.0.0.2 (session interactive etablie)
 *   ss -tna cote serveur
 *     ESTAB  0  0  10.0.0.2:22  10.0.0.1:32768
 *     ESTAB  0  0  10.0.0.2:22  10.0.0.1:32768     <- la MEME, deux fois
 *   ps aux | grep sshd
 *     22  /usr/sbin/sshd -D
 *     44  sshd: alice [priv]
 *
 *   systemctl stop ssh
 *   ss -tna                    plus aucune ESTAB
 *   ps aux | grep sshd         44 sshd: alice [priv]   <- l'enfant VIT
 *   hostname (tape dans la session)   aucune reponse
 *
 * Deux defauts qui se repondent, et un troisieme qui les revelait.
 *
 * D'abord le §2 : la ligne ESTAB etait ecrite DEUX fois. La projection
 * `TcpSocketStateProjection` inscrit deja chaque connexion de la pile
 * dans la table des sockets ; `openSshSessionRecord` ajoutait par-dessus
 * un `socketTable.connect(...)` qui cree toujours une ligne neuve. Les
 * deux ne portaient meme pas le meme fait : celle de la projection
 * n'avait pas de pid, celle du doublon en avait un.
 *
 * Ensuite le §3, et c'est lui qui cassait la session : la socket
 * acceptee etait declaree propriete du demon d'ECOUTE. Or Debian lance
 * `ssh.service` en `KillMode=process` — systemd.kill(5) : « If set to
 * `process`, only the main process itself is killed ». Le simulateur
 * modelisait deja cela cote PROCESSUS (l'enfant `sshd: alice [priv]`
 * survivait), mais pas cote SOCKET : `abortSocketsOwnedBy(pid du demon)`
 * emportait la connexion de l'enfant, et le faucheur de sockets
 * `attachProcessSocketReaper` achevait le travail en fauchant par NOM
 * toute socket dont le `processName` valait `sshd` — y compris celles
 * d'un processus bien vivant qui partage ce nom.
 *
 * Les trois corrections sont une seule phrase : une connexion acceptee
 * appartient a l'enfant qui la sert, une seule ligne la decrit, et on ne
 * fauche pas une socket sur la foi d'un homonyme.
 *
 * AUTORITE : systemd.kill(5) pour la semantique de `KillMode=process`
 * (source lue : man/systemd.kill.xml du depot systemd). Le fichier
 * d'unite Debian lui-meme est INJOIGNABLE depuis cette machine — le
 * mandataire refuse sources.debian.org, salsa.debian.org et
 * git.launchpad.net ; c'est `fault-ssh-session-survives-or-dies`, deja
 * dans ce depot, qui porte l'affirmation sur `ssh.service`.
 *
 * Discrimination par `git stash push -- src/network` : les 3 cas
 * tombent avant le correctif.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const MASK = new SubnetMask('255.255.255.0');
const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

interface Lab { cli: LinuxPC; srv: LinuxServer; t: LinuxTerminalSession }

async function connectedLab(): Promise<Lab> {
  const cli = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV');
  cli.configureInterface('eth0', new IPAddress('10.0.0.1'), MASK);
  srv.configureInterface('eth0', new IPAddress('10.0.0.2'), MASK);
  new Cable('c1').connect(cli.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  await srv.executeCommand('useradd -m alice');
  await srv.executeCommand('sh -c "echo \'alice:secret\' | chpasswd"');
  const t = new LinuxTerminalSession('t', cli);
  await t.init();
  t.setInput('ssh alice@10.0.0.2');
  t.handleKey(key('Enter'));
  await flush();
  if (t.foreground.currentInputMode.type === 'password') {
    t.setPasswordBuf('secret');
    t.handleKey(key('Enter'));
    await flush();
  }
  return { cli, srv, t };
}

const estabLines = (out: string): string[] =>
  out.split('\n').filter((l) => l.startsWith('ESTAB') && l.includes(':22'));

describe('une connexion acceptee a UN proprietaire et UNE ligne', () => {
  it('ss n ecrit la connexion qu une seule fois', async () => {
    const { srv } = await connectedLab();
    expect(estabLines(await srv.executeCommand('ss -tna'))).toHaveLength(1);
  });

  it('la ligne nomme le processus enfant, pas le demon d ecoute', async () => {
    const { srv } = await connectedLab();
    const child = (await srv.executeCommand('ps aux'))
      .split('\n').find((l) => l.includes('sshd: alice'));
    expect(child).toBeTruthy();
    const childPid = child!.trim().split(/\s+/)[1];
    const master = (await srv.executeCommand('ps aux'))
      .split('\n').find((l) => l.includes('/usr/sbin/sshd -D'));
    expect(master!.trim().split(/\s+/)[1]).not.toBe(childPid);

    const estab = estabLines(await srv.executeCommand('ss -tnap'))[0] ?? '';
    expect(estab).toContain(`pid=${childPid}`);
  });

  it('arreter le demon laisse la connexion de l enfant en place', async () => {
    const { srv } = await connectedLab();
    expect(estabLines(await srv.executeCommand('ss -tna'))).toHaveLength(1);

    await srv.executeCommand('systemctl stop ssh');

    expect(await srv.executeCommand('ss -tna')).not.toContain('0.0.0.0:22');
    expect(estabLines(await srv.executeCommand('ss -tna'))).toHaveLength(1);
  });
});
