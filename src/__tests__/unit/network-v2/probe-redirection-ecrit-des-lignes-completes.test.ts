/**
 * `cmd > fichier` ecrit ce que le programme ecrit sur sa sortie standard. Un programme qui rend des
 * LIGNES (`whoami`, `uname`, `hostname`, `ls`, `id`) termine la derniere par `\n` ; or le registre
 * rend son texte SANS ce `\n` final (le terminal l'ajoute a l'affichage) et la redirection le
 * recopiait tel quel : `uname -r > f` ecrivait 18 octets au lieu de 19, `wc -l f` rendait 0, et
 * `uname -r >> f; uname -s >> f` collait « 5.15.0-130-genericLinux » sur une seule ligne. `cat f > g`
 * perdait de meme le `\n` de `f` : `cmp f g` repondait `EOF on g`.
 *
 * Le defaut vient du choix « verbatim a la redirection » du modele : il est juste pour un flux
 * d'octets (`printf abc > f` ecrit 3 octets, `echo -n`), faux pour un programme de lignes. Le
 * pilote de commandes DECLARE desormais lesquelles ecrivent des lignes (tout ce qui n'est pas dans
 * `RAW_STDOUT_COMMANDS` : cat, head, tail, tee, tr, sed, awk, dd, base64, compresseurs, clients
 * reseau, interpreteurs et enveloppes), plutot que de deviner d'apres le contenu ; `cat` rend
 * les octets du fichier tels quels.
 *
 * Deuxieme defaut mesure : une affectation en prefixe n'atteignait pas `bash -c` / `sh -c`.
 * `FOO=5 bash -c 'echo $FOO'` rendait vide, `FOO=7 sh -c 'echo $FOO'` rendait la valeur d'AVANT :
 * l'enfant lisait la table de variables de la machine et non l'environnement que le shell
 * construit pour lui (`childEnvironment` : variables exportees plus le prefixe).
 *
 * Trouves en route, memes causes d'horloge : une LECTURE avancait l'heure d'acces a chaque
 * fois (`strictatime`), alors qu'un Ubuntu monte en `relatime` ne la touche que si elle est plus
 * ancienne que la modification ou que 24 h — `stat` d'un fichier relu changeait de nanoseconde a
 * chaque lecture, et deux `stat` de `/etc/passwd` autour d'une connexion SSH ne s'accordaient plus
 * (`ssh-lan-commands-availability` rouge). Les dates de fichiers portaient une fraction de
 * milliseconde venue de l'horloge de trajet : le listing vsftpd comparait ce `mtime` a l'heure
 * entiere de la machine, voyait un fichier « dans le futur » et affichait l'annee a la place de
 * l'heure (`vsftpd-and-curl-ftp` rouge) ; le systeme de fichiers date maintenant en millisecondes
 * entieres, et vsftpd lit l'horloge de SA machine plutot que l'horloge globale.
 *
 * Discriminee contre l'etat d'avant (sources de `HEAD`, meme sonde) : 13 des 21 cas tombent. Les 8
 * qui passent des deux cotes sont NOMMES : `pwd` (builtin du shell, il ecrivait deja son `\n`),
 * `printf`/`echo -n` (octets exacts : la regle n'est pas un `\n` colle partout), `ls` d'un
 * repertoire vide (reste vide), `FOO=8 env | grep FOO` (le prefixe se voyait deja d'une commande
 * simple), la variable non exportee qui ne traverse pas, le prefixe qui ne survit pas a sa
 * commande (non-regression), la lecture apres plus d'un jour qui rafraichit l'heure d'acces
 * (non-regression) et la premiere lecture apres modification (temoin du `relatime`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { LinuxServer } from '@/network/devices/LinuxServer';

async function machine(): Promise<LinuxServer> {
  return new LinuxServer('linux-server', 'S1');
}

describe('a redirected line-oriented command writes complete lines', () => {
  it.each(['whoami', 'uname -r', 'uname -s', 'hostname', 'ls /etc/hostname', 'id -un', 'pwd'])(
    '%s > file ends with a newline', async (command) => {
      const s = await machine();
      await s.executeCommand(`${command} > /tmp/out`);
      expect((await s.executeCommand('wc -l < /tmp/out')).trim()).toBe('1');
    });

  it('>> appends a second line instead of gluing it to the first', async () => {
    const s = await machine();
    await s.executeCommand('uname -r >> /tmp/m; uname -s >> /tmp/m');
    expect(await s.executeCommand('cat /tmp/m')).toBe('5.15.0-130-generic\nLinux');
  });

  it('sudo cmd > file writes the line of the inner command', async () => {
    const s = await machine();
    await s.executeCommand('sudo whoami > /tmp/s');
    expect((await s.executeCommand('wc -c < /tmp/s')).trim()).toBe('5');
  });

  it('cat copies the bytes of a file, trailing newline included', async () => {
    const s = await machine();
    await s.executeCommand('cat /etc/hostname > /tmp/copy');
    expect(await s.executeCommand('cmp /etc/hostname /tmp/copy && echo same')).toBe('same');
  });

  it('witness: printf and echo -n keep their exact bytes', async () => {
    const s = await machine();
    await s.executeCommand('printf abc > /tmp/p; echo -n abc > /tmp/e; printf "a\\nb" > /tmp/n; cat /tmp/n > /tmp/n2');
    expect((await s.executeCommand('wc -c < /tmp/p')).trim()).toBe('3');
    expect((await s.executeCommand('wc -c < /tmp/e')).trim()).toBe('3');
    expect((await s.executeCommand('wc -c < /tmp/n2')).trim()).toBe('3');
  });

  it('witness: a command with no output writes an empty file', async () => {
    const s = await machine();
    await s.executeCommand('mkdir /tmp/empty; ls /tmp/empty > /tmp/none');
    expect((await s.executeCommand('wc -c < /tmp/none')).trim()).toBe('0');
  });
});

describe('a prefix assignment reaches bash -c and sh -c', () => {
  it('FOO=5 bash -c sees FOO, even when the shell holds another value', async () => {
    const s = await machine();
    expect(await s.executeCommand("FOO=3; FOO=5 bash -c 'echo $FOO'")).toBe('5');
  });

  it('FOO=7 sh -c sees FOO', async () => {
    const s = await machine();
    expect(await s.executeCommand("FOO=7 sh -c 'echo $FOO'")).toBe('7');
  });

  it('the child sees the exported variables and the prefix together', async () => {
    const s = await machine();
    expect(await s.executeCommand("export Y=2; Z=9 bash -c 'echo $Y $Z'")).toBe('2 9');
  });

  it('the prefix does not outlive the command, and the child cannot change the parent', async () => {
    const s = await machine();
    expect(await s.executeCommand("W=4 bash -c 'W=5; echo $W'; echo \"[$W]\"")).toBe('5\n[]');
  });

  it('witness: a prefix is visible to a simple command', async () => {
    const s = await machine();
    expect(await s.executeCommand('FOO=8 env | grep FOO')).toBe('FOO=8');
  });

  it('witness: an unexported variable does not cross into the child', async () => {
    const s = await machine();
    expect(await s.executeCommand("unexported=1; bash -c 'echo \"[$unexported]\"'")).toBe('[]');
  });
});

describe('reading a file follows relatime, as the default Ubuntu mount does', () => {
  const ACCESS = "stat /tmp/r | grep '^Access: 2'";

  async function labWithClock(): Promise<{ s: LinuxServer; clock: SimulationClock }> {
    const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: Date.UTC(2026, 9, 6, 12, 0, 0) }));
    return { s: await machine(), clock };
  }

  afterEach(() => __resetSimulationClock());

  it('a second read does not move the access time while it is newer than the modification time', async () => {
    const { s, clock } = await labWithClock();
    await s.executeCommand('echo data > /tmp/r');
    await clock.advance(5000);
    await s.executeCommand('cat /tmp/r > /dev/null');
    const first = await s.executeCommand(ACCESS);
    await clock.advance(5000);
    await s.executeCommand('cat /tmp/r > /dev/null; cat /tmp/r > /dev/null');
    expect(await s.executeCommand(ACCESS)).toBe(first);
  });

  it('a read after more than a day moves it again', async () => {
    const { s, clock } = await labWithClock();
    await s.executeCommand('echo data > /tmp/r');
    await clock.advance(5000);
    await s.executeCommand('cat /tmp/r > /dev/null');
    const first = await s.executeCommand(ACCESS);
    await clock.advance(25 * 3600_000);
    await s.executeCommand('cat /tmp/r > /dev/null');
    expect(await s.executeCommand(ACCESS)).not.toBe(first);
  });

  it('witness: the first read after a modification does move it', async () => {
    const { s, clock } = await labWithClock();
    await s.executeCommand('echo data > /tmp/r');
    await clock.advance(5000);
    await s.executeCommand('cat /tmp/r > /dev/null');
    const read = await s.executeCommand(ACCESS);
    await clock.advance(5000);
    await s.executeCommand('echo more >> /tmp/r');
    await clock.advance(5000);
    await s.executeCommand('cat /tmp/r > /dev/null');
    expect(await s.executeCommand(ACCESS)).not.toBe(read);
  });
});
