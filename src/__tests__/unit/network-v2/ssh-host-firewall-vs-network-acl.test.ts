/**
 * Scénario 4 — Pare-feu local (iptables / Windows Firewall) bloquant
 * SSH entrant.
 *
 * Objectif : distinguer un blocage réseau (ACL switch/router) d'un
 * blocage au niveau de l'hôte cible, avec le bon message côté client.
 *
 * Tableau attendu (conforme à OpenSSH/Linux/Windows réels) :
 *
 *   Couche                    | Côté client                | Trace côté serveur
 *   --------------------------|----------------------------|--------------------------
 *   ACL routeur (DROP)        | Connection timed out       | show ip access-lists counters
 *   iptables -j REJECT        | Connection refused         | iptables -L -n -v counters
 *   iptables -j DROP          | Connection timed out       | iptables -L -n -v counters
 *   Windows Firewall Block    | Connection timed out       | Get-EventLog Security 5152
 *
 * Critère de réussite : différenciation claire entre « refusé
 * activement » (REJECT) et « perdu silencieusement » (DROP ou Windows
 * Firewall), avec les bons messages d'erreur côté client.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface LinuxLan {
  adminPc: LinuxPC;
  attackerPc: LinuxPC;
  server: LinuxServer;
  sw: GenericSwitch;
}

async function buildLinuxLan(): Promise<LinuxLan> {
  const adminPc    = new LinuxPC('linux-pc', 'admin-pc', 0, 0);
  const attackerPc = new LinuxPC('linux-pc', 'attacker', 0, 0);
  const server     = new LinuxServer('linux-server', 'srv', 0, 0);
  const sw         = new GenericSwitch('switch', 'switch');
  new Cable('c1').connect(adminPc.getPorts()[0],    sw.getPorts()[0]);
  new Cable('c2').connect(attackerPc.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(server.getPorts()[0],     sw.getPorts()[2]);
  adminPc.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  attackerPc.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), new SubnetMask('255.255.255.0'));
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'admin');
  return { adminPc, attackerPc, server, sw };
}

describe('Scénario 4 — pare-feu local vs ACL réseau', () => {
  describe('Linux iptables -j REJECT (refus actif)', () => {
    it('iptables -L -n -v montre les deux règles (ACCEPT admin + REJECT)', async () => {
      const { server } = await buildLinuxLan();
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -s 10.0.0.10 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT');
      const listing = await server.executeCommand('iptables -L INPUT -n -v');
      expect(listing).toMatch(/ACCEPT.*tcp.*10\.0\.0\.10.*dpt:22/);
      expect(listing).toMatch(/REJECT.*tcp.*dpt:22/);
    });

    it('admin (10.0.0.10) → ssh accepté ; attacker (10.0.0.20) → Connection refused', async () => {
      const { adminPc, attackerPc, server } = await buildLinuxLan();
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -s 10.0.0.10 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT');

      const ok = await adminPc.executeCommand('ssh alice@10.0.0.100 whoami');
      expect(ok).toMatch(/^alice\s*$/m);

      const ko = await attackerPc.executeCommand('ssh alice@10.0.0.100 whoami');
      expect(ko).toMatch(/Connection refused/);
      expect(ko).not.toMatch(/Connection timed out/);
      expect(ko).not.toMatch(/^alice\s*$/m);
    });

    it('iptables -L -n -v incrémente le compteur pkts sur la règle REJECT après une tentative', async () => {
      const { attackerPc, server } = await buildLinuxLan();
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT');
      const before = await server.executeCommand('iptables -L INPUT -n -v');
      const beforeCount = parseInt(/^\s*(\d+)\s+\d+\s+REJECT/m.exec(before)?.[1] ?? '0', 10);

      await attackerPc.executeCommand('ssh alice@10.0.0.100 whoami');

      const after = await server.executeCommand('iptables -L INPUT -n -v');
      const afterCount = parseInt(/^\s*(\d+)\s+\d+\s+REJECT/m.exec(after)?.[1] ?? '0', 10);
      expect(afterCount).toBeGreaterThan(beforeCount);
    });
  });

  describe('Linux iptables -j DROP (silencieux)', () => {
    it('attacker → Connection timed out (drop silencieux, pas de RST)', async () => {
      const { attackerPc, server } = await buildLinuxLan();
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -s 10.0.0.10 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');

      const ko = await attackerPc.executeCommand('ssh alice@10.0.0.100 whoami');
      expect(ko).toMatch(/Connection timed out/);
      expect(ko).not.toMatch(/Connection refused/);
    });

    it('même topologie, le même client distingue REJECT (refused) de DROP (timed out)', async () => {
      const { attackerPc, server } = await buildLinuxLan();
      // REJECT
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT');
      const rej = await attackerPc.executeCommand('ssh alice@10.0.0.100 whoami');
      expect(rej).toMatch(/Connection refused/);

      // Bascule en DROP
      await server.executeCommand('iptables -F INPUT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');
      const drp = await attackerPc.executeCommand('ssh alice@10.0.0.100 whoami');
      expect(drp).toMatch(/Connection timed out/);
    });
  });

  describe('Windows Firewall (silencieux, journal Sécurité)', () => {
    async function buildWindowsLan() {
      const adminPc  = new LinuxPC('linux-pc', 'admin-pc', 0, 0);
      const winSrv   = new WindowsPC('windows-pc', 'win-srv', 0, 0);
      const sw       = new GenericSwitch('switch', 'switch');
      new Cable('w1').connect(adminPc.getPorts()[0], sw.getPorts()[0]);
      new Cable('w2').connect(winSrv.getPorts()[0],  sw.getPorts()[1]);
      adminPc.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
      winSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), new SubnetMask('255.255.255.0'));
      // Provision a Windows user that the Linux client will target.
      await winSrv.executeCommand('net user alice admin /add');
      return { adminPc, winSrv };
    }

    it('Sans règle de blocage : la connexion SSH vers Windows passe', async () => {
      const { adminPc, winSrv } = await buildWindowsLan();
      expect(winSrv).toBeDefined();
      const ok = await adminPc.executeCommand('ssh alice@10.0.0.100 hostname');
      expect(ok).not.toMatch(/Connection timed out/);
      expect(ok).not.toMatch(/Connection refused/);
    });

    it('netsh advfirewall firewall add rule action=block localport=22 → Connection timed out + event 5152', async () => {
      const { adminPc, winSrv } = await buildWindowsLan();
      const created = await winSrv.executeCommand(
        'netsh advfirewall firewall add rule name="Block-SSH" dir=in action=block protocol=TCP localport=22',
      );
      expect(created.trim()).toBe('Ok.');

      const ko = await adminPc.executeCommand('ssh alice@10.0.0.100 hostname');
      expect(ko).toMatch(/Connection timed out/);
      expect(ko).not.toMatch(/Connection refused/);

      const sec = await winSrv.executeCommand('wevtutil qe Security /f:text /c:10');
      expect(sec).toMatch(/5152/);
      expect(sec).toMatch(/Windows Filtering Platform has blocked a packet/);
      expect(sec).toMatch(/Destination: 10\.0\.0\.100:22/);
      expect(sec).toMatch(/Filter: Block-SSH/);
    });

    it('netsh advfirewall firewall show rule name="Block-SSH" reflète la règle ajoutée', async () => {
      const { winSrv } = await buildWindowsLan();
      await winSrv.executeCommand(
        'netsh advfirewall firewall add rule name="Block-SSH" dir=in action=block protocol=TCP localport=22',
      );
      const show = await winSrv.executeCommand('netsh advfirewall firewall show rule name="Block-SSH"');
      expect(show).toMatch(/Rule Name:\s+Block-SSH/);
      expect(show).toMatch(/Action:\s+Block/);
      expect(show).toMatch(/Protocol:\s+TCP/);
      expect(show).toMatch(/LocalPort:\s+22/);
    });
  });
});
