/**
 * `fs.protected_regular` (Ubuntu : 2, /usr/lib/sysctl.d/99-protect-links.conf) : ouvrir avec creation (O_CREAT) un fichier ordinaire
 * qui existe deja dans un dossier collant (sticky) ouvert en ecriture est refuse quand le proprietaire du fichier n'est ni l'appelant ni
 * le proprietaire du dossier (fs/namei.c : may_create_in_sticky). La valeur 1 ne regarde que les dossiers inscriptibles par tous, la valeur 2
 * aussi ceux inscriptibles par le groupe ; root n'est pas exempte. Releve sur la machine de reference (uid 65533 cree /tmp/lnt/shared en 0666,
 * uid 65534 agit) : `>` et `>>` -> « Permission denied », `touch` et `cat` passent, un fichier de root dans un dossier de root passe, le
 * proprietaire reecrit son fichier. Le simulateur laissait n'importe qui ecraser le fichier d'un autre dans /tmp.
 *
 * Discrimine par `git stash` sur src : 4 des 8 cas tombent avant. TEMOINS : le proprietaire, le proprietaire du dossier, touch, la lecture,
 * et la valeur 0 (qui laisse tout passer, avant comme apres).
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
