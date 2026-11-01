/**
 * `kernel.printk` (Documentation/admin-guide/sysctl/kernel.rst) : quatre entiers, le premier est le niveau de la console. Ubuntu le
 * livre a « 4 4 1 7 » par /etc/sysctl.d/10-console-messages.conf (paquet procps, lu sur la machine de reference), et `dmesg -n N`
 * ecrit N dans le premier champ : releve sur la machine de reference, `dmesg -n 4` passe `/proc/sys/kernel/printk` de « 7 4 1 7 » a
 * « 4 4 1 7 ». Le simulateur n'avait NI le fichier NI la cle, et `dmesg -n` etait accepte puis ignore (regle 6) : `dmesg -n 1` rendait une
 * chaine vide sans rien changer. Corrige : la cle est un vecteur de /proc/sys (separateur tabulation, comme procps l'ecrit), `dmesg -n`
 * l'ecrit, et le fichier du paquet est livre ; `sysctl --system` le rejoue sans erreur.
 *
 * Discrimine par `git stash` sur src : 6 des 7 cas tombent avant. TEMOIN : `dmesg -n 9` reste refuse (« invalid console level »).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function lab(): (command: string) => Promise<string> {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return async (command) => String(await machine.executor.runAsUser('root', () => pc.executeCommand(command))).trim();
}

describe('kernel.printk', () => {
  it('WITNESS — dmesg -n 9 is still refused', async () => {
    expect(await lab()('dmesg -n 9')).toContain('invalid console level');
  });

  it('is 4 4 1 7 as Ubuntu ships it, tab separated', async () => {
    const run = lab();
    expect(await run('cat /proc/sys/kernel/printk')).toBe('4\t4\t1\t7');
    expect(await run('sysctl kernel.printk')).toBe('kernel.printk = 4\t4\t1\t7');
  });

  it('dmesg -n writes the console level, the other three fields stay', async () => {
    const run = lab();
    await run('dmesg -n 1');
    expect(await run('cat /proc/sys/kernel/printk')).toBe('1\t4\t1\t7');
  });

  it('sysctl -w and dmesg -n are two views of one value', async () => {
    const run = lab();
    await run('sysctl -w kernel.printk="3 4 1 3"');
    expect(await run('cat /proc/sys/kernel/printk')).toBe('3\t4\t1\t3');
    await run('dmesg -n 5');
    expect(await run('sysctl -n kernel.printk')).toBe('5\t4\t1\t3');
  });

  it('refuses a value that is not four integers', async () => {
    const run = lab();
    expect(await run('sysctl -w kernel.printk="3 4 1"')).toContain('Invalid argument');
    expect(await run('cat /proc/sys/kernel/printk')).toBe('4\t4\t1\t7');
  });

  it('ships the package file and sysctl --system replays it without error', async () => {
    const run = lab();
    expect(await run('cat /etc/sysctl.d/10-console-messages.conf')).toContain('kernel.printk = 4 4 1 7');
    const replay = await run('sysctl --system 2>&1');
    expect(replay).toContain('* Applying /etc/sysctl.d/10-console-messages.conf ...');
    expect(replay).not.toContain('cannot stat');
  });

  it('a dmesg -n level survives a sysctl --system only through the file (the file wins)', async () => {
    const run = lab();
    await run('dmesg -n 1');
    await run('sysctl --system');
    expect(await run('cat /proc/sys/kernel/printk')).toBe('4\t4\t1\t7');
  });
});
