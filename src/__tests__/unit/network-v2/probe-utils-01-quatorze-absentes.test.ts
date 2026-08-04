/**
 * Sondes — les quatorze utilitaires que la machine n'avait pas.
 *
 * Priorité 6 de `docs/audit/11-transcripts-debug-2026-08.md` : `tree`,
 * `cal`, `getconf`, `lsmod`, `modinfo`, `swapon`, `lsb_release`,
 * `sensors`, `logname`, `users`, `lid`, `members`, `pmap`, `yes` —
 * toutes répondaient `command not found`.
 *
 * Les valeurs attendues ici sont **relevées sur les vrais binaires**
 * installés dans le conteneur (tree v2.1.1, ncal, coreutils, util-linux,
 * lm-sensors, glibc — Ubuntu 24.04), pas déduites d'une documentation :
 *
 *     $ tree demo            → « 4 directories, 4 files » (la racine compte)
 *     $ tree -L 1 demo       → « 3 directories, 1 file » (le décompte porte
 *                              sur ce qui a été LISTÉ, pas parcouru)
 *     $ tree /nope           → « /nope  [error opening dir] », sortie 2
 *     $ cal 2 2026           → quatre semaines pleines PUIS DEUX LIGNES
 *                              BLANCHES : le corps fait toujours six
 *                              semaines
 *     $ cal 2026             → l'année centrée sur la somme des grilles
 *                              seules (28 espaces), séparateurs exclus
 *     $ cal 13 2026          → « 13 is neither a month number… », sortie 64
 *     $ getconf ZZZ          → « Unrecognized variable `ZZZ' », sortie 2
 *     $ lsb_release -cs      → « noble » (option courte GROUPÉE : -c -s)
 *     $ sensors              → « No sensors found! », sortie 0
 *     $ logname (sans utmp)  → « logname: no login name », sortie 1
 *     $ users (sans session) → rien, sortie 0
 *     $ yes | head -3        → y y y
 *     $ pmap <pid inconnu>   → rien, sortie 42
 *
 * Deux propriétés valent plus que la mise en forme et sont vérifiées
 * comme telles : `getconf _NPROCESSORS_ONLN` doit dire la même chose que
 * `nproc` (même source matérielle), et `lsmod` doit dire la même chose
 * que `/proc/modules` (le fichier est la source, la commande le lecteur).
 * Deux vues qui divergent sont pires qu'une vue fausse : plus rien ne
 * permet de diagnostiquer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function pc(): LinuxPC {
  const m = new LinuxPC('linux-pc', 'pc1', 0, 0);
  m.powerOn();
  return m;
}

function server(): LinuxServer {
  const m = new LinuxServer('linux-server', 'srv1', 0, 0);
  m.powerOn();
  return m;
}

async function seedTree(m: LinuxPC): Promise<void> {
  await m.executeCommand('mkdir -p /tmp/demo/a/b /tmp/demo/c');
  await m.executeCommand('touch /tmp/demo/a/f1.txt /tmp/demo/a/b/f2.txt '
    + '/tmp/demo/c/f3.log /tmp/demo/top.md');
}

describe('Scénario 1 — `tree` dessine l\'arborescence du VFS', () => {
  it('la forme complète, avec les branches ASCII du vrai binaire', async () => {
    const m = pc();
    await seedTree(m);
    expect(await m.executeCommand('tree /tmp/demo')).toBe([
      '/tmp/demo',
      '|-- a',
      '|   |-- b',
      '|   |   `-- f2.txt',
      '|   `-- f1.txt',
      '|-- c',
      '|   `-- f3.log',
      '`-- top.md',
      '',
      '4 directories, 4 files',
    ].join('\n'));
  });

  it('`-L 1` compte ce qui est listé, pas ce qui est parcouru', async () => {
    const m = pc();
    await seedTree(m);
    const out = await m.executeCommand('tree -L 1 /tmp/demo');
    expect(out).toContain('`-- top.md');
    expect(out).not.toContain('f1.txt');
    expect(out.trim().endsWith('3 directories, 1 file')).toBe(true);
  });

  it('`-d` ne montre que les répertoires et n\'annonce que leur nombre', async () => {
    const m = pc();
    await seedTree(m);
    const out = await m.executeCommand('tree -d /tmp/demo');
    expect(out).not.toContain('f1.txt');
    expect(out.trim().endsWith('4 directories')).toBe(true);
  });

  it('`-f` préfixe chaque entrée de son chemin complet', async () => {
    const m = pc();
    await seedTree(m);
    expect(await m.executeCommand('tree -f /tmp/demo'))
      .toContain('|   |   `-- /tmp/demo/a/b/f2.txt');
  });

  it('`--noreport` supprime le décompte final', async () => {
    const m = pc();
    await seedTree(m);
    const out = await m.executeCommand('tree --noreport /tmp/demo');
    expect(out).not.toContain('directories');
    expect(out.trim().endsWith('`-- top.md')).toBe(true);
  });

  it('un répertoire absent se signale sur sa propre ligne', async () => {
    const m = pc();
    expect(await m.executeCommand('tree /nope')).toContain('/nope  [error opening dir]');
  });
});

describe('Scénario 2 — `cal` rend la grille du vrai binaire', () => {
  it('un mois : titre centré, en-tête des jours, deux espaces de queue', async () => {
    const m = pc();
    expect(await m.executeCommand('cal 8 2026')).toBe([
      '    August 2026       ',
      'Su Mo Tu We Th Fr Sa  ',
      '                   1  ',
      ' 2  3  4  5  6  7  8  ',
      ' 9 10 11 12 13 14 15  ',
      '16 17 18 19 20 21 22  ',
      '23 24 25 26 27 28 29  ',
      '30 31                 ',
    ].join('\n'));
  });

  it('le corps fait TOUJOURS six semaines, complétées de lignes blanches', async () => {
    const m = pc();
    const lignes = (await m.executeCommand('cal 2 2026')).split('\n');
    expect(lignes).toHaveLength(8);
    expect(lignes[5]).toBe('22 23 24 25 26 27 28  ');
    expect(lignes[6]).toBe(' '.repeat(22));
    expect(lignes[7]).toBe(' '.repeat(22));
  });

  it('une année seule centre l\'année sur les grilles, séparateurs exclus', async () => {
    const m = pc();
    const lignes = (await m.executeCommand('cal 2026')).split('\n');
    expect(lignes[0]).toBe(`${' '.repeat(28)}2026`);
    expect(lignes[2]).toContain('January');
    expect(lignes[2]).toContain('March');
  });

  it('`-3` met trois mois en bande autour de celui demandé', async () => {
    const m = pc();
    const lignes = (await m.executeCommand('cal -3 8 2026')).split('\n');
    expect(lignes[1]).toContain('July');
    expect(lignes[1]).toContain('August');
    expect(lignes[1]).toContain('September');
  });

  it('un mois hors bornes est refusé dans les mots de cal', async () => {
    const m = pc();
    expect(await m.executeCommand('cal 13 2026'))
      .toBe('cal: 13 is neither a month number (1..12) nor a name');
  });
});

describe('Scénario 3 — `getconf` lit le matériel, pas une table figée', () => {
  it('`_NPROCESSORS_ONLN` dit exactement ce que dit `nproc`', async () => {
    const m = pc();
    expect(await m.executeCommand('getconf _NPROCESSORS_ONLN'))
      .toBe(await m.executeCommand('nproc'));
  });

  it('les constantes glibc sont celles relevées', async () => {
    const m = pc();
    expect(await m.executeCommand('getconf LONG_BIT')).toBe('64');
    expect(await m.executeCommand('getconf PATH_MAX')).toBe('4096');
    expect(await m.executeCommand('getconf ARG_MAX')).toBe('2097152');
  });

  it('une variable inconnue est signalée, jamais devinée', async () => {
    const m = pc();
    expect(await m.executeCommand('getconf ZZZ'))
      .toBe('getconf: Unrecognized variable `ZZZ\'');
  });

  it('`-a` liste les noms avec leurs valeurs', async () => {
    const m = pc();
    const out = await m.executeCommand('getconf -a');
    expect(out).toContain('ARG_MAX');
    expect(out).toContain('PAGESIZE');
  });
});

describe('Scénario 4 — `lsb_release` lit les fichiers de la machine', () => {
  it('`-a` rend les quatre champs, séparés par une TABULATION', async () => {
    const m = pc();
    const out = await m.executeCommand('lsb_release -a');
    expect(out).toContain('Distributor ID:\tUbuntu');
    expect(out).toContain('Release:\t22.04');
    expect(out).toContain('Codename:\tjammy');
  });

  it('les options courtes groupées sont éclatées : `-cs` vaut `-c -s`', async () => {
    const m = pc();
    expect(await m.executeCommand('lsb_release -cs')).toBe('jammy');
    expect(await m.executeCommand('lsb_release -rs')).toBe('22.04');
    expect(await m.executeCommand('lsb_release -ds')).toBe('Ubuntu 22.04.4 LTS');
  });

  it('supprimer /etc/lsb-release laisse /etc/os-release répondre', async () => {
    const m = pc();
    await m.executeCommand('sudo rm /etc/lsb-release');
    expect(await m.executeCommand('lsb_release -is')).toBe('Ubuntu');
    expect(await m.executeCommand('lsb_release -cs')).toBe('jammy');
  });
});

describe('Scénario 5 — `swapon` lit le swap que `free` affiche déjà', () => {
  it('`--show` et `free` s\'accordent sur la taille', async () => {
    const m = pc();
    const show = await m.executeCommand('swapon --show');
    expect(show).toContain('NAME       TYPE      SIZE USED PRIO');
    expect(show).toContain('/swapfile');
    const somme = await m.executeCommand('swapon -s');
    const total = somme.split('\n')[1].split(/\s+/)[2];
    expect(await m.executeCommand('free -k')).toContain(total);
  });

  it('activer un espace est refusé plutôt que feint', async () => {
    const m = pc();
    expect(await m.executeCommand('swapon /swapfile'))
      .toContain('swap areas cannot be activated on this system');
  });
});

describe('Scénario 6 — `lsmod` et `modinfo` lisent une vraie table', () => {
  it('`lsmod` et `/proc/modules` ne peuvent pas diverger', async () => {
    const m = pc();
    const proc = (await m.executeCommand('cat /proc/modules')).trim().split('\n');
    const lsmod = (await m.executeCommand('lsmod')).split('\n').slice(1);
    expect(lsmod).toHaveLength(proc.length);
    for (let i = 0; i < proc.length; i++) {
      expect(lsmod[i].split(/\s+/)[0]).toBe(proc[i].split(' ')[0]);
    }
  });

  it('« Used by » est l\'inverse des dépendances, jamais une donnée à part', async () => {
    const m = pc();
    const lsmod = await m.executeCommand('lsmod');
    const jbd2 = lsmod.split('\n').find((l) => l.startsWith('jbd2'));
    expect(jbd2).toContain('1 ext4');
    const depends = await m.executeCommand('modinfo -F depends ext4');
    expect(depends).toContain('jbd2');
  });

  it('le pilote listé est celui de la carte réseau de la machine', async () => {
    const m = pc();
    expect(await m.executeCommand('lsmod')).toContain('e1000');
  });

  it('`modinfo` rend les champs du vrai binaire', async () => {
    const m = pc();
    const out = await m.executeCommand('modinfo ext4');
    expect(out).toContain('filename:       /lib/modules/');
    expect(out).toContain('description:    Fourth Extended Filesystem');
    expect(out).toContain('license:        GPL');
    expect(await m.executeCommand('modinfo -F license ext4')).toBe('GPL');
  });

  it('un module absent est signalé, pas inventé', async () => {
    const m = pc();
    expect(await m.executeCommand('modinfo nosuchmod'))
      .toBe('modinfo: ERROR: Module nosuchmod not found.');
  });
});

describe('Scénario 7 — `sensors` dit la vérité sur un matériel sans sonde', () => {
  it('sans hwmon, la réponse est celle du vrai binaire', async () => {
    const m = pc();
    expect(await m.executeCommand('sensors')).toBe([
      'No sensors found!',
      'Make sure you loaded all the kernel drivers you need.',
      'Try sensors-detect to find out which these are.',
    ].join('\n'));
  });
});

describe('Scénario 8 — `logname` et `users` répondent à deux questions', () => {
  it('`logname` rend le nom de connexion, `whoami` l\'identité courante', async () => {
    const m = pc();
    expect(await m.executeCommand('logname')).toBe('user');
    expect(await m.executeCommand('whoami')).toBe('user');
  });

  it('`logname` survit à `sudo su`, contrairement à `whoami`', async () => {
    const m = pc();
    await m.executeCommand('sudo su -');
    expect(await m.executeCommand('whoami')).toBe('root');
    expect(await m.executeCommand('logname')).toBe('user');
  });

  it('`users` nomme les sessions ouvertes, comme `who`', async () => {
    const m = pc();
    const noms = (await m.executeCommand('users')).split(' ').filter(Boolean);
    const lignes = (await m.executeCommand('who')).split('\n').filter(Boolean);
    expect(noms).toHaveLength(lignes.length);
    expect(noms[0]).toBe(lignes[0].split(/\s+/)[0]);
  });
});

describe('Scénario 9 — `lid` et `members` répondent dans l\'autre sens', () => {
  it('`lid -g` liste les membres, `groups` l\'appartenance inverse', async () => {
    const m = server();
    const membres = await m.executeCommand('lid -g sudo');
    expect(membres).toContain('alice(1000)');
    expect(await m.executeCommand('groups alice')).toContain('sudo');
  });

  it('`lid <user>` liste les groupes avec leur gid', async () => {
    const m = server();
    expect(await m.executeCommand('lid root')).toContain('root(0)');
  });

  it('`lid` demande root, comme le vrai binaire', async () => {
    const m = pc();
    expect(await m.executeCommand('lid alice'))
      .toBe('lid: Error looking up the user or group: Permission denied');
  });

  it('`members` rend la même liste, sur une ligne', async () => {
    const m = server();
    const membres = (await m.executeCommand('members sudo')).split(' ').filter(Boolean);
    const parLid = (await m.executeCommand('lid -g sudo')).split('\n')
      .map((l) => l.trim().replace(/\(\d+\)$/, '')).filter(Boolean);
    expect(membres).toEqual(parLid);
  });

  it('un groupe inconnu est refusé, pas rendu vide', async () => {
    const m = server();
    expect(await m.executeCommand('members nosuchgroup'))
      .toBe('members: Group nosuchgroup does not exist.');
  });
});

describe('Scénario 10 — `pmap` totalise ce que `ps` annonce', () => {
  it('le total est EXACTEMENT le vsize du processus', async () => {
    const m = pc();
    const ps = (await m.executeCommand('ps -o pid,vsz,comm')).split('\n')[1].trim().split(/\s+/);
    const pid = ps[0];
    const vsz = ps[1];
    const out = await m.executeCommand(`pmap ${pid}`);
    expect(out.split('\n')[0]).toContain(`${pid}:`);
    // La ligne de total est alignée (` total %16ldK`, relevé sur procps) ;
    // ce qui est vérifié ici c'est l'ÉGALITÉ des deux chiffres, pas le
    // remplissage, d'où la comparaison sur les blancs normalisés.
    expect(out.trim().split('\n').pop()!.trim().replace(/\s+/g, ' ')).toBe(`total ${vsz}K`);
  });

  it('la somme des régions vaut le total annoncé', async () => {
    const m = pc();
    const pid = (await m.executeCommand('ps -o pid,vsz,comm')).split('\n')[1].trim().split(/\s+/)[0];
    const lignes = (await m.executeCommand(`pmap ${pid}`)).split('\n');
    const regions = lignes.slice(1, -1)
      .map((l) => parseInt(l.trim().split(/\s+/)[1].replace('K', ''), 10));
    const total = parseInt(lignes[lignes.length - 1].trim().split(/\s+/)[1].replace('K', ''), 10);
    expect(regions.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('un PID inconnu ne rend rien', async () => {
    const m = pc();
    expect(await m.executeCommand('pmap 999999')).toBe('');
  });
});

describe('Scénario 11 — `yes` alimente un tube qui, lui, est séquentiel', () => {
  it('`yes | head -3` rend trois `y`', async () => {
    const m = pc();
    expect(await m.executeCommand('yes | head -3')).toBe('y\ny\ny');
  });

  it('un opérande remplace `y`, plusieurs sont joints par un espace', async () => {
    const m = pc();
    expect(await m.executeCommand('yes hello | head -2')).toBe('hello\nhello');
    expect(await m.executeCommand('yes a b | head -1')).toBe('a b');
  });

  it('le flux est borné, et la borne est celle écrite dans la commande', async () => {
    const m = pc();
    expect(await m.executeCommand('yes | wc -l')).toBe('10000');
  });
});

describe('Scénario 12 — `which` et le dispatch s\'accordent', () => {
  it('les quatorze noms se résolvent, et les outils d\'admin dans sbin', async () => {
    const m = pc();
    const out = await m.executeCommand('which tree cal getconf lsb_release swapon '
      + 'lsmod modinfo pmap sensors logname users lid members yes');
    const chemins = out.split('\n').filter(Boolean);
    expect(chemins).toHaveLength(14);
    expect(chemins).toContain('/usr/sbin/lsmod');
    expect(chemins).toContain('/usr/sbin/swapon');
    expect(chemins).toContain('/usr/sbin/lid');
    expect(chemins).toContain('/usr/bin/tree');
  });
});
