/**
 * Le client d'une commande ssh ferme sa prise le premier et garde le TIME-WAIT ; le serveur passe par CLOSE-WAIT et
 * LAST-ACK, ferme et ne garde rien, comme avec OpenSSH. Une session que le serveur termine laisse au contraire le
 * TIME-WAIT chez le serveur.
 *
 * Mesure de depart (ff7fa4389), trois LinuxPC cables par un commutateur : apres `ssh user@10.0.0.2 whoami`, `ss -tan` du
 * client n'avait aucune ligne pour la connexion et celui du serveur un TIME-WAIT ; le premier FIN du fil etait celui du
 * serveur, qui allait de FIN-WAIT-1 a TIME-WAIT pendant que le client allait de CLOSE-WAIT a LAST-ACK. Le client n'avait
 * pourtant pas change : `SshSession.disconnect()` envoie SSH_MSG_DISCONNECT puis ferme la prise. C'est le serveur qui,
 * depuis 8edb8c1c1, defaisait sa session dans la livraison meme du DISCONNECT (`connectionClosed` ferme l'enregistrement
 * de session, le moniteur sshd sort, et le faucheur de prises ferme la prise de la connexion) avant que le client ait pu
 * appeler `close()`. La livraison des trames est synchrone : la latence qui fait arriver le FIN du client avant la fin
 * du traitement du serveur n'existe pas. Le balayage cible de 8edb8c1c1 ne contenait pas
 * `scenario-ephemeral-port-coherence`, que ce defaut a fait tomber (3 cas : plus aucune ligne de connexion du cote
 * client apres la commande) ; ces trois cas passent de nouveau.
 *
 * Autorites : openssh-portable V_8_9_P1 lu depuis GitHub, `clientloop.c` (`client_loop` envoie SSH2_MSG_DISCONNECT,
 * motif BY_APPLICATION, « disconnected by user », et le vide avant de rendre la main) puis `ssh.c` (`main` appelle
 * `ssh_packet_close` des que `ssh_session2` rend l'etat de sortie) : le client ferme le premier ; RFC 9293 §3.6 : la
 * partie qui ferme la premiere entre en TIME-WAIT. Non confirme : ce que fait sshd entre la lecture du DISCONNECT et la
 * sortie du moniteur (la simulation attend la fin de l'appel du pair, une micro-tache).
 *
 * Ce qui est construit : `SshServerHandler` ne rend la session (`connectionClosed` puis `connectionEnded`, dans cet
 * ordre) qu'apres la fin de l'appel du pair quand la connexion s'est terminee par un DISCONNECT recu ; une connexion
 * perdue sans DISCONNECT (FIN, RST) la rend aussitot, comme avant. Ce qui n'est PAS construit : le meme ordre quand
 * c'est le client qui recoit le DISCONNECT du serveur ; et la commande `ssh hote 'a >> f'` s'execute deux fois sur le
 * serveur (autre defaut, mesure en cherchant celui-ci, non corrige ici).
 *
 * Discrimination (fichier copie sur ff7fa4389) : CINQ cas sur treize tombent. Les huit autres passent des deux cotes :
 * le temoin, scp (qui fermait deja le premier), deux non-regressions (les processus de session disparaissent et personne
 * n'est connecte ; sshd journalise la deconnexion annoncee et la fermeture de la session PAM), un pair qui annonce la
 * fin sans fermer sa prise est ferme par le serveur, l'orientation inverse (tuer le moniteur : le serveur ferme le
 * premier et garde le TIME-WAIT) et les deux cas Windows (client puis serveur). Mutations : quatre tuees sur six (rendre
 * la session aussitot 5 ; ne jamais la rendre apres un DISCONNECT 2 ; `connectionEnded` avant `connectionClosed` 1 ;
 * `connectionClosed` supprime 2). Les deux survivantes : differer aussi la perte sans DISCONNECT (equivalente : la
 * micro-tache se vide avant tout observateur qui attend, et rien dans la simulation n'observe une perte de facon
 * synchrone) et supprimer `connectionEnded` (elle libere la table des connexions PAM par pair, que ni une commande ni ce
 * fichier ne lisent).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import type { IPv4Packet } from '@/network/core/types';
import type { TcpSegment } from '@/network/tcp/types';
import { bytesToBinaryString } from '@/crypto/encoding';
import { SshWriter } from '@/network/protocols/ssh/wire/SshDataTypes';
import { CLEARTEXT, encodePacket } from '@/network/protocols/ssh/transport/SshBinaryPacket';
import { identificationLine } from '@/network/protocols/ssh/transport/SshIdentification';
import { SSH_MSG_DISCONNECT } from '@/network/protocols/ssh/transport/SshMessageNumbers';
import { watchWire, type WireWatch } from '../../support/wireWatch';
import { buildLan, assignIps, PC1_IP, PC2_IP, type SshLan } from './ssh-lan-fixtures';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

let lan: SshLan;

beforeEach(async () => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
  lan = buildLan();
  await assignIps(lan);
});

function watchFins(): WireWatch {
  return watchWire(lan.pc1, lan.pc2);
}

const finSenders = (watch: WireWatch): string[] => watch.frames
  .filter((entry) => entry.direction === 'out')
  .flatMap((entry) => {
    const segment = (entry.frame.payload as IPv4Packet | undefined)?.payload as TcpSegment | undefined;
    const ssh = segment?.sourcePort === 22 || segment?.destinationPort === 22;
    return segment?.type === 'tcp' && segment.flags.fin && ssh ? [entry.device] : [];
  });

function watchStates(): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  for (const machine of [lan.pc1, lan.pc2]) {
    machine.getBus().subscribe('tcp.state.changed', (event) => {
      const { localPort, remotePort, newState, hostname } = event.payload;
      if (localPort !== 22 && remotePort !== 22) return;
      const key = `${hostname}:${localPort === 22 ? remotePort : localPort}`;
      paths.set(key, [...(paths.get(key) ?? []), newState]);
    });
  }
  return paths;
}

const pathsOf = (paths: Map<string, string[]>, host: string) =>
  [...paths.entries()].filter(([key]) => key.startsWith(`${host}:`)).map(([, path]) => path);

const sshRows = (listing: string, state: string, peer: string) =>
  listing.split('\n').filter((line) => line.startsWith(state) && line.includes(peer));

const stateOf = async (machine: LinuxPC, state: string, peer: string) =>
  sshRows(await machine.executeCommand('ss -tan'), state, peer);

const monitorPid = async (machine: LinuxPC): Promise<number> => {
  const listing = await machine.executeCommand('ps -eo pid,args');
  const row = listing.split('\n').find((line) => /sshd: user \[priv\]/.test(line));
  return Number(row?.trim().split(/\s+/)[0]);
};

describe('the bench is sound (witness)', () => {
  it('a one-shot command runs and answers', async () => {
    expect(await lan.pc1.executeCommand(`ssh user@${PC2_IP} whoami`, 'admin\n')).toContain('user');
  });
});

describe('the client of a one-shot command closes first and keeps the TIME-WAIT', () => {
  it('the client lists the connection in TIME-WAIT and the server lists nothing of it', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} whoami`, 'admin\n');
    expect(await stateOf(lan.pc1, 'TIME-WAIT', `${PC2_IP}:22`)).toHaveLength(1);
    expect((await lan.pc2.executeCommand('ss -tan')).split('\n').filter((line) => line.includes(`${PC1_IP}:`))).toEqual([]);
  });

  it('the first FIN on the wire is the client one, the server answers with its own', async () => {
    const wire = watchFins();
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} whoami`, 'admin\n');
    expect(finSenders(wire)).toEqual(['PC1', 'PC2']);
  });

  it('the server then goes through CLOSE-WAIT and LAST-ACK to closed, the client through FIN-WAIT-2 to TIME-WAIT', async () => {
    const paths = watchStates();
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} whoami`, 'admin\n');
    expect(pathsOf(paths, 'PC2').filter((path) => path.includes('established'))).toEqual([
      ['syn-received', 'established', 'close-wait', 'last-ack', 'closed'],
    ]);
    expect(pathsOf(paths, 'PC1').filter((path) => path.includes('established'))).toEqual([
      ['syn-sent', 'established', 'fin-wait-1', 'fin-wait-2', 'time-wait'],
    ]);
  });

  it('three commands in a row leave three TIME-WAIT connections on distinct source ports at the client, none at the server', async () => {
    for (let round = 0; round < 3; round += 1) await lan.pc1.executeCommand(`ssh user@${PC2_IP} whoami`, 'admin\n');
    const waiting = await stateOf(lan.pc1, 'TIME-WAIT', `${PC2_IP}:22`);
    expect(waiting).toHaveLength(3);
    const ports = waiting.map((row) => row.trim().split(/\s+/)[3].split(':').pop());
    expect(new Set(ports).size).toBe(3);
    expect(await stateOf(lan.pc2, 'TIME-WAIT', PC1_IP)).toEqual([]);
  });

  it('an interactive session fed on standard input ends the same way', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP}`, 'admin\nhostname\nexit\n');
    expect(await stateOf(lan.pc1, 'TIME-WAIT', `${PC2_IP}:22`)).toHaveLength(1);
    expect(await stateOf(lan.pc2, 'TIME-WAIT', PC1_IP)).toEqual([]);
  });

  it('scp ends the same way', async () => {
    await lan.pc1.executeCommand(`sshpass -p admin scp -o StrictHostKeyChecking=no /etc/hostname user@${PC2_IP}:/tmp/hostname`);
    expect(await stateOf(lan.pc1, 'TIME-WAIT', `${PC2_IP}:22`)).toHaveLength(1);
    expect(await stateOf(lan.pc2, 'TIME-WAIT', PC1_IP)).toEqual([]);
  });
});

describe('the session still ends on the server, and the server still tells its journal', () => {
  it('the session processes are gone and nobody is logged in once the command returns', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} whoami`, 'admin\n');
    expect(await lan.pc2.executeCommand('ps -eo args')).not.toMatch(/sshd: user \[priv\]/);
    expect(await lan.pc2.executeCommand('who')).not.toMatch(/pts\//);
  });

  it('sshd logs the disconnection the client announced', async () => {
    await lan.pc1.executeCommand(`ssh user@${PC2_IP} whoami`, 'admin\n');
    const journal = await lan.pc2.executeCommand('journalctl -u ssh --no-pager');
    expect(journal).toMatch(/Received disconnect from 10\.0\.0\.1 port \d+:11: disconnected by user/);
    expect(journal).toMatch(/Disconnected from user user 10\.0\.0\.1 port \d+/);
    expect(await lan.pc2.executeCommand('cat /var/log/auth.log')).toMatch(/pam_unix\(sshd:session\): session closed for user user/);
  });
});

describe('the server still closes its side when the peer announced the end and does not close', () => {
  it('a peer that sends DISCONNECT and keeps its TCP open is closed by the server, which holds the TIME-WAIT', async () => {
    const wire = watchFins();
    const peer = lan.pc1.getTcpStack().connect(PC2_IP, 22, {})!;
    await settle();
    peer.send(identificationLine('SSH-2.0-silent_peer'));
    const goodbye = new SshWriter().writeByte(SSH_MSG_DISCONNECT).writeUint32(11).writeString('bye').writeString('').toBytes();
    peer.send(bytesToBinaryString(encodePacket(goodbye, CLEARTEXT, 0, (count) => new Uint8Array(count))));
    await settle();
    expect(finSenders(wire)).toEqual(['PC2', 'PC1']);
    expect(await stateOf(lan.pc2, 'TIME-WAIT', PC1_IP)).toHaveLength(1);
    expect(await stateOf(lan.pc1, 'TIME-WAIT', `${PC2_IP}:22`)).toEqual([]);
  });
});

describe('a session the server ends keeps the TIME-WAIT on the server', () => {
  it('killing the monitor of a tunnel session: the first FIN is the server one, which then holds the TIME-WAIT', async () => {
    await lan.pc1.executeCommand(`ssh -f -N -L 9003:${PC2_IP}:8080 user@${PC2_IP}`, 'admin\n');
    expect(await stateOf(lan.pc1, 'ESTAB', `${PC2_IP}:22`)).toHaveLength(1);
    const wire = watchFins();
    await lan.pc2.executeCommand(`sudo kill ${await monitorPid(lan.pc2)}`);
    await settle();
    expect(finSenders(wire)).toEqual(['PC2', 'PC1']);
    expect(await stateOf(lan.pc2, 'TIME-WAIT', PC1_IP)).toHaveLength(1);
    expect(await stateOf(lan.pc1, 'TIME-WAIT', `${PC2_IP}:22`)).toEqual([]);
  });
});

describe('a Windows machine ends a session the same way, as client and as server', () => {
  async function pair(): Promise<{ readonly linux: LinuxPC; readonly win: WindowsPC }> {
    const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
    const win = new WindowsPC('windows-pc', 'WIN', 100, 0);
    linux.powerOn();
    win.powerOn();
    win.setCurrentUser('Administrator');
    new Cable('c1').connect(linux.getPort('eth0')!, win.getPort('eth0')!);
    await linux.executeCommand('ifconfig eth0 10.0.0.3');
    await win.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
    return { linux, win };
  }

  it('a Windows client of a one-shot command keeps the TIME_WAIT, the Linux server keeps none', async () => {
    const { linux, win } = await pair();
    expect(await win.executeCommand('ssh user@10.0.0.3 whoami', 'admin\n')).toContain('user');
    expect(await win.executeCommand('netstat -an')).toMatch(/TCP\s+10\.0\.0\.7:\d+\s+10\.0\.0\.3:(ssh|22)\s+TIME_WAIT/);
    expect(await stateOf(linux, 'TIME-WAIT', '10.0.0.7')).toEqual([]);
  });

  it('a Linux client of a one-shot command keeps the TIME-WAIT, the Windows server keeps none', async () => {
    const { linux, win } = await pair();
    expect(await linux.executeCommand('ssh Administrator@10.0.0.7 whoami', 'admin\n')).toContain('Administrator');
    expect(await stateOf(linux, 'TIME-WAIT', '10.0.0.7:22')).toHaveLength(1);
    expect(await win.executeCommand('netstat -an')).not.toMatch(/10\.0\.0\.3:\d+/);
  });
});
