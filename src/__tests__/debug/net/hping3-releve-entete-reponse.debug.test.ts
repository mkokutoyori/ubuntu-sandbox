/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Deuxieme banc hping3. Le premier (`hping3-releve.debug.test.ts`) a
 * mesure le MODE (quel paquet part sur le fil). Celui-ci mesure ce que
 * la ligne de reponse dit de l EN-TETE DE LA REPONSE : le jeu de
 * drapeaux reellement recu, son id IP, sa longueur, son DF, et les
 * lignes supplementaires que `-V`, `-Q` et le mode `--scan` doivent
 * produire. Source amont lu : `waitpacket.c:160-183` (log_ip),
 * `waitpacket.c:370-400` (ligne TCP et lignes verbeuses),
 * `scan.c:191-204` (tcp_strflags) et `scan.c:423-440` (table).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

const note = (l: string) => { console.log(l); };

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'web', 0, 0);
  pc.powerOn();
  srv.powerOn();
  const cable = new Cable('c');
  cable.connect(pc.getPort('eth0') as never, srv.getPort('eth0') as never);
  for (const cmd of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) {
    await pc.executeCommand(cmd);
  }
  for (const cmd of [
    'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0',
    'systemctl start nginx', 'systemctl start sshd',
  ]) {
    await srv.executeCommand(cmd);
  }
  return { pc, srv };
}

describe('hping3 : ce que la ligne dit de l en-tete de la reponse', () => {
  it('releve', async () => {
    const { pc } = await lab();

    note('[E] le jeu de DRAPEAUX imprime est-il celui de la reponse ?');
    for (const [label, cmd] of [
      ['-S vers 80 ouvert ', 'hping3 -S -p 80 -c 1 10.0.0.2'],
      ['-S vers 81 ferme  ', 'hping3 -S -p 81 -c 1 10.0.0.2'],
      ['-F vers 81 ferme  ', 'hping3 -F -p 81 -c 1 10.0.0.2'],
      ['-A vers 81 ferme  ', 'hping3 -A -p 81 -c 1 10.0.0.2'],
    ] as const) {
      const out = await pc.executeCommand(cmd);
      note(`[E] ${label} -> ${out.split('\n').filter(l => l.startsWith('len=')).join(' | ') || '(aucune ligne len=)'}`);
    }
    note('      waitpacket.c:376-386 construit la chaine depuis tcp.th_flags RECU :');
    note('      un RST seul s imprime "R", un RST+ACK "RA", aucun drapeau "none".');

    note('');
    note('[F] les champs IP imprimes (id, len, DF) viennent-ils de la reponse ?');
    const three = await pc.executeCommand('hping3 -S -p 80 -c 3 10.0.0.2');
    for (const l of three.split('\n').filter(l => l.startsWith('len='))) note(`[F] ${l}`);
    note('      log_ip imprime ip.id de la REPONSE (et "DF " si son frag_off le porte),');
    note('      pas le compteur de paquets : trois lignes identiques en id sont suspectes.');

    note('');
    note('[G] -V/--verbose doit ajouter DEUX lignes (log_ip puis la branche TCP)');
    const verbose = await pc.executeCommand('hping3 -S -p 80 -c 1 -V 10.0.0.2');
    note(`[G] sortie complete : ${JSON.stringify(verbose.split('\n').slice(0, 6))}`);
    note('      attendu : "tos=0 iplen=44" apres l en-tete IP,');
    note('      puis "seq=<isn> ack=<ack> sum=<cksum> urp=0".');

    note('');
    note('[H] options encore refusees ou muettes');
    for (const cmd of [
      'hping3 --help',
      'hping3 --version',
      'hping3 -S -p 80 -c 1 -Q 10.0.0.2',
      'hping3 -S -p 80 -c 1 -M 12345 10.0.0.2',
      'hping3 -S -p 80 -c 1 -L 99 10.0.0.2',
      'hping3 -S -p 80 -c 1 -o 0x10 10.0.0.2',
      'hping3 --scan 79-81 -S 10.0.0.2',
      'hping3 -8 known -S 10.0.0.2',
    ]) {
      const out = await pc.executeCommand(cmd);
      note(`[H] ${cmd.padEnd(38)} -> ${(out.split('\n')[0] ?? '').slice(0, 76)}`);
    }

    note('');
    note('[I] -d met-il vraiment la charge sur le fil en mode TCP ?');
    const port = pc.getPort('eth0') as unknown as { getCounters(): { bytesOut: number } };
    for (const cmd of ['hping3 -S -p 80 -c 1 10.0.0.2', 'hping3 -S -p 80 -d 400 -c 1 10.0.0.2']) {
      const before = port.getCounters().bytesOut;
      const out = await pc.executeCommand(cmd);
      note(`[I] ${cmd.padEnd(34)} octets +${port.getCounters().bytesOut - before}  | ${(out.split('\n')[0] ?? '').slice(0, 60)}`);
    }
    note('      l ecart d octets doit suivre les 400 annonces, sinon -d est decoratif.');

    expect(true).toBe(true);
  });
});
