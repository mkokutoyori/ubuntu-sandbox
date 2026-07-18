/**
 * Scénario 3 — Processus orphelins et adoption par PID 1.
 *
 * Valide que, lorsqu'un processus père se termine avant son fils, le fils
 * orphelin est immédiatement re-parenté à PID 1 (systemd) — observable via
 * /proc et ps, sans passer par les internes de LinuxProcessManager. Chaque
 * test pilote une vraie `LinuxServer` via `executeCommand`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 3 — re-parentage des orphelins vers PID 1', () => {
  let srv: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  function ppidOf(status: string): string | undefined {
    return /^PPid:\t(\d+)/m.exec(status)?.[1];
  }

  it('un fils orphelin (père tué) est immédiatement adopté par PID 1', async () => {
    // The parent backgrounds a child (real PID, persists), records its PID,
    // then parks in an unconditional loop — a real, still-alive, killable
    // process, exactly like a supervisor script blocked forever. The
    // parent's own PID comes from the "[N] PID" backgrounding notice
    // (not a later `echo $!`, since the child's own nested `sleep &`
    // overwrites the shared `$!` slot before the outer statement returns).
    const spawnNotice = await run('sleep 300 & echo $! > /tmp/child.pid; while true; do sleep 1; done &');
    const parentPid = /\[\d+\]\s+(\d+)/.exec(spawnNotice)?.[1] ?? '';
    const childPid = (await run('cat /tmp/child.pid')).trim();

    expect(parentPid).not.toBe('');
    expect(childPid).not.toBe('');
    expect(childPid).not.toBe(parentPid);

    const before = await run(`cat /proc/${childPid}/status`);
    expect(ppidOf(before)).toBe(parentPid);

    await run(`kill -9 ${parentPid}`);

    const after = await run(`cat /proc/${childPid}/status`);
    expect(ppidOf(after)).toBe('1');

    // the child itself is untouched — still alive, just re-parented
    expect(after).toMatch(/^State:\tS/m);

    const psRow = (await run('ps -eo pid,ppid,comm'))
      .split('\n')
      .find((l) => l.trim().split(/\s+/)[0] === childPid);
    expect(psRow).toBeDefined();
    expect(psRow!.trim().split(/\s+/)[1]).toBe('1');
  });

  it('un fils orphelin par sortie naturelle du père (pas de kill explicite) est aussi adopté', async () => {
    // A wrapper script that backgrounds a child and then simply finishes —
    // the most common real-world way a process gets orphaned.
    await run("bash -c 'sleep 300 & echo $! > /tmp/child2.pid'");
    const childPid = (await run('cat /tmp/child2.pid')).trim();
    expect(childPid).not.toBe('');

    const status = await run(`cat /proc/${childPid}/status`);
    expect(ppidOf(status)).toBe('1');
  });

  it('aucun processus ne garde un PPID pointant vers un PID inexistant après le kill', async () => {
    const spawnNotice = await run('sleep 300 & echo $! > /tmp/child3.pid; while true; do sleep 1; done &');
    const parentPid = /\[\d+\]\s+(\d+)/.exec(spawnNotice)?.[1] ?? '';
    await run(`kill -9 ${parentPid}`);

    const out = await run('ps -eo pid,ppid,comm');
    const lines = out.split('\n').slice(1).filter((l) => l.trim());
    const pids = new Set(lines.map((l) => l.trim().split(/\s+/)[0]));
    const orphansSuspects = lines.filter((l) => {
      const cols = l.trim().split(/\s+/);
      const [pid, ppid] = cols;
      if (pid === '1' || ppid === '0') return false;
      return !pids.has(ppid);
    });
    expect(orphansSuspects).toEqual([]);
  });
});
