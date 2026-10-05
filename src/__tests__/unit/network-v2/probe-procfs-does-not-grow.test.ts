/**
 * Personne n'invente une cle sous /proc/sys ou /sys, et `tee` dit ce qu'il n'a
 * pas pu ecrire, dans l'ordre ou le vrai `tee` le dit.
 *
 * Mesure de depart (commit precedent), un LinuxPC :
 *
 *   - `echo 3 > /proc/sys/net/ipv4/zorglub` (par `sudo sh -c`) ne disait rien et
 *     CREAIT un fichier ordinaire : `ls -l` montre `-rw-r--r-- 1 root root 2`,
 *     `cat` rend 3, `sysctl net.ipv4.zorglub` rend `net.ipv4.zorglub = 3`. Une
 *     cle inventee, lue ensuite comme une vraie ; une faute de frappe
 *     (`tcp_synn_retries`) n'etait donc jamais signalee, alors qu'un noyau repond
 *     « No such file or directory » ;
 *   - `tee` ne rendait aucune erreur : `echo hi | tee /nonexistent/dir/file`, `tee
 *     /etc/hostname` par un utilisateur et `tee /tmp` (un repertoire) imprimaient
 *     « hi » et rien d'autre, avec le code de sortie 0 ;
 *   - la redirection (`>`) et `tee` n'avaient pas la meme regle d'ouverture : la
 *     premiere refusait un repertoire, un systeme de fichiers en lecture seule,
 *     un refus de droits, un parent absent, la seconde rien.
 *
 * Autorite (lus) : noyau 5.15, `fs/proc/proc_sysctl.c` (`proc_sys_lookup` rend
 * ENOENT pour un nom qui n'existe pas, et `open(O_CREAT)` renvoie cette erreur :
 * on ne cree pas d'entree dans procfs) ; coreutils 8.32, `src/tee.c` (un fichier
 * qui ne s'ouvre pas : `tee: FICHIER: <erreur>` AVANT la copie, la copie continue
 * vers les autres, code de sortie 1 ; une ecriture refusee pendant la copie —
 * EINVAL d'un reglage — vient APRES la donnee que l'entree standard a recue en
 * premier, `fwrite` sur la sortie standard precedant celui des fichiers).
 *
 * Ce qui est construit : `VirtualFileSystem.isVirtualTree` (/proc et /sys) et le
 * refus de creer un fichier la par `writeFile` et `touch` ; `openRefusal`, la regle
 * d'ouverture en ecriture (repertoire, lecture seule, droits, parent, entree
 * absente de /proc ou /sys), extraite de la redirection pour que la redirection
 * et `tee` la partagent (`ShellContext.openRefusal`) ; `cmdTee` qui dit les
 * refus d'ouverture avant la donnee, les refus d'ecriture apres, et sort avec 1 ;
 * les deux fichiers `arp_accept` que la pile lit sont ensemences par
 * `createFileAt`, qui n'est pas concernee par le refus.
 *
 * Ce qui n'est PAS construit : `cp`, `mv`, `ln`, `mkdir`, `install` et `dd of=`
 * peuvent encore creer une entree sous /proc et /sys ; les erreurs de `tee` vont
 * dans le flux de sortie, comme celles des autres commandes de ce
 * repartiteur, si bien que dans un tube elles suivent la donnee au lieu de
 * rester sur le terminal.
 *
 * Discrimination (fichier copie sur le commit precedent) : DIX cas sur quatorze
 * tombent. Les quatre autres passent des deux cotes : deux TEMOINS (une cle qui
 * existe s'ecrit toujours par redirection, un `tee` dont tous les fichiers
 * s'ecrivent n'imprime que la donnee et sort avec 0) et deux NON-REGRESSIONS (un
 * fichier neuf hors de /proc et /sys est toujours cree, les reglages ARP que la
 * pile lit restent des fichiers qu'on ecrit et relit).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

function machine(): LinuxPC {
  return new LinuxPC('linux-pc', 'PC1');
}

describe('nobody invents a key under /proc/sys or /sys', () => {
  it('a redirect to a key that does not exist fails, as root and as a user', async () => {
    const pc = machine();
    expect(await pc.executeCommand(`sudo sh -c 'echo 3 > /proc/sys/net/ipv4/zorglub'`))
      .toBe('bash: /proc/sys/net/ipv4/zorglub: No such file or directory');
    expect(await pc.executeCommand('echo 3 > /proc/sys/net/ipv4/zorglub'))
      .toBe('bash: /proc/sys/net/ipv4/zorglub: No such file or directory');
  });

  it('the invented key is not there afterwards, for ls, cat and sysctl', async () => {
    const pc = machine();
    await pc.executeCommand(`sudo sh -c 'echo 3 > /proc/sys/net/ipv4/zorglub'`);
    expect(await pc.executeCommand('ls /proc/sys/net/ipv4/zorglub'))
      .toBe("ls: cannot access '/proc/sys/net/ipv4/zorglub': No such file or directory");
    expect(await pc.executeCommand('sysctl net.ipv4.zorglub'))
      .toBe('sysctl: cannot stat /proc/sys/net/ipv4/zorglub: No such file or directory');
  });

  it('a mistyped real key is caught the same way', async () => {
    const pc = machine();
    expect(await pc.executeCommand(`sudo sh -c 'echo 1 > /proc/sys/net/ipv4/tcp_synn_retries'`))
      .toBe('bash: /proc/sys/net/ipv4/tcp_synn_retries: No such file or directory');
  });

  it('tee and touch refuse as well', async () => {
    const pc = machine();
    expect(await pc.executeCommand('echo 3 | sudo tee /proc/sys/net/ipv4/zorglub'))
      .toBe('tee: /proc/sys/net/ipv4/zorglub: No such file or directory\n3');
    expect(await pc.executeCommand('sudo touch /proc/sys/net/ipv4/zorglub'))
      .toBe("touch: cannot touch '/proc/sys/net/ipv4/zorglub': No such file or directory");
    expect(await pc.executeCommand('ls /proc/sys/net/ipv4/zorglub'))
      .toBe("ls: cannot access '/proc/sys/net/ipv4/zorglub': No such file or directory");
  });

  it('/sys does not grow either', async () => {
    const pc = machine();
    expect(await pc.executeCommand(`sudo sh -c 'echo 1 > /sys/class/net/eth0/zorglub'`))
      .toBe('bash: /sys/class/net/eth0/zorglub: No such file or directory');
  });

  it('WITNESS: an existing key is still written through a redirect', async () => {
    const pc = machine();
    expect(await pc.executeCommand(`sudo sh -c 'echo 0 > /proc/sys/net/ipv4/tcp_sack'`)).toBe('');
    expect(await pc.executeCommand('sysctl -n net.ipv4.tcp_sack')).toBe('0');
  });

  it('NON-REGRESSION: outside /proc and /sys a new file is still created', async () => {
    const pc = machine();
    expect(await pc.executeCommand('echo hello > /tmp/new-file')).toBe('');
    expect(await pc.executeCommand('cat /tmp/new-file')).toBe('hello');
    expect(await pc.executeCommand('echo hi | tee /tmp/other-file')).toBe('hi');
    expect(await pc.executeCommand('cat /tmp/other-file')).toBe('hi');
  });

  it('NON-REGRESSION: the ARP settings the stack reads are still files that can be written and read', async () => {
    const pc = machine();
    expect(await pc.executeCommand('sudo sysctl -w net.ipv4.conf.all.arp_accept=1')).toBe('net.ipv4.conf.all.arp_accept = 1');
    expect(await pc.executeCommand('cat /proc/sys/net/ipv4/conf/all/arp_accept')).toBe('1');
  });
});

describe('tee says what it could not write, in coreutils\' words, and writes the rest', () => {
  it('a directory that does not exist', async () => {
    const pc = machine();
    expect(await pc.executeCommand('echo hi | tee /nonexistent/dir/file'))
      .toBe('tee: /nonexistent/dir/file: No such file or directory\nhi');
  });

  it('a file the user may not write', async () => {
    const pc = machine();
    expect(await pc.executeCommand('echo hi | tee /etc/hostname')).toBe('tee: /etc/hostname: Permission denied\nhi');
    expect((await pc.executeCommand('cat /etc/hostname')).trim()).not.toBe('hi');
  });

  it('a directory', async () => {
    const pc = machine();
    expect(await pc.executeCommand('echo hi | tee /tmp')).toBe('tee: /tmp: Is a directory\nhi');
  });

  it('a value a setting refuses: the copy to the terminal comes first, the refusal after it', async () => {
    const pc = machine();
    expect(await pc.executeCommand('echo abc | sudo tee /proc/sys/net/ipv4/tcp_sack'))
      .toBe('abc\ntee: /proc/sys/net/ipv4/tcp_sack: Invalid argument');
    expect(await pc.executeCommand('sysctl -n net.ipv4.tcp_sack')).toBe('1');
  });

  it('the files that can be written are written, the exit status is 1', async () => {
    const pc = machine();
    const out = await pc.executeCommand('echo hi | tee /nonexistent/x /tmp/ok; echo "status=$?"');
    expect(out).toBe('tee: /nonexistent/x: No such file or directory\nhi\nstatus=1');
    expect(await pc.executeCommand('cat /tmp/ok')).toBe('hi');
  });

  it('WITNESS: when every file is written, tee prints only the data and exits 0', async () => {
    const pc = machine();
    expect(await pc.executeCommand('echo hi | tee /tmp/a /tmp/b; echo "status=$?"')).toBe('hi\nstatus=0');
    expect(await pc.executeCommand('cat /tmp/a /tmp/b')).toBe('hi\nhi');
  });
});
