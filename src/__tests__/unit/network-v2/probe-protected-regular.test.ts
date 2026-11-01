/**
 * `fs.protected_regular` (Ubuntu : 2, /usr/lib/sysctl.d/99-protect-links.conf) : ouvrir avec creation (O_CREAT) un fichier ordinaire
 * qui existe deja dans un dossier collant (sticky) ouvert en ecriture est refuse quand le proprietaire du fichier n'est ni l'appelant ni
 * le proprietaire du dossier (fs/namei.c : may_create_in_sticky). La valeur 1 ne regarde que les dossiers inscriptibles par tous, la valeur 2
 * aussi ceux inscriptibles par le groupe ; root n'est pas exempte. Releve sur la machine de reference (uid 65533 cree /tmp/lnt/shared en 0666,
 * uid 65534 agit) : `>` et `>>` -> « Permission denied », `touch` et `cat` passent, un fichier de root dans un dossier de root passe, le
 * proprietaire reecrit son fichier. Le simulateur laissait n'importe qui ecraser le fichier d'un autre dans /tmp.
 *
 * `fs.protected_fifos` (Ubuntu : 1) suit la meme regle pour un FIFO (releve : uid 65534 ouvre en O_RDWR|O_CREAT le FIFO 0666 de l'uid 65533 dans
 * /tmp -> « cannot create: Permission denied », le proprietaire passe) ; chaque reglage ne gouverne que SON type d'objet, et le niveau 1 ne regarde pas
 * un dossier collant inscriptible par le groupe seulement, le niveau 2 oui (Documentation/admin-guide/sysctl/fs.rst).
 *
 * Un membre du groupe d'un dossier inscriptible par le groupe y cree un fichier (les groupes supplementaires n'atteignaient pas `writeFile`, la
 * redirection repondait rc=0 sans rien creer).
 *
 * Discrimine par `git stash` sur src contre HEAD (`protected_regular` seul, fichiers ordinaires) : 4 des 15 cas tombent (valeur par defaut de protected_fifos, les deux cas de type d'objet, le dossier groupe-inscriptible); contre la base d'avant `protected_regular`, 4 des 8 cas fichiers ordinaires tombaient. TEMOINS : le proprietaire, le
 * proprietaire du dossier, touch, la lecture, la valeur 0 (qui laisse tout passer, avant comme apres), un fichier ordinaire toujours refuse quand
 * `protected_fifos` vaut 0.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function lab() {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  const as = async (name: string, command: string): Promise<string> =>
    String(await machine.executor.runAsUser(name, () => pc.executeCommand(command))).trim();
  return { as };
}

async function twoUsers() {
  const { as } = lab();
  await as('root', 'useradd -m alice; useradd -m bob');
  await as('alice', 'echo mine > /tmp/shared; chmod 666 /tmp/shared');
  return as;
}

describe('fs.protected_regular', () => {
  it('is 2 by default', async () => {
    expect(await lab().as('alice', 'sysctl -n fs.protected_regular')).toBe('2');
  });

  it('WITNESS — the owner rewrites their own file', async () => {
    const as = await twoUsers();
    expect(await as('alice', 'echo again > /tmp/shared; echo rc=$?; cat /tmp/shared')).toBe('rc=0\nagain');
  });

  it('WITNESS — touch and read are not an O_CREAT open for writing', async () => {
    const as = await twoUsers();
    expect(await as('bob', 'touch /tmp/shared; echo rc=$?; cat /tmp/shared')).toBe('rc=0\nmine');
  });

  it('refuses another user overwriting the file', async () => {
    const as = await twoUsers();
    const out = await as('bob', 'echo x > /tmp/shared; echo rc=$?');
    expect(out).toContain('Permission denied');
    expect(await as('alice', 'cat /tmp/shared')).toBe('mine');
  });

  it('refuses another user appending to the file', async () => {
    const as = await twoUsers();
    expect(await as('bob', 'echo x >> /tmp/shared')).toContain('Permission denied');
    expect(await as('alice', 'cat /tmp/shared')).toBe('mine');
  });

  it('does not exempt root', async () => {
    const as = await twoUsers();
    expect(await as('root', 'echo x > /tmp/shared')).toContain('Permission denied');
  });

  it('WITNESS — a file owned by the directory owner is writable', async () => {
    const as = await twoUsers();
    await as('root', 'echo r > /tmp/rootfile; chmod 666 /tmp/rootfile');
    expect(await as('bob', 'echo x > /tmp/rootfile; echo rc=$?; cat /tmp/rootfile')).toBe('rc=0\nx');
  });

  it('0 turns the protection off', async () => {
    const as = await twoUsers();
    await as('root', 'sysctl -w fs.protected_regular=0');
    expect(await as('bob', 'echo x > /tmp/shared; echo rc=$?; cat /tmp/shared')).toBe('rc=0\nx');
  });
});

describe('fs.protected_fifos', () => {
  async function fifoLab() {
    const { as } = lab();
    await as('root', 'useradd -m alice; useradd -m bob');
    await as('alice', 'mkfifo /tmp/pipe; chmod 666 /tmp/pipe');
    return as;
  }

  it('is 1 by default', async () => {
    expect(await lab().as('alice', 'sysctl -n fs.protected_fifos')).toBe('1');
  });

  it('WITNESS — the owner opens their own fifo', async () => {
    const as = await fifoLab();
    expect(await as('alice', 'echo hi > /tmp/pipe; echo rc=$?')).toBe('rc=0');
  });

  it('refuses another user opening the fifo with O_CREAT', async () => {
    const as = await fifoLab();
    expect(await as('bob', 'echo hi > /tmp/pipe; echo rc=$?')).toContain('Permission denied');
  });

  it('protected_fifos=0 frees the fifo while protected_regular stays at 2', async () => {
    const as = await fifoLab();
    await as('root', 'sysctl -w fs.protected_fifos=0');
    expect(await as('bob', 'echo hi > /tmp/pipe; echo rc=$?')).toBe('rc=0');
  });

  it('protected_regular=0 does not free the fifo', async () => {
    const as = await fifoLab();
    await as('root', 'sysctl -w fs.protected_regular=0');
    expect(await as('bob', 'echo hi > /tmp/pipe; echo rc=$?')).toContain('Permission denied');
  });

  it('WITNESS — protected_fifos=0 leaves a regular file protected', async () => {
    const as = await twoUsers();
    await as('root', 'sysctl -w fs.protected_fifos=0');
    expect(await as('bob', 'echo x > /tmp/shared')).toContain('Permission denied');
  });

  it('level 1 ignores a group-writable sticky directory, level 2 does not', async () => {
    const { as } = lab();
    await as('root', 'groupadd team; usermod -aG team alice; usermod -aG team bob');
    await as('root', 'mkdir /tmp/g; chgrp team /tmp/g; chmod 1775 /tmp/g');
    await as('alice', 'echo mine > /tmp/g/f; chmod 666 /tmp/g/f; mkfifo /tmp/g/p; chmod 666 /tmp/g/p');
    expect(await as('alice', 'cat /tmp/g/f')).toBe('mine');
    expect(await as('bob', 'echo x > /tmp/g/p; echo rc=$?')).toBe('rc=0');
    expect(await as('bob', 'echo x > /tmp/g/f; echo rc=$?')).toContain('Permission denied');
  });
});
