import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

interface Lab {
  client: LinuxPC;
  attacker: LinuxPC;
  server: LinuxServer;
}

function buildLab(): Lab {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const attacker = new LinuxPC('linux-pc', 'ATTACKER', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(attacker.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(server.getPorts()[0], sw.getPorts()[2]);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  attacker.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const um = (server as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'wonderland');
  return { client, attacker, server };
}

function fail2ban(server: LinuxServer) {
  return (server as unknown as { getSshServerContext: () => { fail2ban: { bannedIps: () => readonly string[] } | null } }).getSshServerContext().fail2ban!;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('Scénario 3 — période d\'avertissement chage -W et sensibilité Fail2ban (maxretry)', () => {
  describe('Avertissement PAM en période chage', () => {
    it('chage -l montre l\'expiration dans 3 jours et une fenêtre d\'avertissement de 7 jours', async () => {
      const { server } = buildLab();
      await server.executeCommand(`chage -W 7 -M 30 -d ${daysAgo(27)} alice`);
      const out = await server.executeCommand('chage -l alice');
      expect(out).toMatch(/Number of days of warning before password expires\s*:\s*7/);
      expect(out).not.toMatch(/Password expires\s*:\s*never/);
    });

    it('une connexion SSH réussie en période d\'avertissement affiche le message PAM sans bloquer la session', async () => {
      const { client, server } = buildLab();
      await server.executeCommand(`chage -W 7 -M 30 -d ${daysAgo(27)} alice`);

      const out = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(out).toMatch(/Warning: your password will expire in 3 days\./);
      expect(out).toMatch(/^alice\s*$/m);

      const authLog = await server.executeCommand('cat /var/log/auth.log');
      expect(authLog).toMatch(/Accepted password for alice from 10\.0\.0\.1/);
    });
  });

  describe('Bannissement d\'un utilisateur légitime hésitant selon la sensibilité maxretry', () => {
    it('avec maxretry=5 (valeur par défaut), 4 échecs puis le bon mot de passe à la 5e tentative réussissent', async () => {
      const { client, server } = buildLab();
      await server.executeCommand(`chage -W 7 -M 30 -d ${daysAgo(27)} alice`);

      for (let i = 0; i < 4; i++) {
        await client.executeCommand('sshpass -p WRONG ssh alice@10.0.0.2 whoami');
      }
      expect(fail2ban(server).bannedIps()).not.toContain('10.0.0.1');

      // Isolate Fail2ban's own maxretry sensitivity from pam_faillock's
      // independent (and stricter, deny=3) account-lockout counter —
      // this scenario is about the Fail2ban IP-ban threshold specifically.
      await server.executeCommand('faillock --user alice --reset');
      const out = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(out).toMatch(/^alice\s*$/m);
      expect(fail2ban(server).bannedIps()).not.toContain('10.0.0.1');
    });

    it('avec une jail resserrée à maxretry=3, l\'utilisateur légitime hésitant se retrouve banni avant de saisir le bon mot de passe', async () => {
      const { client, server } = buildLab();
      await server.executeCommand(`chage -W 7 -M 30 -d ${daysAgo(27)} alice`);
      await server.executeCommand(
        "printf '[sshd]\\nenabled = true\\nmaxretry = 3\\nbantime = 300\\nfindtime = 60\\n' > /etc/fail2ban/jail.local",
      );
      await server.executeCommand('systemctl restart ssh');

      for (let i = 0; i < 3; i++) {
        await client.executeCommand('sshpass -p WRONG ssh alice@10.0.0.2 whoami');
      }
      expect(fail2ban(server).bannedIps()).toContain('10.0.0.1');

      const out = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(out).toMatch(/refused/i);
      expect(out).not.toMatch(/^alice\s*$/m);
    });
  });

  describe('Attaque par dictionnaire pendant la période d\'avertissement', () => {
    it('l\'attaquant est banni sur son IP tandis que l\'utilisateur légitime se connecte normalement depuis une autre IP', async () => {
      const { client, attacker, server } = buildLab();
      await server.executeCommand(`chage -W 7 -M 30 -d ${daysAgo(27)} alice`);

      for (let i = 0; i < 5; i++) {
        await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.2 whoami');
      }
      expect(fail2ban(server).bannedIps()).toContain('10.0.0.20');
      expect(fail2ban(server).bannedIps()).not.toContain('10.0.0.1');

      // The attacker's failures also tripped pam_faillock on the *account*
      // (independent of Fail2ban's per-IP ban) — reset it so the legitimate
      // user's own correct password isn't refused for that unrelated reason.
      await server.executeCommand('faillock --user alice --reset');
      const legit = await client.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      expect(legit).toMatch(/^alice\s*$/m);

      const bantime = await server.executeCommand('fail2ban-client get sshd bantime');
      expect(parseInt(bantime, 10)).toBe(300);
      const status = await server.executeCommand('fail2ban-client status sshd');
      expect(status).toMatch(/Banned IP list:\s*10\.0\.0\.20/);
    });
  });
});
