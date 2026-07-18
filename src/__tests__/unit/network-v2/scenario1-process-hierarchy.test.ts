/**
 * Scénario 1 — Hiérarchie des processus système clés et arbre de parenté PID 1.
 *
 * Valide que le simulateur modélise fidèlement la hiérarchie complète des
 * processus système au démarrage d'une machine Linux — de PID 1 (systemd)
 * jusqu'aux processus applicatifs — avec cohérence de l'arbre de parenté,
 * attributs de chaque processus clé (UID, GID, état), et présence
 * obligatoire dans /proc.
 *
 * Chaque test pilote une vraie `LinuxServer` de bout en bout via
 * `executeCommand`, exactement comme un utilisateur taperait ces commandes
 * dans le terminal simulé — aucun accès direct à `LinuxProcessManager`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 1 — hiérarchie des processus système et arbre PID 1', () => {
  let srv: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  async function pidOf(comm: string): Promise<string> {
    const out = await run(`pgrep -x ${comm}`);
    return out.trim().split('\n')[0] ?? '';
  }

  describe('arbre de processus et parenté', () => {
    it('ps -ef --forest montre PID 1 comme racine', async () => {
      const out = await run('ps -ef --forest');
      const lines = out.split('\n');
      expect(lines[0]).toMatch(/UID\s+PID\s+PPID/);
      const initLine = lines.find((l) => /^root\s+1\s+0\s/.test(l));
      expect(initLine).toBeDefined();
      // Real `ps -ef` renders PID 1's CMD column as its argv0 path
      // (/sbin/init), not the short `comm` name — check `ps -p 1 -o comm=`
      // separately for the short name.
      expect(initLine).toMatch(/\/sbin\/init/);
    });

    it('ps -p 1 montre systemd/init comme PID 1, PPID 0, root', async () => {
      const out = await run('ps -p 1 -o pid,ppid,user,comm,args');
      expect(out).toMatch(/\bsystemd\b/);
      const dataLine = out.split('\n')[1];
      const cols = dataLine.trim().split(/\s+/);
      expect(cols[0]).toBe('1');
      expect(cols[1]).toBe('0');
      expect(cols[2]).toBe('root');
    });

    it('ps -p 2 montre kthreadd comme PID 2, propriété root', async () => {
      const out = await run('ps -p 2 -o pid,ppid,user,comm,args');
      const dataLine = out.split('\n')[1];
      const cols = dataLine.trim().split(/\s+/);
      expect(cols[0]).toBe('2');
      expect(cols[2]).toBe('root');
      expect(out).toMatch(/\[kthreadd\]/);
    });

    it('tous les threads noyau (PPID=2) ont un comm entre crochets et sont root', async () => {
      const out = await run('ps -ef');
      const kthreadLines = out.split('\n').filter((l) => {
        const cols = l.trim().split(/\s+/);
        return cols[2] === '2'; // PPID column in -ef layout (UID PID PPID ...)
      });
      expect(kthreadLines.length).toBeGreaterThan(0);
      for (const line of kthreadLines) {
        const cols = line.trim().split(/\s+/);
        expect(cols[0]).toBe('root');
        expect(cols.slice(7).join(' ')).toMatch(/^\[.+\]$/);
      }
    });

    it('sshd apparaît dans l\'arbre avec un PPID valide', async () => {
      const out = await run('ps -ef --forest');
      expect(out).toMatch(/sshd/);
      const sshdPid = await pidOf('sshd');
      expect(sshdPid).not.toBe('');
      const psOut = await run(`ps -p ${sshdPid} -o ppid=`);
      const ppid = parseInt(psOut.trim(), 10);
      expect(Number.isInteger(ppid)).toBe(true);
      expect(ppid).toBeGreaterThanOrEqual(1);
    });
  });

  describe('vérification dans /proc de chaque processus clé', () => {
    const KEY_PROCS = ['systemd', 'kthreadd', 'cron', 'sshd', 'rsyslogd'];

    it.each(KEY_PROCS)('%s est présent avec une entrée /proc cohérente', async (name) => {
      const pid = name === 'systemd' ? '1' : name === 'kthreadd' ? '2' : await pidOf(name);
      expect(pid, `${name} devrait avoir un PID`).not.toBe('');

      const status = await run(`cat /proc/${pid}/status`);
      expect(status).toMatch(/^Name:\t/m);
      expect(status).toMatch(/^Pid:\t\d+/m);
      expect(status).toMatch(/^PPid:\t\d+/m);
      expect(status).toMatch(/^Uid:\t\d+/m);
      expect(status).toMatch(/^Gid:\t\d+/m);
      expect(status).toMatch(/^State:\t\S/m);
      expect(status).toMatch(/^Threads:\t\d+/m);

      const cmdline = await run(`cat /proc/${pid}/cmdline`);
      // cmdline is NUL-joined; a plain `cat` renders NULs as nothing visible
      // but the read must not fail / be empty-with-error for a live pid.
      expect(cmdline).not.toMatch(/No such file/);

      const fdCount = await run(`ls -la /proc/${pid}/fd`);
      expect(fdCount).not.toMatch(/No such file/);
      expect(fdCount.split('\n').filter((l) => /\d+\s*->|-> /.test(l) || /\d+$/.test(l.trim())).length)
        .toBeGreaterThan(0);

      const vmrss = await run(`grep VmRSS /proc/${pid}/status`);
      expect(vmrss).toMatch(/VmRSS:\t\d+ kB/);
    });
  });

  describe('cohérence UID effectif vs UID déclaré', () => {
    it('sshd et cron tournent sous root', async () => {
      const out = await run('ps -eo pid,user,comm');
      const lines = out.split('\n').slice(1);
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        const comm = cols[2];
        if (comm === 'sshd') expect(cols[1]).toBe('root');
        if (comm === 'cron') expect(cols[1]).toBe('root');
      }
    });

    it('rsyslogd tourne sous root ou syslog', async () => {
      const out = await run('ps -eo pid,user,comm');
      const lines = out.split('\n').slice(1);
      const rsyslog = lines.find((l) => l.trim().split(/\s+/)[2] === 'rsyslogd');
      expect(rsyslog).toBeDefined();
      const user = rsyslog!.trim().split(/\s+/)[1];
      expect(['root', 'syslog']).toContain(user);
    });

    it('UID de ps -o uid= est cohérent avec /proc/<pid>/status', async () => {
      const sshdPid = await pidOf('sshd');
      const uidPs = (await run(`ps -p ${sshdPid} -o uid=`)).trim();
      const status = await run(`cat /proc/${sshdPid}/status`);
      const uidProc = /^Uid:\t(\d+)/m.exec(status)?.[1];
      expect(uidProc).toBe(uidPs);
    });
  });

  describe('threads noyau et processus orphelins de kthreadd', () => {
    it('liste tous les processus dont le PPID est 2', async () => {
      const out = await run('ps -eo pid,ppid,comm');
      const lines = out.split('\n').slice(1);
      const kthreads = lines.filter((l) => l.trim().split(/\s+/)[1] === '2');
      expect(kthreads.length).toBeGreaterThan(0);
    });

    it('aucun processus n\'a un PPID pointant vers un PID inexistant', async () => {
      const out = await run('ps -eo pid,ppid,comm');
      const lines = out.split('\n').slice(1).filter((l) => l.trim());
      const pids = new Set(lines.map((l) => l.trim().split(/\s+/)[0]));
      const orphansSuspects: string[] = [];
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        const pid = cols[0];
        const ppid = cols[1];
        if (pid === '1') continue; // PID 1's ppid=0 is legitimate (kernel)
        if (ppid === '0') continue; // kthreadd's ppid=0 is legitimate too
        if (!pids.has(ppid)) orphansSuspects.push(`${pid} ppid=${ppid}`);
      }
      expect(orphansSuspects).toEqual([]);
    });
  });
});
