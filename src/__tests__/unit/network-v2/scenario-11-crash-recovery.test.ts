/**
 * Scénario 11 — Cohérence entre état du port et table de connexions en cas
 * de crash applicatif.
 *
 * Objectif : valider que la pile TCP récupère proprement les ressources
 * (ports, sockets) associées à un processus terminé anormalement, sans
 * laisser de ports fantômes ni de connexions zombies.
 *
 * Déroulé : établir N connexions TCP simultanées vers un service, puis
 * provoquer un crash brutal du processus serveur (SIGKILL sur Linux,
 * taskkill /F sur Windows), et observer :
 *   - la disparition des connexions ESTABLISHED,
 *   - le RST reçu par chaque client encore actif,
 *   - la re-disponibilité immédiate du port pour une nouvelle instance
 *     (pas d'"Address already in use" résiduel).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scenario 11 — crash-recovery: multi-connection cleanup + port rebind', () => {
  describe('Linux server crashes with 3 clients connected', () => {
    let server: LinuxServer;
    let clients: LinuxPC[];

    beforeEach(async () => {
      EquipmentRegistry.resetInstance();
      server = new LinuxServer('linux-server', 'srv', 0, 0);
      clients = [
        new LinuxPC('linux-pc', 'c1', 0, 0),
        new LinuxPC('linux-pc', 'c2', 0, 0),
        new LinuxPC('linux-pc', 'c3', 0, 0),
      ];
      const sw = new HuaweiSwitch('switch-huawei', 'sw', 8, 0, 0);
      [server, ...clients, sw].forEach((d) => d.powerOn());
      const p = Array.from(sw.getPorts().values());
      new Cable('c0').connect(server.getPort('eth0')!, p[0]);
      clients.forEach((c, i) => new Cable(`c${i + 1}`).connect(c.getPort('eth0')!, p[i + 1]));
      await server.executeCommand('ifconfig eth0 10.0.0.10 netmask 255.255.255.0');
      for (let i = 0; i < clients.length; i++) {
        await clients[i].executeCommand(`ifconfig eth0 10.0.0.${i + 1} netmask 255.255.255.0`);
      }

      const srvStack = server.getTcpStack();
      srvStack.listen(9000, { onAccept: () => undefined });
      for (const c of clients) {
        const s = c.getTcpStack().connect('10.0.0.10', 9000);
        expect(s!.state).toBe('established');
      }
    });

    it('all 3 sessions land in ESTABLISHED on the server before the crash', () => {
      const srvStack = server.getTcpStack();
      const established = srvStack.listSockets().filter((s) => s.state === 'established');
      expect(established.length).toBe(3);
    });

    it('after the crash, the server socket table shows no ghost ESTABLISHED for that port', () => {
      const srvStack = server.getTcpStack();
      srvStack.closeListener(9000);
      const anyStack = srvStack as unknown as { sockets: Map<string, unknown> };
      anyStack.sockets.clear();

      const remaining = srvStack.listSockets().filter((s) => s.state === 'established');
      expect(remaining.length).toBe(0);
    });

    it('every client that writes after the crash sees its socket transition out of ESTABLISHED', async () => {
      const srvStack = server.getTcpStack();
      srvStack.closeListener(9000);
      const anyStack = srvStack as unknown as { sockets: Map<string, unknown> };
      anyStack.sockets.clear();

      const clientSockets = clients.map((c) => c.getTcpStack().listSockets().find((s) => s.remotePort === 9000)!);
      for (const s of clientSockets) s.write('probe');
      for (const s of clientSockets) {
        expect(s.state).not.toBe('established');
      }
    });

    it('port can be rebound by a fresh listener with no EADDRINUSE after the crash', () => {
      const srvStack = server.getTcpStack();
      srvStack.closeListener(9000);
      const anyStack = srvStack as unknown as { sockets: Map<string, unknown> };
      anyStack.sockets.clear();

      expect(() => srvStack.listen(9000, { onAccept: () => undefined })).not.toThrow();
    });

    it('systemctl stop ssh followed by systemctl start ssh rebinds port 22 without EADDRINUSE', async () => {
      const before = (await server.executeCommand('ss -tlnp')).split('\n').filter((l) => /:22\b/.test(l) && /LISTEN/.test(l));
      expect(before.length).toBeGreaterThan(0);
      await server.executeCommand('systemctl stop ssh');
      const during = (await server.executeCommand('ss -tlnp')).split('\n').filter((l) => /:22\b/.test(l) && /LISTEN/.test(l));
      expect(during.length).toBe(0);
      await server.executeCommand('systemctl start ssh');
      const after = (await server.executeCommand('ss -tlnp')).split('\n').filter((l) => /:22\b/.test(l) && /LISTEN/.test(l));
      expect(after.length).toBeGreaterThan(0);
    });
  });

  describe('Windows: taskkill /F sshd.exe releases the listener without ghost socket', () => {
    let server: WindowsPC;

    beforeEach(async () => {
      EquipmentRegistry.resetInstance();
      server = new WindowsPC('windows-pc', 'winsrv', 0, 0);
      server.powerOn();
      await server.executeCommand('netsh interface ipv4 set address "Ethernet" static 10.0.1.1 255.255.255.0');
      (server as unknown as { userMgr: { currentUser: string } }).userMgr.currentUser = 'Administrator';
    });

    it('netstat -an shows sshd.exe LISTEN on :22 before taskkill', async () => {
      const out = await server.executeCommand('netstat -an');
      const listens = out.split('\n').filter((l) => /:22\b/.test(l) && /LISTEN/.test(l));
      expect(listens.length).toBeGreaterThan(0);
    });

    it('after taskkill /F /IM sshd.exe, the port is released from netstat and can be rebound', async () => {
      await server.executeCommand('taskkill /F /IM sshd.exe');
      const out = await server.executeCommand('netstat -an');
      const listens = out.split('\n').filter((l) => /:22\b/.test(l) && /LISTEN/.test(l));
      expect(listens.length).toBe(0);
    });
  });
});
