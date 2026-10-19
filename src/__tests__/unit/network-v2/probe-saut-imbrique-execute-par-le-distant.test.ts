/*
 * Un `ssh` tape DANS un shell distant est lance par la machine distante,
 * pas par le terminal de l'operateur.
 *
 * L'AUTORITE est OpenSSH : le client `ssh` est un processus du poste ou on
 * le tape. Quand l'operateur est connecte a A et tape `ssh user@B`, c'est
 * A qui ouvre la connexion TCP vers B, pose l'invite de mot de passe
 * (sur le terminal de A, donc ici relayee par le canal) et affiche la
 * banniere ; le poste de l'operateur ne fait que relayer des octets.
 *
 * Le sondage n'utilise AUCUN terminal : un client SSH brut (`SshSession` +
 * canal shell, `runLine`/`provideInput`), c'est-a-dire ce que n'importe
 * quel pilote d'interface verrait. Un terminal qui interceptait la ligne
 * avant le fil (l'ancien `startNestedHop`) ne laisse rien a ce client :
 * le serveur de A recevait `ssh user@B` comme une commande a executer.
 *
 * Mesure de depart, ligne `ssh user@B` tapee sur le canal de A :
 *
 *   invite de mot de passe renvoyee par A (pendingInput)     absente
 *   le prompt, apres la bonne reponse, est celui de B         non
 *   `hostname` tape ensuite s'execute sur B                   non
 *   `exit` ramene au prompt de A, A reste connecte            non
 *   un mauvais mot de passe relance l'invite (pendingInput)   non
 *
 * Discriminee par `git stash push -- src/network src/terminal src/shell` :
 * avant, les 6 cas tombent, y compris le journal de B (aucune connexion
 * n'a eu lieu, donc aucun `Accepted`). Le terminal qui pilotait le saut
 * lui-meme gardait son temoin dans les tests de terminal (ssh-multi-hop,
 * advanced-15-scenarios), qui passent des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';
import { noopSshLocalFs } from './_helpers/noopSshLocalFs';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ channel: ISshShellChannel; hostB: LinuxPC }> {
  const operator = new LinuxPC('linux-pc', 'operator');
  const hostA = new LinuxPC('linux-pc', 'hostA');
  const hostB = new LinuxPC('linux-pc', 'hostB');
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  [operator, hostA, hostB].forEach((pc, i) => {
    new Cable(`c${i}`).connect(pc.getPorts()[0], sw.getPorts()[i]);
    pc.getPorts()[0].configureIP(new IPAddress(`10.0.0.${i + 1}`), MASK);
  });
  for (const pc of [hostA, hostB]) {
    const userMgr = (pc as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void;
    } } }).executor.userMgr;
    userMgr.useradd('user', { m: true, s: '/bin/bash' });
    userMgr.setPassword('user', 'admin');
    await pc.executeCommand('sudo systemctl start ssh');
  }
  const dev = operator as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: noopSshLocalFs() as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const connected = await session.connect(
    SshConnectOptionsBuilder.create().host('10.0.0.2').user('user').password('admin')
      .strictHostKeyChecking('no').build());
  if (!isOk(connected)) throw new Error('connect to A failed');
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel on A failed');
  return { channel: channel.value, hostB };
}

describe('un ssh tape dans le shell de A est execute par A', () => {
  it('A renvoie lui-meme l\'invite de mot de passe de B', async () => {
    const { channel } = await lab();
    const result = await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    expect(result.pendingInput?.kind).toBe('password');
    expect(result.pendingInput?.promptText).toContain("user@10.0.0.3's password");
  });

  it('la bonne reponse ouvre B : le prompt change et le shell de A est empile', async () => {
    const { channel } = await lab();
    await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    const result = await channel.provideInput('admin');
    expect(result.prompt).toMatch(/user@hostB/);
    expect(result.nested).toBe(true);
  });

  it('`hostname` tape ensuite s\'execute sur B', async () => {
    const { channel } = await lab();
    await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    await channel.provideInput('admin');
    let seen = '';
    channel.onData((chunk) => { seen += chunk; });
    const result = await channel.runLine('hostname');
    expect(`${result.stdout}${seen}`).toContain('hostB');
  });

  it('`exit` ramene au prompt de A sans fermer la session de A', async () => {
    const { channel } = await lab();
    await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    await channel.provideInput('admin');
    const result = await channel.runLine('exit');
    expect(result.prompt).toMatch(/user@hostA/);
    expect(result.nested).toBe(false);
    expect(result.sessionEnded).not.toBe(true);
  });

  it('un mauvais mot de passe relance l\'invite, comme ssh', async () => {
    const { channel } = await lab();
    await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    const result = await channel.provideInput('wrong');
    expect(result.pendingInput?.kind).toBe('password');
  });

  it('le journal de B nomme l\'adresse de A', async () => {
    const { channel, hostB } = await lab();
    await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    await channel.provideInput('admin');
    expect(await hostB.executeCommand('sudo cat /var/log/auth.log'))
      .toMatch(/Accepted password for user from 10\.0\.0\.2 /);
  });
});
