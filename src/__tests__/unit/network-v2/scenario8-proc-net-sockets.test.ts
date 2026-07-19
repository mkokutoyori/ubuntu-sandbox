/**
 * Scénario 8 — Interaction processus ↔ réseau : /proc/net, ss, et
 * cohérence des sockets.
 *
 * Valide que /proc/net/tcp, /proc/net/udp, ss et /proc/<pid>/fd/
 * s'accordent sur l'identité (inode) d'un même socket, pour des sockets
 * TCP et UDP en écoute créés via `nc -l`. Chaque test pilote une vraie
 * `LinuxServer` via `executeCommand`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 8 — /proc/net, ss, cohérence des sockets', () => {
  let srv: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    srv.powerOn();
  });

  async function run(cmd: string): Promise<string> {
    return srv.executeCommand(cmd);
  }

  async function spawnListener(cmd: string): Promise<number> {
    const notice = await run(cmd);
    const pid = /\[\d+\]\s+(\d+)/.exec(notice)?.[1];
    expect(pid, `background spawn notice should contain a PID: ${JSON.stringify(notice)}`).toBeTruthy();
    return Number(pid);
  }

  describe('création de sockets de test', () => {
    it('nc -l -p 9001 & ouvre un socket TCP en écoute possédé par un PID réel', async () => {
      const pid = await spawnListener('nc -l -p 9001 &');
      const status = await run(`cat /proc/${pid}/status`);
      expect(status).not.toMatch(/No such file/);
      expect(status).toMatch(/Name:\s+nc/);
    });

    it('nc -l -u -p 9002 & ouvre un socket UDP en écoute', async () => {
      const pid = await spawnListener('nc -l -u -p 9002 &');
      const status = await run(`cat /proc/${pid}/status`);
      expect(status).not.toMatch(/No such file/);
    });

    it('mkfifo + cat fifo & garde un processus vivant', async () => {
      await run('mkfifo /tmp/test-socket');
      const notice = await run('cat /tmp/test-socket &');
      const pid = Number(/\[\d+\]\s+(\d+)/.exec(notice)?.[1]);
      expect(pid).toBeGreaterThan(0);
      const status = await run(`cat /proc/${pid}/status`);
      expect(status).not.toMatch(/No such file/);
    });
  });

  describe('cohérence ss ↔ /proc/net/tcp', () => {
    it('le port TCP 9001 apparaît en LISTEN dans ss -tlnp', async () => {
      await spawnListener('nc -l -p 9001 &');
      const out = await run('ss -tlnp');
      expect(out).toMatch(/LISTEN/);
      expect(out).toContain(':9001');
    });

    it("l'inode du socket port 9001 dans /proc/net/tcp correspond au PID propriétaire via /proc/<pid>/fd/", async () => {
      const pid = await spawnListener('nc -l -p 9001 &');

      // /proc/net/tcp's local_address field is "<8-hex-digit IP>:<4-hex-digit
      // port>" — the port is 9001 = 0x2329, matched at the end after the
      // literal colon (not "00002329" concatenated without it).
      const inodeLine = await run(
        `awk '$2 ~ /:2329$/ {print "Port:", strtonum("0x" substr($2, index($2,":")+1)), "Etat:", $4, "Inode:", $10}' /proc/net/tcp`,
      );
      expect(inodeLine).toContain('Port: 9001');
      expect(inodeLine).toContain('Etat: 0A');

      const inode = (await run(`awk '$2 ~ /:2329$/ {print $10}' /proc/net/tcp`)).trim();
      expect(inode).not.toBe('');
      expect(inode).not.toBe('0');

      const fdListing = await run(`ls -la /proc/${pid}/fd/`);
      expect(fdListing).toContain(`socket:[${inode}]`);
    });
  });

  describe('inspection complète des sockets d\'un processus', () => {
    it('liste les descripteurs ouverts et leur type pour le PID du listener TCP', async () => {
      const pid = await spawnListener('nc -l -p 9001 &');
      const listing = await run(`ls -la /proc/${pid}/fd/`);
      expect(listing).toMatch(/\b0\b/);
      expect(listing).toMatch(/\b1\b/);
      expect(listing).toMatch(/\b2\b/);

      const types = await run(
        `for fd in /proc/${pid}/fd/*; do target=$(readlink "$fd" 2>/dev/null); echo "fd $(basename $fd): $target"; done`,
      );
      expect(types).toMatch(/fd 3: socket:\[\d+\]/);
    });

    it("l'inode UDP du port 9002 dans /proc/net/udp correspond au PID propriétaire", async () => {
      const pid = await spawnListener('nc -l -u -p 9002 &');
      const inode = (await run(`awk '$2 ~ /:232A$/ {print $10}' /proc/net/udp`)).trim();
      expect(inode).not.toBe('');
      expect(inode).not.toBe('0');
      const fdListing = await run(`ls -la /proc/${pid}/fd/`);
      expect(fdListing).toContain(`socket:[${inode}]`);
    });
  });

  describe('audit : ports sans processus, cohérence ss vs /proc/net', () => {
    it('un port en LISTEN dans /proc/net/tcp a toujours une entrée ss correspondante', async () => {
      await spawnListener('nc -l -p 9001 &');
      await spawnListener('nc -l -u -p 9002 &');

      const ssTcpPorts = (await run(
        `ss -tlnp | awk 'NR>1 {print $4}' | grep -oP ':\\K\\d+' | sort -n`,
      )).trim().split('\n').filter(Boolean);

      const procTcpPorts = (await run(
        `awk '$4 == "0A" { split($2, a, ":"); port=strtonum("0x"a[2]); if (port > 0) print port }' /proc/net/tcp | sort -n`,
      )).trim().split('\n').filter(Boolean);

      expect(ssTcpPorts).toContain('9001');
      expect(procTcpPorts).toContain('9001');
      // Toute écoute visible dans /proc/net/tcp doit l'être aussi via ss.
      for (const port of procTcpPorts) {
        expect(ssTcpPorts).toContain(port);
      }
    });

    it("chaque socket TCP en LISTEN référencé par ss a un PID vivant dans /proc", async () => {
      const pid = await spawnListener('nc -l -p 9001 &');
      const ssOut = await run('ss -tlnp');
      const ncLine = ssOut.split('\n').find((l) => l.includes(':9001'));
      const pidMatch = /pid=(\d+)/.exec(ncLine ?? '');
      expect(pidMatch?.[1]).toBe(String(pid));
      const status = await run(`cat /proc/${pidMatch![1]}/status`);
      expect(status).not.toMatch(/No such file/);
    });
  });
});
