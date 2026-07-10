import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

interface Lab {
  client: LinuxPC;
  server: LinuxServer;
}

function buildLab(): Lab {
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('c').connect(client.getPorts()[0], server.getPorts()[0]);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const um = (server as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'wonderland');
  return { client, server };
}

function fail2ban(server: LinuxServer) {
  return (server as unknown as { getSshServerContext: () => { fail2ban: { bannedIps: () => readonly string[] } | null } }).getSshServerContext().fail2ban!;
}

describe('Scénario 1 — chage expiration + cascade Fail2ban', () => {
  describe('Couche chage / PAM', () => {
    it('chage -l montre le mot de passe expiré et la dernière modification', async () => {
      const { server } = buildLab();
      await server.executeCommand('chage -M 1 -d 2000-01-01 alice');
      const out = await server.executeCommand('chage -l alice');
      expect(out).toMatch(/Last password change\s*:\s*Jan 01, 2000/);
      expect(out).toMatch(/Password expires\s*:\s*Jan 02, 2000/);
    });

    it('la tentative SSH est refusée avec le message PAM attendu côté client', async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 1 -d 2000-01-01 alice');
      const out = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(out).toMatch(/Your account has expired; please contact your system administrator/);
      expect(out).not.toMatch(/^alice\s*$/m);
    });

    it("auth.log distingue l'échec d'authentification PAM de l'échec de phase compte", async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 1 -d 2000-01-01 alice');
      await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');

      const authLog = await server.executeCommand('cat /var/log/auth.log');
      expect(authLog).toMatch(/pam_unix\(sshd:auth\): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=10\.0\.0\.1 user=alice/);
      expect(authLog).toMatch(/pam_unix\(sshd:account\): expired password for user alice/);
    });
  });

  describe('Couche Fail2ban', () => {
    it('cinq tentatives (maxretry=5) déclenchent le ban, tracé "Found" x5 puis "Ban" dans fail2ban.log', async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 1 -d 2000-01-01 alice');

      for (let i = 0; i < 5; i++) {
        await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      }

      expect(fail2ban(server).bannedIps()).toContain('10.0.0.1');
      const f2bLog = await server.executeCommand('cat /var/log/fail2ban.log');
      const lines = f2bLog.trim().split('\n').filter((l) => l.includes('10.0.0.1'));
      expect(lines.length).toBe(6);
      expect(lines.slice(0, 5).every((l) => /WARNING\s+\[sshd\] Found 10\.0\.0\.1/.test(l))).toBe(true);
      expect(lines[5]).toMatch(/NOTICE\s+\[sshd\] Ban 10\.0\.0\.1/);
    });

    it('fail2ban-client status sshd montre l\'IP bannie après le seuil (bantime=300, findtime=60 — valeurs par défaut de la jail)', async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 1 -d 2000-01-01 alice');
      for (let i = 0; i < 5; i++) {
        await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      }
      const status = await server.executeCommand('fail2ban-client status sshd');
      expect(status).toMatch(/Banned IP list:\s*10\.0\.0\.1/);
      const bantime = await server.executeCommand('fail2ban-client get sshd bantime');
      expect(parseInt(bantime, 10)).toBe(300);
    });

    it('la règle iptables dynamique du ban vit dans la chaîne dédiée f2b-sshd', async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 1 -d 2000-01-01 alice');
      for (let i = 0; i < 5; i++) {
        await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      }
      const jail = await server.executeCommand('iptables -L f2b-sshd -n -v');
      expect(jail).toMatch(/REJECT\s+all\s+--\s+\*\s+\*\s+10\.0\.0\.1/);
    });
  });

  describe('Corrélation des deux couches', () => {
    it('le renouvellement du mot de passe seul ne rétablit pas l\'accès tant que le ban Fail2ban est actif', async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 1 -d 2000-01-01 alice');
      for (let i = 0; i < 5; i++) {
        await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      }
      expect(fail2ban(server).bannedIps()).toContain('10.0.0.1');

      await server.executeCommand(`chage -d ${new Date().toISOString().slice(0, 10)} alice`);
      const stillBlocked = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(stillBlocked).toMatch(/refused/i);
    });

    it('fail2ban-client set sshd unbanip lève le ban et restaure la connexion, une fois le mot de passe aussi renouvelé', async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 1 -d 2000-01-01 alice');
      for (let i = 0; i < 5; i++) {
        await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      }
      await server.executeCommand(`chage -d ${new Date().toISOString().slice(0, 10)} alice`);

      const unban = await server.executeCommand('fail2ban-client set sshd unbanip 10.0.0.1');
      expect(unban.trim()).toBe('10.0.0.1');
      expect(fail2ban(server).bannedIps()).not.toContain('10.0.0.1');

      const restored = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(restored).toMatch(/^alice\s*$/m);
    });
  });
});
