/**
 * Probes — les quatorze utilitaires de flux de texte.
 *
 * `tac`, `nl`, `paste`, `comm`, `fold`, `expand`, `unexpand`, `fmt`,
 * `pr`, `column`, `cmp`, `split`, `base64`, `cksum` : tous répondaient
 * `command not found`, et les transcripts de debug les réclamaient une
 * trentaine de fois par fichier.
 *
 * Les sorties attendues ici ne sont pas déduites d'une lecture des pages
 * de manuel : elles ont été relevées sur les vrais coreutils GNU, sur la
 * même entrée, avec `cat -A` pour voir les tabulations. C'est pourquoi
 * `cmp` dit « char » et non « byte », pourquoi `pr -n` sépare par une
 * tabulation et non par des espaces, et pourquoi `fold -s` laisse
 * l'espace de coupure en fin de ligne.
 *
 * `column` fait exception et n'a pas pu être comparé : il n'appartient
 * pas aux coreutils et n'était pas installé sur la machine de mesure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function lab(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  await pc.executeCommand('printf "un\\ndeux\\ntrois\\n" > a.txt');
  await pc.executeCommand('printf "beta\\ndelta\\nun\\n" > b.txt');
  await pc.executeCommand('printf "nom:age\\nalice:30\\nbob:7\\n" > c.txt');
  return pc;
}

describe('Scénario 1 — lire un fichier ou lire le tuyau', () => {
  it('`tac` renverse, des deux côtés', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('tac a.txt')).toBe('trois\ndeux\nun');
    expect(await pc.executeCommand('printf "un\\ndeux\\n" | tac')).toBe('deux\nun');
  });

  it('`nl` numérote sur six colonnes suivies d\'une tabulation', async () => {
    const pc = await lab();
    // Relevé réel : `     1<TAB>un`.
    expect(await pc.executeCommand('nl a.txt')).toBe('     1\tun\n     2\tdeux\n     3\ttrois');
  });

  it('`cksum` donne le CRC POSIX, pas celui de zlib', async () => {
    const pc = await lab();
    // `cksum` réel sur ces 14 octets : 3233290692 14.
    expect(await pc.executeCommand('cksum a.txt')).toBe('3233290692 14 a.txt');
    // Sans fichier nommé, le vrai cksum n'imprime pas de nom.
    expect(await pc.executeCommand('printf "un\\ndeux\\ntrois\\n" | cksum')).toBe('3233290692 14');
  });

  it('`base64` encode avec le saut de ligne final, et décode en retour', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('printf "abc\\n" | base64')).toBe('YWJjCg==');
    expect(await pc.executeCommand('printf "YWJjCg==\\n" | base64 -d')).toBe('abc');
  });
});

describe('Scénario 2 — mettre côte à côte et comparer', () => {
  it('`paste` colonne, et `-s` met un fichier par ligne', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('paste a.txt b.txt')).toBe('un\tbeta\ndeux\tdelta\ntrois\tun');
    expect(await pc.executeCommand('paste -sd+ a.txt')).toBe('un+deux+trois');
  });

  it('`comm` décale chaque colonne conservée d\'une tabulation', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('comm a.txt b.txt')).toBe('\tbeta\n\tdelta\n\t\tun\ndeux\ntrois');
    expect(await pc.executeCommand('comm -12 a.txt b.txt')).toBe('un');
  });

  it('`cmp` se tait sur l\'identité et nomme le premier caractère différent', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('cmp a.txt a.txt; echo "rc=$?"')).toBe('rc=0');
    // Le vrai cmp dit « char », pas « byte ».
    expect(await pc.executeCommand('cmp a.txt b.txt')).toBe('a.txt b.txt differ: char 1, line 1');
  });
});

describe('Scénario 3 — mettre en forme', () => {
  it('`fold` coupe à la largeur, et `-s` coupe au dernier blanc', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('printf "aaaaaaaaaa\\n" | fold -w 4')).toBe('aaaa\naaaa\naa');
    // Relevé réel : l'espace de coupure reste en fin de ligne.
    expect(await pc.executeCommand('printf "un deux trois quatre\\n" | fold -sw 9'))
      .toBe('un deux \ntrois \nquatre');
  });

  it('`expand` et `unexpand` se répondent', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('printf "a\\tb\\n" | expand -t 4')).toBe('a   b');
    expect(await pc.executeCommand('printf "        x\\n" | unexpand -t 4')).toBe('\t\tx');
  });

  it('`fmt` recompose le paragraphe à la largeur demandée', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('printf "un deux trois quatre cinq\\n" | fmt -w 10'))
      .toBe('un deux\ntrois\nquatre\ncinq');
  });

  it('`pr -tn` numérote avec une tabulation, comme le vrai', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('pr -tn a.txt')).toBe('    1\tun\n    2\tdeux\n    3\ttrois');
  });

  it('`column -t` aligne les colonnes du séparateur demandé', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('column -t -s: c.txt')).toBe('nom    age\nalice  30\nbob    7');
  });
});

describe('Scénario 4 — les options agglutinées, et les découpes qui écrivent', () => {
  it('`-sw 9` vaut `-s -w 9`, comme le fait getopt', async () => {
    const pc = await lab();
    // Avant l'expansion des agglutinats, `fold -sw 9` cherchait un
    // fichier nommé « 9 ».
    const groupe = await pc.executeCommand('printf "un deux trois quatre\\n" | fold -sw 9');
    const separe = await pc.executeCommand('printf "un deux trois quatre\\n" | fold -s -w 9');
    expect(groupe).toBe(separe);
    expect(groupe).not.toContain('No such file');
  });

  it('un caractère inconnu fait renoncer plutôt que mal découper', async () => {
    const pc = await lab();
    // `-10` est une largeur pour fmt, pas les drapeaux `-1` et `-0`.
    expect(await pc.executeCommand('printf "un deux trois quatre cinq\\n" | fmt -10'))
      .toBe('un deux\ntrois\nquatre\ncinq');
  });

  it('`split` écrit réellement ses morceaux sur le disque', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('split -l 2 a.txt part-')).toBe('');
    expect(await pc.executeCommand('ls')).toContain('part-aa');
    expect(await pc.executeCommand('cat part-aa')).toBe('un\ndeux');
    expect(await pc.executeCommand('cat part-ab')).toBe('trois');
  });
});

describe('Scénario 5 — les refus et la documentation', () => {
  it('un fichier absent rend le message du coreutil, nommé', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('tac absent.txt')).toBe('tac: absent.txt: No such file or directory');
    expect(await pc.executeCommand('nl absent.txt')).toBe('nl: absent.txt: No such file or directory');
  });

  it('`cmp` sort en 2 sur une erreur, en 1 sur une différence', async () => {
    const pc = await lab();
    // La distinction POSIX : 2 = « je n'ai pas pu comparer ».
    expect(await pc.executeCommand('cmp absent.txt a.txt; echo "rc=$?"')).toContain('rc=2');
    expect(await pc.executeCommand('cmp a.txt b.txt > /dev/null; echo "rc=$?"')).toContain('rc=1');
  });

  it('chaque commande porte sa page de manuel et son aide', async () => {
    const pc = await lab();
    const man = await pc.executeCommand('man tac');
    expect(man).toContain('TAC(1)');
    expect(man).toContain('tac [FILE]...');
    const help = await pc.executeCommand('nl --help');
    expect(help).toContain('Usage: nl');
    expect(help).toContain('-b STYLE');
  });
});
