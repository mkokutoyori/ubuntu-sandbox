/**
 * Scénario 2 — Cycle de vie d'un processus : fork, exec, signal, états.
 *
 * Valide fork/exec via `cmd &`, les transitions d'état (S/T/Z), la
 * livraison de signaux (HUP/TERM/KILL/USR1) y compris via `trap`, et la
 * cohérence de `nice`/`renice` avec `ps` et `/proc`. Chaque test pilote
 * une vraie `LinuxServer` via `executeCommand`, comme un opérateur réel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 2 — cycle de vie des processus', () => {
  let srv: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  async function lastBgPid(): Promise<string> {
    return (await run('echo $!')).trim();
  }

  async function isGone(pid: string): Promise<boolean> {
    return (await run(`cat /proc/${pid}/status`)).includes('No such file');
  }

  describe('création et observation fork/exec', () => {
    it('sleep 60 & crée un fils avec un PPID cohérent dans /proc', async () => {
      await run('sleep 60 &');
      const pid = await lastBgPid();
      const status = await run(`cat /proc/${pid}/status`);
      expect(status).toMatch(/^State:\tS/m);
      const ppid = /^PPid:\t(\d+)/m.exec(status)?.[1];
      expect(ppid).toBeDefined();
      expect(Number(ppid)).toBeGreaterThan(0);
    });

    it('le fils apparaît dans ps -eo pid,ppid,stat,comm', async () => {
      await run('sleep 60 &');
      const pid = await lastBgPid();
      const out = await run('ps -eo pid,ppid,stat,comm');
      const line = out.split('\n').find((l) => l.trim().split(/\s+/)[0] === pid);
      expect(line).toBeDefined();
      expect(line).toMatch(/sleep/);
    });
  });

  describe('états de processus et transitions', () => {
    it('SIGSTOP → T, SIGCONT → S', async () => {
      await run('sleep 300 &');
      const pid = await lastBgPid();

      expect((await run(`cat /proc/${pid}/status`))).toMatch(/^State:\tS/m);

      await run(`kill -STOP ${pid}`);
      expect((await run(`cat /proc/${pid}/status`))).toMatch(/^State:\tT/m);
      expect((await run(`ps -p ${pid} -o stat=`)).trim()).toBe('T');

      await run(`kill -CONT ${pid}`);
      expect((await run(`cat /proc/${pid}/status`))).toMatch(/^State:\tS/m);
      expect((await run(`ps -p ${pid} -o stat=`)).trim()).toBe('S');
    });

    it('un job terminé sans wait() reste zombie jusqu\'à la commande suivante', async () => {
      const pid = (await run('sleep 0 & echo $!')).trim();

      const psAfterOne = await run('ps -eo pid,stat,comm');
      const zombieLine = psAfterOne.split('\n').find((l) => l.trim().split(/\s+/)[0] === pid);
      expect(zombieLine).toBeDefined();
      expect(zombieLine!.trim().split(/\s+/)[1]).toBe('Z');

      await run('true'); // one more prompt cycle — the shell "notices" and reaps
      expect(await isGone(pid)).toBe(true);
    });
  });

  describe('signaux fondamentaux', () => {
    it('SIGHUP termine un processus sans trap', async () => {
      await run('sleep 300 &');
      const pid = await lastBgPid();
      await run(`kill -1 ${pid}`);
      expect(await isGone(pid)).toBe(true);
    });

    it('SIGTERM termine proprement un processus sans trap', async () => {
      await run('sleep 300 &');
      const pid = await lastBgPid();
      await run(`kill -15 ${pid}`);
      expect(await isGone(pid)).toBe(true);
    });

    it('SIGKILL termine un processus de force', async () => {
      await run('sleep 300 &');
      const pid = await lastBgPid();
      await run(`kill -9 ${pid}`);
      expect(await isGone(pid)).toBe(true);
    });

    it('un trap SIGUSR1 s\'exécute réellement sur un job d\'arrière-plan bloqué', async () => {
      await run(
        "bash -c 'trap \"echo got-usr1 > /tmp/usr1.marker\" USR1; while true; do sleep 1; done' &",
      );
      const pid = await lastBgPid();
      expect((await run(`ps -p ${pid} -o stat=`)).trim()).toMatch(/^S/);

      await run(`kill -USR1 ${pid}`);

      expect((await run('cat /tmp/usr1.marker')).trim()).toBe('got-usr1');
      // the trap ran but didn't exit — the process is still alive
      expect((await run(`ps -p ${pid} -o stat=`)).trim()).toMatch(/^S/);
    });

    it('un trap SIGTERM avec exit termine réellement le processus après le nettoyage', async () => {
      await run(
        "bash -c 'trap \"echo cleaned > /tmp/term.marker; exit 0\" TERM; while true; do sleep 1; done' &",
      );
      const pid = await lastBgPid();

      await run(`kill -TERM ${pid}`);

      expect((await run('cat /tmp/term.marker')).trim()).toBe('cleaned');
      expect(await isGone(pid)).toBe(true);
    });
  });

  describe('priorité nice et renice', () => {
    it('nice -n 19 sleep 300 & applique la priorité et exécute réellement la commande', async () => {
      await run('nice -n 19 sleep 300 &');
      const pid = await lastBgPid();

      const out = await run(`ps -p ${pid} -o pid,ni,pri,comm`);
      const cols = out.split('\n')[1].trim().split(/\s+/);
      expect(cols[1]).toBe('19');
      expect(cols[3]).toBe('sleep');

      // the wrapped command actually ran — a real process entry exists
      expect((await run(`cat /proc/${pid}/status`))).toMatch(/^Name:\tsleep/m);
    });

    it('renice reste cohérent entre ps -o ni, pri et /proc/<pid>/sched', async () => {
      await run('sleep 300 &');
      const pid = await lastBgPid();

      await run(`renice -n 5 -p ${pid}`);

      const psOut = await run(`ps -p ${pid} -o ni,pri`);
      const [ni, pri] = psOut.split('\n')[1].trim().split(/\s+/);
      expect(ni).toBe('5');
      expect(pri).toBe('25');

      const sched = await run(`cat /proc/${pid}/sched`);
      expect(sched).toMatch(/prio\s*:\s*125/);
    });
  });
});
