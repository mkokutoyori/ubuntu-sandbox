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

function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe('Scénario 2 — compte désactivé par inactivité (chage -I) et bannissement Fail2ban orthogonal', () => {
  describe('Désactivation par inactivité', () => {
    it('chage -l montre Account expires (date passée) et une politique -M 30 / -I 7 effective', async () => {
      const { server } = buildLab();
      await server.executeCommand('chage -M 30 -I 7 alice');
      await server.executeCommand(`chage -E ${yesterday()} alice`);
      const out = await server.executeCommand('chage -l alice');
      expect(out).toMatch(/Account expires\s*:\s*\w+ \d{2}, \d{4}/);
      expect(out).not.toMatch(/Account expires\s*:\s*never/);
      expect(out).toMatch(/Maximum number of days between password change\s*:\s*30/);
      expect(out).not.toMatch(/Password inactive\s*:\s*never/);
    });

    it('le refus est tracé sous le code PAM_ACCT_EXPIRED, distinct du refus pour mot de passe simplement expiré', async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 30 -I 7 alice');
      await server.executeCommand(`chage -E ${yesterday()} alice`);

      const out = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(out).toMatch(/Your account has expired; please contact your system administrator/);
      expect(out).not.toMatch(/^alice\s*$/m);

      const authLog = await server.executeCommand('cat /var/log/auth.log');
      expect(authLog).toMatch(/pam_unix\(sshd:account\): account alice has expired \(account expired\)/);
      // Distinct from the password-expired two-line format (Scénario 1) —
      // no "authentication failure;" PAM line here, only the account line.
      expect(authLog).not.toMatch(/pam_unix\(sshd:auth\): authentication failure;/);
    });

    it("l'inactivité naturelle (maxDays + inactiveDays dépassés, sans -E direct) produit le même code PAM_ACCT_EXPIRED", async () => {
      const { client, server } = buildLab();
      // 40 days ago, password max age 10 days, inactivity grace 5 days:
      // password expired at day 10, inactivity grace exceeded at day 15 — well past.
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 40);
      await server.executeCommand(`chage -M 10 -I 5 -d ${d.toISOString().slice(0, 10)} alice`);

      const out = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(out).toMatch(/Your account has expired; please contact your system administrator/);

      const authLog = await server.executeCommand('cat /var/log/auth.log');
      expect(authLog).toMatch(/pam_unix\(sshd:account\): account alice has expired \(account expired\)/);
    });
  });

  describe('Bannissement Fail2ban malgré compte déjà inactif', () => {
    it("Fail2ban bannit l'IP après maxretry tentatives même si le compte est déjà rejeté par chage", async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 30 -I 7 alice');
      await server.executeCommand(`chage -E ${yesterday()} alice`);

      for (let i = 0; i < 5; i++) {
        await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      }

      expect(fail2ban(server).bannedIps()).toContain('10.0.0.1');
      const status = await server.executeCommand('fail2ban-client status sshd');
      expect(status).toMatch(/Banned IP list:\s*10\.0\.0\.1/);
    });
  });

  describe('Réactivation du compte et état Fail2ban', () => {
    it('la réactivation du compte (chage -E -1 + renouvellement du mot de passe) ne suffit pas : le ban Fail2ban reste actif', async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 30 -I 7 alice');
      await server.executeCommand(`chage -E ${yesterday()} alice`);
      for (let i = 0; i < 5; i++) {
        await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      }
      expect(fail2ban(server).bannedIps()).toContain('10.0.0.1');

      await server.executeCommand('chage -E -1 alice');
      await server.executeCommand(`chage -d ${new Date().toISOString().slice(0, 10)} alice`);

      const stillBanned = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(stillBanned).toMatch(/refused/i);
      expect(fail2ban(server).bannedIps()).toContain('10.0.0.1');
    });

    it("fail2ban-client set sshd unbanip restaure l'accès une fois le compte réellement réactivé", async () => {
      const { client, server } = buildLab();
      await server.executeCommand('chage -M 30 -I 7 alice');
      await server.executeCommand(`chage -E ${yesterday()} alice`);
      for (let i = 0; i < 5; i++) {
        await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      }

      await server.executeCommand('chage -E -1 alice');
      await server.executeCommand(`chage -d ${new Date().toISOString().slice(0, 10)} alice`);
      await server.executeCommand('fail2ban-client set sshd unbanip 10.0.0.1');

      const restored = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(restored).toMatch(/^alice\s*$/m);
    });
  });
});
