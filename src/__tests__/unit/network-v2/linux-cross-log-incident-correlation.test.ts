/**
 * Correlation croisee auth.log / syslog / journald.
 *
 * Le lab portait une premisse fausse : les DEUX pattes du serveur etaient
 * dans 10.0.0.0/24, chacune cablee en point a point vers un pair different.
 * Un vrai Linux ne repond pas dans cette configuration, et la sonde a ete
 * faite sur le noyau de la machine hote (Ubuntu 24.04.4, trois netns relies
 * par des veth reproduisant exactement ce cablage) :
 *
 *   srv$ ip route
 *     10.0.0.0/24 dev s0 proto kernel scope link src 10.0.0.10
 *     10.0.0.0/24 dev s1 proto kernel scope link src 10.0.0.11
 *   adm$ ping -c 2 10.0.0.11   ->  2 transmitted, 0 received, 100% packet loss
 *   srv$ tcpdump -ni s1 icmp   ->  10.0.0.30 > 10.0.0.11: ICMP echo request  (x2)
 *   srv$ tcpdump -ni s0 icmp   ->  (rien)
 *   srv$ ip neigh
 *     10.0.0.30 dev s0 INCOMPLETE
 *     10.0.0.30 dev s1 lladdr 16:d8:c4:7f:61:50 STALE
 *
 * La demande arrive bien sur s1, mais la reponse suit la PREMIERE route du
 * prefixe — s0 — ou personne ne repond a l'ARP : elle ne part jamais. Le
 * simulateur reproduit cela trait pour trait, meme table de routage et meme
 * echec. Ce n'est donc pas un defaut de la machine, c'est un cablage que le
 * lab ne devait pas poser. La patte d'administration a maintenant son propre
 * segment (10.0.1.0/24), ce que decrit d'ailleurs le scenario : un attaquant
 * sur le reseau expose, un administrateur sur le reseau d'administration.
 */
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
  attacker: LinuxPC;
  admin: LinuxPC;
  server: LinuxServer;
}

function buildLab(): Lab {
  const attacker = new LinuxPC('linux-pc', 'attacker', 0, 0);
  const admin = new LinuxPC('linux-pc', 'admin', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c1').connect(attacker.getPorts()[0], server.getPorts()[0]);
  new Cable('c2').connect(admin.getPorts()[0], server.getPorts()[1]);
  attacker.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  admin.getPorts()[0].configureIP(new IPAddress('10.0.1.30'), new SubnetMask('255.255.255.0'));
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  server.getPorts()[1].configureIP(new IPAddress('10.0.1.11'), new SubnetMask('255.255.255.0'));
  const um = (server as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'correct-horse-battery-staple');
  um.useradd('bob', { m: true, s: '/bin/bash' });
  um.setPassword('bob', 'admin-legit-pw');
  return { attacker, admin, server };
}

function fail2ban(server: LinuxServer) {
  return (server as unknown as { getSshServerContext: () => { fail2ban: {
    bannedIps: () => readonly string[];
    bans: () => readonly { ip: string; until: number }[];
  } | null } }).getSshServerContext().fail2ban!;
}

function extractIsoTimestamps(journalOutput: string): number[] {
  return journalOutput
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => Date.parse(l.split(' ')[0]))
    .filter((t) => !isNaN(t));
}

