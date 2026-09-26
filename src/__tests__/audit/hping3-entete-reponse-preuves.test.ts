/**
 * SONDE — `hping3` doit imprimer l'en-tete que la REPONSE porte, et le
 * mode `--scan` doit exister.
 *
 * Source amont lu (`github.com/antirez/hping`, deja clone pour le lot
 * precedent, `release.h` → 3.0.0-alpha-1) :
 *   - `waitpacket.c:160-183` — `log_ip` : `len=` est la taille du paquet
 *     IP RECU, `ttl=` son ttl, `DF ` parait quand son frag_off le porte,
 *     `id=` est son identification. La fonction n'imprime PAS de saut de
 *     ligne : en `-V` son propre `tos=%x iplen=%u` le termine, donc la
 *     partie protocolaire tombe a la ligne suivante.
 *   - `waitpacket.c:376-400` — la chaine de drapeaux est construite
 *     depuis `tcp.th_flags` RECU (ordre R,S,A,F,P,U), `none` si vide ;
 *     `-V` ajoute `seq= ack= sum= urp=`.
 *   - `waitpacket.c:357-369` — `-Q` remplace la ligne par
 *     `%10lu +%lu` : la sequence recue et son ecart avec la precedente.
 *   - `scan.c:191-204` (`tcp_strflags` : 8 colonnes, `ftab "FSRPAYXY"`,
 *     point pour un drapeau absent) et `scan.c:423-441` (la table, et le
 *     filtre `(tcp.th_flags & TH_SYN) || opt_verbose`), `scan.c:526-529`
 *     (l'entete) et `scan.c:332-338` (`All replies received. Done.` puis
 *     `Not responding ports: `).
 *   - `hping2.h:117` — `DEFAULT_VIRTUAL_MTU 16`, la taille que `-f`
 *     donne aux fragments.
 *   - `usage.c` / `version.c` + `release.h` — les textes de `--help` et
 *     `-v`.
 *
 * Ce que prouve le cas `-M`/`-L`, et pourquoi il lit la REPONSE : RFC
 * 9293 §3.10.7.1 — un port ferme repond a un SYN par un RST+ACK dont
 * l'acquittement vaut SEG.SEQ+1, donc `-M 12345` ressort en `ack=12346` ;
 * au meme endroit, un segment PORTANT un ACK recoit un RST NU dont la
 * sequence vaut SEG.ACK, donc `-L 99` ressort en `seq=99`. La preuve
 * n'est pas ce que la sonde a ecrit, c'est ce que la cible en a fait.
 *
 * DISCRIMINATION mesuree avec `git stash push -- src/network` : 9 cas
 * sur 11 tombent avant le lot.
 *
 * Les DEUX cas qui ne discriminent pas, et pourquoi on les garde :
 *   - `TEMOIN le port ouvert reste distinct du port ferme` : acquis du
 *     lot precedent, il passe des deux cotes. Il prouve que le
 *     laboratoire est sain — sans lui, une sonde faite de refus ne
 *     prouverait rien.
 *   - `-p ++ incremente a chaque envoi` : non-regression, le lot ne
 *     touche pas a cette mecanique.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

let pc: LinuxPC;
let srv: LinuxServer;

beforeEach(async () => {
  pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  srv = new LinuxServer('linux-server', 'web', 0, 0);
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
});

function replyLines(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('len='));
}

describe('hping3 : la ligne dit l en-tete de la reponse', () => {
  it('TEMOIN le port ouvert reste distinct du port ferme', async () => {
    const open = replyLines(await pc.executeCommand('hping3 -S -p 80 -c 1 10.0.0.2'));
    const closed = replyLines(await pc.executeCommand('hping3 -S -p 81 -c 1 10.0.0.2'));
    expect(open[0]).toContain('flags=SA');
    expect(closed[0]).toContain('flags=RA');
  });

  it('un RST SANS ACK s imprime R, parce que la pile en envoie un', async () => {
    const line = replyLines(await pc.executeCommand('hping3 -A -p 81 -c 1 10.0.0.2'))[0];
    expect(line).toContain('flags=R ');
    expect(line).not.toContain('flags=RA');
  });

  it('len= est la longueur du paquet RECU, pas une constante', async () => {
    const synAck = replyLines(await pc.executeCommand('hping3 -S -p 80 -c 1 10.0.0.2'))[0];
    const rst = replyLines(await pc.executeCommand('hping3 -S -p 81 -c 1 10.0.0.2'))[0];
    const lengthOf = (l: string): number => Number(/^len=(\d+)/.exec(l)?.[1]);
    expect(lengthOf(synAck)).toBeGreaterThan(lengthOf(rst));
    expect(lengthOf(rst)).toBe(40);
  });

  it('id= est l identification de la reponse, donc elle change d un paquet a l autre', async () => {
    const lines = replyLines(await pc.executeCommand('hping3 -S -p 80 -c 3 10.0.0.2'));
    const ids = lines.map((l) => Number(/ id=(\d+) /.exec(l)?.[1]));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toEqual([0, 1, 2]);
  });

  it('DF parait quand la reponse porte le bit', async () => {
    const line = replyLines(await pc.executeCommand('hping3 -S -p 80 -c 1 10.0.0.2'))[0];
    expect(line).toMatch(/ttl=\d+ DF id=/);
  });

  it('-V coupe la ligne apres tos=/iplen= et ajoute seq/ack/sum/urp', async () => {
    const out = (await pc.executeCommand('hping3 -S -p 80 -c 1 -V 10.0.0.2')).split('\n');
    const ipLine = out.find((l) => l.startsWith('len='));
    expect(ipLine).toMatch(/tos=0 iplen=\d+$/);
    expect(out.some((l) => l.startsWith('sport=80 flags=SA'))).toBe(true);
    expect(out.some((l) => /^seq=\d+ ack=\d+ sum=[0-9a-f]+ urp=0$/.test(l))).toBe(true);
  });

  it('-Q remplace la ligne par la sequence recue et son ecart', async () => {
    const out = (await pc.executeCommand('hping3 -S -p 80 -c 2 -Q 10.0.0.2')).split('\n');
    expect(replyLines(out.join('\n'))).toHaveLength(0);
    const rows = out.filter((l) => /^\s*\d+ \+\d+$/.test(l));
    expect(rows).toHaveLength(2);
  });

  it('-M et -L posent la sequence et l acquittement sur le fil, et la CIBLE les renvoie', async () => {
    const fromSyn = await pc.executeCommand('hping3 -S -p 81 -c 1 -M 12345 -V 10.0.0.2');
    expect(fromSyn).not.toContain('unknown option');
    const synReply = fromSyn.split('\n').find((l) => l.startsWith('seq='));
    expect(Number(/ ack=(\d+)/.exec(synReply as string)?.[1])).toBe(12346);

    const fromAck = await pc.executeCommand('hping3 -A -p 81 -c 1 -L 99 -V 10.0.0.2');
    const ackReply = fromAck.split('\n').find((l) => l.startsWith('seq='));
    expect(Number(/^seq=(\d+)/.exec(ackReply as string)?.[1])).toBe(99);
  });

  it('--scan pose la table amont et ne montre que les ports qui repondent SYN', async () => {
    const out = await pc.executeCommand('hping3 --scan 21-23,80 -S 10.0.0.2');
    const lines = out.split('\n');
    expect(lines[0]).toBe('4 ports to scan, use -V to see all the replies');
    expect(lines[2]).toBe('|port| serv name |  flags  |ttl| id  | win | len |');
    const rows = lines.filter((l) => /^\s+\d+ \S+\s*: /.test(l));
    expect(rows.map((r) => r.trim().split(/\s+/)[0])).toEqual(['22', '80']);
    expect(rows[0]).toContain('ssh');
    expect(rows[0]).toContain('.S..A...');
    expect(out).toContain('All replies received. Done.');
  });

  it('--scan -V montre AUSSI les ports fermes, avec leur colonne de drapeaux', async () => {
    const out = await pc.executeCommand('hping3 --scan 80,81 -S -V 10.0.0.2');
    const rows = out.split('\n').filter((l) => /^\s+\d+ \S+\s*: /.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('..R.A...');
  });

  it('-p ++ incremente a chaque envoi', async () => {
    const out = await pc.executeCommand('hping3 -S -p ++79 -c 3 10.0.0.2');
    const ports = replyLines(out).map((l) => /sport=(\d+)/.exec(l)?.[1]);
    expect(ports).toEqual(['79', '80', '81']);
  });
});
