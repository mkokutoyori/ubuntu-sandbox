/**
 * `kernel.dmesg_restrict` (kernel/printk/printk.c, check_syslog_permissions ; Ubuntu le livre a 1 par CONFIG_SECURITY_DMESG_RESTRICT, ce que
 * dit `/etc/sysctl.d/10-kernel-hardening.conf`). Releve sur la machine de reference, util-linux 2.39, sous un uid sans CAP_SYSLOG, avec la
 * valeur 1 : `dmesg`, `dmesg -T`, `dmesg --level=err` et `dmesg -c` disent « dmesg: read kernel buffer failed: Operation not permitted »,
 * `dmesg -C` « dmesg: clear kernel buffer failed: Operation not permitted », `dmesg -n 1` « dmesg: klogctl failed: Operation not
 * permitted », tous en code 1. Le simulateur laissait un utilisateur ordinaire lire le tampon (un test l'imposait : « should allow non-root
 * to use dmesg », fausse premisse) et disait « Permission denied » pour -c, -C et -n ; `/proc/sys/kernel/dmesg_restrict` n'existait pas.
 * Corrige : le reglage est un fichier de /proc/sys (defaut 1, 0 ou 1 a l'ecriture), la politique de privileges le lit par l'acteur, et
 * les trois messages sont ceux du noyau. Avec 0 le noyau laisse lire le tampon (READ_ALL) a tout le monde, mais exige toujours
 * CAP_SYSLOG pour -c, -C et -n.
 *
 * Discrimine par `git stash` sur src/network : 8 des 9 cas tombent avant. TEMOIN : root lit le tampon.
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

describe('kernel.dmesg_restrict', () => {
  it('WITNESS — root reads the ring buffer', async () => {
    expect(await lab().root('dmesg | head -1')).toContain('Linux version');
  });

  it('is 1 by default, as Ubuntu ships it', async () => {
    expect(await lab().user('cat /proc/sys/kernel/dmesg_restrict')).toBe('1');
  });

  it.each(['dmesg', 'dmesg -T', 'dmesg --level=err', 'dmesg -c'])('%s is refused to an ordinary user', async (command) => {
    expect(await lab().user(command)).toBe('dmesg: read kernel buffer failed: Operation not permitted');
  });

  it('-C and -n have their own wording', async () => {
    const { user } = lab();
    expect(await user('dmesg -C')).toBe('dmesg: clear kernel buffer failed: Operation not permitted');
    expect(await user('dmesg -n 1')).toBe('dmesg: klogctl failed: Operation not permitted');
  });

  it('0 lets an ordinary user read, and still refuses -c', async () => {
    const { user, root } = lab();
    await root('sysctl -w kernel.dmesg_restrict=0');
    expect(await user('dmesg | head -1')).toContain('Linux version');
    expect(await user('dmesg -c')).toBe('dmesg: read kernel buffer failed: Operation not permitted');
  });

  it('refuses a value other than 0 or 1', async () => {
    const { root } = lab();
    expect(await root('sysctl -w kernel.dmesg_restrict=2')).toContain('Invalid argument');
    expect(await root('cat /proc/sys/kernel/dmesg_restrict')).toBe('1');
  });
});