describe('Scénario 6 — Corrélation croisée auth.log / syslog / journald pour reconstruction d\'incident', () => {
  describe('Acte 1 — force brute SSH depuis une machine externe et bannissement Fail2ban', () => {
    it('chaque tentative échouée journalise "Failed password for <user> from <ip> port <port> ssh2" dans auth.log', async () => {
      const { attacker, server } = buildLab();
      for (let i = 0; i < 3; i++) {
        await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
      }
      const authLog = await server.executeCommand('cat /var/log/auth.log');
      const failedLines = authLog.split('\n').filter((l) => /Failed password for alice from 10\.0\.0\.20(?:\s*\([^)]*\))? port \d+ ssh2/.test(l));
      expect(failedLines.length).toBe(3);
    });

    it('le seuil de tentatives échouées franchi déclenche le ban, cohérent entre auth.log et le seuil Fail2ban configuré', async () => {
      const { attacker, server } = buildLab();
      for (let i = 0; i < 5; i++) {
        await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
      }
      const authLog = await server.executeCommand('cat /var/log/auth.log');
      const failedCount = authLog.split('\n').filter((l) => /Failed password for alice from 10\.0\.0\.20/.test(l)).length;
      expect(failedCount).toBe(5);
      expect(fail2ban(server).bannedIps()).toContain('10.0.0.20');
    });

    it('le bannissement est tracé à la fois dans /var/log/fail2ban.log et journalctl -u fail2ban', async () => {
      const { attacker, server } = buildLab();
      for (let i = 0; i < 5; i++) {
        await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
      }
      const f2bLog = await server.executeCommand('cat /var/log/fail2ban.log');
      expect(f2bLog).toMatch(/NOTICE\s+\[sshd\] Ban 10\.0\.0\.20/);

      const journal = await server.executeCommand('journalctl -u fail2ban');
      expect(journal).toMatch(/\[sshd\] Ban 10\.0\.0\.20/);
    });
  });

  describe('Acte 2 — connexion SSH réussie puis reconfiguration réseau', () => {
    it('la connexion réussie d\'un compte autorisé est tracée dans auth.log ET journalctl -u ssh', async () => {
      const { admin, server } = buildLab();
      const out = await admin.executeCommand('sshpass -p admin-legit-pw ssh bob@10.0.1.11 whoami');
      expect(out).toMatch(/^bob\s*$/m);

      const authLog = await server.executeCommand('cat /var/log/auth.log');
      expect(authLog).toMatch(/Accepted password for bob from 10\.0\.1\.30/);

      const journal = await server.executeCommand('journalctl -u ssh');
      expect(journal).toMatch(/Accepted password for bob from 10\.0\.1\.30/);
    });

    it('une reconfiguration réseau appliquée par systemd-networkd est tracée dans journalctl -u systemd-networkd, indépendamment des événements SSH', async () => {
      const { server } = buildLab();
      const netplanYaml = [
        'network:',
        '  version: 2',
        '  ethernets:',
        '    eth1:',
        '      addresses: [10.0.1.11/24]',
        '      dhcp4: false',
        '      dhcp6: false',
      ].join('\n');
      await server.executeCommand(`cat > /etc/netplan/01-netcfg.yaml <<'EOF'\n${netplanYaml}\nEOF`);
      await server.executeCommand('netplan apply');
      await server.executeCommand(`sed -i 's/10.0.1.11/10.0.1.99/' /etc/netplan/01-netcfg.yaml`);
      await server.executeCommand('systemctl restart systemd-networkd');

      const journal = await server.executeCommand('journalctl -u systemd-networkd');
      expect(journal).toMatch(/eth1.*10\.0\.1\.99/);

      const sshJournal = await server.executeCommand('journalctl -u ssh');
      expect(sshJournal).not.toMatch(/10\.0\.1\.99/);
    });
  });

  describe('Acte 3 — règle iptables autorisant un port précédemment bloqué', () => {
    it('le port refusé devient joignable après la nouvelle règle, corrélé aux compteurs et à iptables-save', async () => {
      const { admin, server } = buildLab();
      await server.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j DROP');

      const before = await admin.executeCommand('nc -zv 10.0.1.11 8080');
      expect(before).not.toMatch(/succeeded|open/i);

      await server.executeCommand('iptables -I INPUT -p tcp --dport 8080 -j ACCEPT');
      const listing = await server.executeCommand('iptables -L INPUT -n -v --line-numbers');
      expect(listing).toMatch(/^1\s+\d+\s+\d+\s+ACCEPT.*dpt:8080/m);

      const saved = await server.executeCommand('iptables-save');
      expect(saved).toContain('-A INPUT -p tcp --dport 8080 -j ACCEPT');
      expect(saved).toContain('-A INPUT -p tcp --dport 8080 -j DROP');
    });
  });

  describe('Corrélation temporelle croisée — reconstruction de la chronologie de l\'incident', () => {
    it('les horodatages de auth.log, fail2ban.log et journalctl -u fail2ban restent cohérents à moins d\'une seconde pour le même événement de ban', async () => {
      const { attacker, server } = buildLab();
      for (let i = 0; i < 5; i++) {
        await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
      }

      const authLog = await server.executeCommand('cat /var/log/auth.log');
      const authLine = authLog.split('\n').filter((l) => /Failed password for alice from 10\.0\.0\.20/.test(l)).pop() ?? '';
      const authMonthDay = /^(\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2})/.exec(authLine)?.[1];
      expect(authMonthDay).toBeDefined();
      const authTs = Date.parse(`${authMonthDay} UTC ${new Date().getFullYear()}`);

      const journal = await server.executeCommand('journalctl -u fail2ban -o short-iso');
      const journalLine = journal.split('\n').find((l) => /Ban 10\.0\.0\.20/.test(l)) ?? '';
      const journalTs = Date.parse(journalLine.split(' ')[0]);

      expect(Number.isNaN(authTs)).toBe(false);
      expect(Number.isNaN(journalTs)).toBe(false);
      expect(Math.abs(journalTs - authTs)).toBeLessThan(1000);
    });

    it('chaque acte de l\'incident est reconstituable en fusionnant au moins deux sources indépendantes, triées par horodatage', async () => {
      const { attacker, admin, server } = buildLab();

      for (let i = 0; i < 5; i++) {
        await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
      }
      await admin.executeCommand('sshpass -p admin-legit-pw ssh bob@10.0.1.11 whoami');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 9090 -j DROP');
      await server.executeCommand('iptables -I INPUT -p tcp --dport 9090 -j ACCEPT');

      const authLog = await server.executeCommand('cat /var/log/auth.log');
      const fail2banJournal = await server.executeCommand('journalctl -u fail2ban -o short-iso');
      const sshJournal = await server.executeCommand('journalctl -u ssh -o short-iso');
      const firewallState = await server.executeCommand('iptables-save');

      expect(authLog).toMatch(/Failed password for alice from 10\.0\.0\.20/);
      expect(authLog).toMatch(/Accepted password for bob from 10\.0\.1\.30/);
      expect(fail2banJournal).toMatch(/Ban 10\.0\.0\.20/);
      expect(sshJournal).toMatch(/Accepted password for bob from 10\.0\.1\.30/);
      expect(firewallState).toContain('-A INPUT -p tcp --dport 9090 -j ACCEPT');
      expect(firewallState).toContain('-A INPUT -p tcp --dport 9090 -j DROP');

      const fail2banTimestamps = extractIsoTimestamps(fail2banJournal);
      const sshTimestamps = extractIsoTimestamps(sshJournal);
      expect(fail2banTimestamps.length).toBeGreaterThan(0);
      expect(sshTimestamps.length).toBeGreaterThan(0);

      const merged = [...fail2banTimestamps, ...sshTimestamps].sort((a, b) => a - b);
      expect(merged[0]).toBeLessThanOrEqual(merged[merged.length - 1]);
    });
  });
});
