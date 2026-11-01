/**
 * `fs.protected_hardlinks` (Ubuntu : 1, /usr/lib/sysctl.d/99-protect-links.conf) : un utilisateur ordinaire ne fait un lien physique que
 * vers un fichier dont il est proprietaire, ou qu'il peut lire ET ecrire (et qui n'est ni setuid, ni setgid executable pour le groupe)
 * (fs/namei.c : may_linkat, safe_hardlink_source). Releve sur la machine de reference, uid 65534 dans un /tmp colle :
 *   ln /etc/shadow /tmp/x  -> « ln: failed to create hard link '/tmp/x' => '/etc/shadow': Operation not permitted »
 *   ln /etc/passwd /tmp/p  -> idem (lisible, non inscriptible)
 *   ln own own2 (proprietaire) -> ok ; ln rw rw2 (root, 0666) -> ok ; ln -s /etc/shadow s -> ok
 * Le simulateur laissait n'importe qui lier /etc/shadow dans /tmp (la copie gardait root:root 0640 mais devenait un second nom d'un fichier
 * que l'utilisateur ne peut pas lire), et son message omettait le « => 'source' » que coreutils ecrit pour toute erreur de lien physique
 * autre que « File exists » (releve aussi : ENOENT sur le dossier de destination). Corrige : le reglage est un fichier de /proc/sys,
 * `ln` le lit, et le message suit coreutils.
 *
 * Discrimine par `git stash` sur src : 4 des 9 cas tombent avant. TEMOINS : un lien vers son propre fichier, un lien symbolique, root, et la valeur 0
 * (qui laisse tout passer, avant comme apres).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function lab() {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  const user = async (command: string): Promise<string> => String(await pc.executeCommand(command)).trim();
  const root = async (command: string): Promise<string> =>
    String(await machine.executor.runAsUser('root', () => pc.executeCommand(command))).trim();
  return { user, root };
}

describe('fs.protected_hardlinks', () => {
  it('WITNESS — a user links to a file of their own', async () => {
    const { user } = lab();
    expect(await user('echo a > /tmp/own; ln /tmp/own /tmp/own2; echo rc=$?')).toBe('rc=0');
  });

  it('WITNESS — a symbolic link to /etc/shadow is allowed', async () => {
    expect(await lab().user('ln -s /etc/shadow /tmp/s; echo rc=$?')).toBe('rc=0');
  });

  it('is 1 by default', async () => {
    expect(await lab().user('sysctl -n fs.protected_hardlinks')).toBe('1');
  });

  it('refuses a hard link to a file the user can neither read nor write', async () => {
    expect(await lab().user('ln /etc/shadow /tmp/x; echo rc=$?'))
      .toBe("ln: failed to create hard link '/tmp/x' => '/etc/shadow': Operation not permitted\nrc=1");
  });

  it('refuses a hard link to a file the user can only read', async () => {
    expect(await lab().user('ln /etc/passwd /tmp/p; echo rc=$?'))
      .toBe("ln: failed to create hard link '/tmp/p' => '/etc/passwd': Operation not permitted\nrc=1");
  });

  it('allows a hard link to a file the user can read and write', async () => {
    const { user, root } = lab();
    await root('echo r > /tmp/rw; chmod 666 /tmp/rw');
    expect(await user('ln /tmp/rw /tmp/rw2; echo rc=$?')).toBe('rc=0');
  });

  it('root links anything', async () => {
    expect(await lab().root('ln /etc/shadow /tmp/rootx; echo rc=$?')).toBe('rc=0');
  });

  it('0 turns the protection off', async () => {
    const { user, root } = lab();
    await root('sysctl -w fs.protected_hardlinks=0');
    expect(await user('ln /etc/shadow /tmp/x; echo rc=$?')).toBe('rc=0');
  });

  it('names the source for any failure but File exists', async () => {
    const { user } = lab();
    await user('echo a > /tmp/a; ln /tmp/a /tmp/b');
    expect(await user('ln /tmp/a /tmp/b')).toBe("ln: failed to create hard link '/tmp/b': File exists");
    expect(await user('ln /tmp/a /tmp/nodir/x')).toBe("ln: failed to create hard link '/tmp/nodir/x' => '/tmp/a': No such file or directory");
  });
});
