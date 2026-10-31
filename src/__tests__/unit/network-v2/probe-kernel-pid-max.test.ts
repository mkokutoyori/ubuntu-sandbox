/**
 * `/proc/sys/kernel/pid_max` (kernel/pid.c, sysctl kernel.pid_max : entier compris entre RESERVED_PIDS + 1 = 301 et
 * PID_MAX_LIMIT = 4194304 sur 64 bits, defaut 4194304 sur Ubuntu 24.04) borne l'allocation des pids, qui reprend a 300
 * au-dela, et `ps` en tire la largeur de sa colonne PID. Le simulateur gardait la valeur dans la constante PID_MAX et
 * n'avait AUCUN fichier : `cat /proc/sys/kernel/pid_max` et `sysctl kernel.pid_max` repondaient « No such file » alors que
 * `ps` calculait deja sa largeur dessus (TODO.md [ps]). Corrige : le gestionnaire de processus porte la valeur courante,
 * le fichier la lit et l'ecrit (valeur hors bornes refusee), l'allocation et `ps` la suivent.
 *
 * Discrimine par `git stash` sur src/network : 5 des 6 cas tombent avant. TEMOIN : un processus a un pid numerique (`$$`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<(command: string) => Promise<string>> {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return async (command) => String(await machine.executor.runAsUser('root', () => pc.executeCommand(command))).trim();
}

describe('kernel.pid_max', () => {
  it('WITNESS — a process has a numeric pid', async () => {
    const run = await lab();
    expect(await run('echo $$')).toMatch(/^\d+$/);
  });

  it('reads 4194304 by default, by file and by sysctl', async () => {
    const run = await lab();
    expect(await run('cat /proc/sys/kernel/pid_max')).toBe('4194304');
    expect(await run('sysctl kernel.pid_max')).toBe('kernel.pid_max = 4194304');
  });

  it('is writable', async () => {
    const run = await lab();
    expect(await run('sysctl -w kernel.pid_max=32768')).toBe('kernel.pid_max = 32768');
    expect(await run('cat /proc/sys/kernel/pid_max')).toBe('32768');
  });

  it('refuses a value outside 301..4194304 and keeps the old one', async () => {
    const run = await lab();
    await run('sysctl -w kernel.pid_max=32768');
    expect(await run('sysctl -w kernel.pid_max=300')).toContain('Invalid argument');
    expect(await run('sysctl -w kernel.pid_max=4194305')).toContain('Invalid argument');
    expect(await run('cat /proc/sys/kernel/pid_max')).toBe('32768');
  });

  it('allocation wraps below the new maximum', async () => {
    const run = await lab();
    await run('sysctl -w kernel.pid_max=301');
    await run('for i in $(seq 400); do sleep 0 & wait; done >/dev/null');
    const lines = (await run('sleep 300 & echo $!')).split('\n');
    expect(Number(lines[lines.length - 1])).toBeLessThanOrEqual(301);
  });

  it('the ps PID column is as wide as the maximum has digits', async () => {
    const run = await lab();
    expect(await run("ps -o pid -p 1 | sed -n 1p | sed 's/^/>/'")).toBe('>    PID');
    await run('sysctl -w kernel.pid_max=32768');
    expect(await run("ps -o pid -p 1 | sed -n 1p | sed 's/^/>/'")).toBe('>  PID');
  });
});
