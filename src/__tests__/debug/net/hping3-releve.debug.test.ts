/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * `hping3` existe deja (`commands/net/Hping3.ts`). Ce banc mesure sa
 * fidelite : ce qu'il IMPRIME par paquet, et ce qu'il pose VRAIMENT sur
 * le fil selon le mode (-S/-1/-2/-0).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

const note = (l: string) => { console.log(l); };

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer; cable: Cable }> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'web', 0, 0);
  pc.powerOn();
  srv.powerOn();
  const cable = new Cable('c');
  cable.connect(pc.getPort('eth0') as never, srv.getPort('eth0') as never);
  for (const cmd of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) {
    await pc.executeCommand(cmd);
  }
  for (const cmd of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0', 'systemctl start nginx']) {
    await srv.executeCommand(cmd);
  }
  return { pc, srv, cable };
}

function frames(pc: LinuxPC): number {
  const port = pc.getPort('eth0') as unknown as { getCounters(): { framesOut: number } };
  return port.getCounters().framesOut;
}

describe('hping3 : ce qu il imprime et ce qu il emet', () => {
  it('releve', async () => {
    const { pc } = await lab();

    note('[A] la LIGNE DE REPONSE distingue-t-elle un port ouvert d un port ferme ?');
    note(`[A-1] port 80 OUVERT  : ${(await pc.executeCommand('hping3 -S -p 80 -c 1 10.0.0.2')).split('\n').filter(l => l.startsWith('len=')).join(' | ') || '(aucune ligne len=)'}`);
    note(`[A-2] port 81 FERME   : ${(await pc.executeCommand('hping3 -S -p 81 -c 1 10.0.0.2')).split('\n').filter(l => l.startsWith('len=')).join(' | ') || '(aucune ligne len=)'}`);
    note('      attendu d un vrai hping3 : flags=SA pour l ouvert, flags=RA pour le ferme,');
    note('      et la fenetre annoncee par la cible (win) au lieu de 0.');

    note('');
    note('[B] le TTL imprime est-il celui de la REPONSE ou celui de ma requete ?');
    note(`[B-1] -t 5 vers un port ouvert : ${(await pc.executeCommand('hping3 -S -p 80 -t 5 -c 1 10.0.0.2')).split('\n').filter(l => l.startsWith('len=')).join(' | ')}`);
    note('      attendu : le ttl de la reponse (64 ici), pas le 5 que j ai emis.');

    note('');
    note('[C] chaque mode pose-t-il le BON paquet sur le fil ? (trames emises par eth0)');
    for (const [label, cmd] of [
      ['-S  tcp  ', 'hping3 -S -p 80 -c 2 10.0.0.2'],
      ['-1  icmp ', 'hping3 -1 -c 2 10.0.0.2'],
      ['-2  udp  ', 'hping3 -2 -p 53 -c 2 10.0.0.2'],
      ['-0  rawip', 'hping3 -0 -c 2 10.0.0.2'],
    ] as const) {
      const before = frames(pc);
      const out = await pc.executeCommand(cmd);
      const after = frames(pc);
      const stat = out.split('\n').find(l => l.includes('packets transmitted')) ?? '';
      note(`[C] ${label} trames +${after - before}  | ${stat.trim()}`);
    }
    note('      -2 doit poser des datagrammes UDP, -0 un paquet IP brut :');
    note('      s ils empruntent le chemin TCP, la trame est un mensonge (regle 4).');

    note('');
    note('[D] options caracteristiques de hping3 : sont-elles reconnues ?');
    for (const cmd of [
      'hping3 -S -p ++80 -c 3 10.0.0.2',
      'hping3 -S -p 80 -k -c 2 10.0.0.2',
      'hping3 -S -p 80 --flood -c 2 10.0.0.2',
      'hping3 -S -p 80 -w 512 -c 1 10.0.0.2',
      'hping3 -S -p 80 -N 42 -c 1 10.0.0.2',
    ]) {
      const out = await pc.executeCommand(cmd);
      const first = out.split('\n')[0] ?? '';
      note(`[D] ${cmd.padEnd(40)} -> ${first.slice(0, 74)}`);
    }

    expect(true).toBe(true);
  });
});
