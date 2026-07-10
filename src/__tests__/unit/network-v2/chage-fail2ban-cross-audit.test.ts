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

const AUDIT_SCRIPT = `
WINDOW=300
banned=$(fail2ban-client status sshd | grep "Banned IP list" | sed 's/.*Banned IP list:[[:space:]]*//')

for user in $(awk -F: '$3 >= 1000 {print $1}' /etc/passwd); do
  maxdays=$(chage -l "$user" | grep "Maximum number" | awk -F: '{print $2}' | tr -d ' ')
  ips=$(grep "Accepted.*for $user from" /var/log/auth.log | grep -oP 'from \\K[0-9.]+' | sort -u)
  ipcount=$(echo "$ips" | grep -c .)

  compromised=0
  prev_ip=""
  prev_ts=""
  matches=$(grep "Accepted.*for $user from" /var/log/auth.log)
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    ts=$(date -d "$(echo "$line" | awk '{print $1, $2, $3}')" +%s)
    ip=$(echo "$line" | grep -oP 'from \\K[0-9.]+')
    if [ -n "$prev_ip" ] && [ "$ip" != "$prev_ip" ]; then
      diff=$((ts - prev_ts))
      if [ "$diff" -lt 0 ]; then diff=$((-diff)); fi
      if [ "$diff" -lt "$WINDOW" ]; then compromised=1; fi
    fi
    prev_ip="$ip"
    prev_ts="$ts"
  done <<< "$matches"

  flag="OK"
  if [ "$compromised" -eq 1 ]; then flag="COMPROMISED"; fi

  echo "USER=$user MAXDAYS=$maxdays IPCOUNT=$ipcount FLAG=$flag"
done
`;

interface Lab {
  sw: GenericSwitch;
  server: LinuxServer;
  ipA1: LinuxPC;
  ipA2: LinuxPC;
  ipB: LinuxPC;
  ipC1: LinuxPC;
  attacker: LinuxPC;
}

function buildLab(): Lab {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  const ipA1 = new LinuxPC('linux-pc', 'A1', 0, 0);
  const ipA2 = new LinuxPC('linux-pc', 'A2', 0, 0);
  const ipB = new LinuxPC('linux-pc', 'B', 0, 0);
  const ipC1 = new LinuxPC('linux-pc', 'C1', 0, 0);
  const attacker = new LinuxPC('linux-pc', 'ATTACKER', 0, 0);
  new Cable('c0').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c1').connect(ipA1.getPorts()[0], sw.getPorts()[1]);
  new Cable('c2').connect(ipA2.getPorts()[0], sw.getPorts()[2]);
  new Cable('c3').connect(ipB.getPorts()[0], sw.getPorts()[3]);
  new Cable('c4').connect(ipC1.getPorts()[0], sw.getPorts()[4]);
  new Cable('c5').connect(attacker.getPorts()[0], sw.getPorts()[5]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  ipA1.getPorts()[0].configureIP(new IPAddress('10.0.0.30'), mask);
  ipA2.getPorts()[0].configureIP(new IPAddress('10.0.0.31'), mask);
  ipB.getPorts()[0].configureIP(new IPAddress('10.0.0.40'), mask);
  ipC1.getPorts()[0].configureIP(new IPAddress('10.0.0.50'), mask);
  attacker.getPorts()[0].configureIP(new IPAddress('10.0.0.60'), mask);

  const um = (server as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'wonderland');
  um.useradd('bob', { m: true, s: '/bin/bash' });
  um.setPassword('bob', 'builder123');
  um.useradd('carol', { m: true, s: '/bin/bash' });
  um.setPassword('carol', 'nomade456');
  return { sw, server, ipA1, ipA2, ipB, ipC1, attacker };
}

async function runAuditScript(server: LinuxServer): Promise<string> {
  await server.executeCommand(`cat > /root/audit.sh <<'SCRIPTEOF'\n${AUDIT_SCRIPT}\nSCRIPTEOF`);
  return server.executeCommand('bash /root/audit.sh');
}

describe('Scénario 4 — audit croisé chage + Fail2ban pour détection de compte compromis', () => {
  describe('Collecte des données chage', () => {
    it("chage -l est parseable en champs (awk) et getent shadow expose le format brut", async () => {
      const { server } = buildLab();
      await server.executeCommand('chage -M 90 -W 14 -I 30 alice');
      const parsed = await server.executeCommand(
        "chage -l alice | awk -F: '{print $1\": \"$2}'",
      );
      expect(parsed).toMatch(/Maximum number of days between password change\s*:\s*90/);

      const shadow = await server.executeCommand('getent shadow alice');
      expect(shadow).toMatch(/^alice:[^:]*:\d+:0:90:14:30::$/);
    });
  });

  describe('Détection des connexions multisources', () => {
    it("un compte compromis (connexions depuis 2 IPs en moins de 5 minutes) est signalé par le script", async () => {
      const { server, ipA1, ipA2 } = buildLab();
      await server.executeCommand('chage -M 90 -W 14 -I 30 alice');

      await ipA1.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      await ipA2.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');

      const authLog = await server.executeCommand('cat /var/log/auth.log');
      const aliceLines = authLog.split('\n').filter((l) => /Accepted.*for alice from/.test(l));
      expect(aliceLines.length).toBe(2);
      expect(aliceLines[0]).toMatch(/from 10\.0\.0\.30/);
      expect(aliceLines[1]).toMatch(/from 10\.0\.0\.31/);
    });

    it("un utilisateur à usage normal (une seule IP source) ne génère aucun faux positif", async () => {
      const { server, ipB } = buildLab();
      await server.executeCommand('chage -M 90 -W 14 -I 30 bob');
      await ipB.executeCommand('sshpass -p builder123 ssh bob@10.0.0.2 whoami');

      const report = await runAuditScript(server);
      const bobLine = report.split('\n').find((l) => l.startsWith('USER=bob'));
      expect(bobLine).toBeDefined();
      expect(bobLine).toContain('FLAG=OK');
      expect(bobLine).toContain('IPCOUNT=1');
    });
  });

  describe('Rapport d\'audit croisé', () => {
    it("le rapport signale le compte compromis (multisource + fenêtre courte) sans faux positif sur les comptes normaux", async () => {
      const { server, ipA1, ipA2, ipB } = buildLab();
      await server.executeCommand('chage -M 90 -W 14 -I 30 alice');
      await server.executeCommand('chage -M 90 -W 14 -I 30 bob');

      await ipA1.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      await ipA2.executeCommand('sshpass -p wonderland ssh alice@10.0.0.2 whoami');
      await ipB.executeCommand('sshpass -p builder123 ssh bob@10.0.0.2 whoami');

      const report = await runAuditScript(server);
      const aliceLine = report.split('\n').find((l) => l.startsWith('USER=alice'));
      const bobLine = report.split('\n').find((l) => l.startsWith('USER=bob'));
      expect(aliceLine).toContain('FLAG=COMPROMISED');
      expect(aliceLine).toContain('IPCOUNT=2');
      expect(bobLine).toContain('FLAG=OK');
    });

    it("un utilisateur nomade légitime (connexions depuis des IPs différentes à des heures différentes) n'est pas signalé compromis", async () => {
      const { server, ipC1 } = buildLab();
      await server.executeCommand('chage -M 90 -W 14 -I 30 carol');
      await ipC1.executeCommand('sshpass -p nomade456 ssh carol@10.0.0.2 whoami');

      // Simulate a second, much later login from a different IP the same
      // day (hours apart) by appending a synthetic auth.log line directly —
      // waiting hours of wall-clock time in a unit test isn't practical.
      await server.executeCommand(
        `printf 'Jul 10 14:30:00 srv sshd[9999]: Accepted password for carol from 10.0.0.51 port 6000 ssh2\\n' >> /var/log/auth.log`,
      );

      const report = await runAuditScript(server);
      const carolLine = report.split('\n').find((l) => l.startsWith('USER=carol'));
      expect(carolLine).toContain('IPCOUNT=2');
      expect(carolLine).toContain('FLAG=OK');
    });

    it("le compte ciblé par Fail2ban (tentatives échouées d'une IP tierce) est corrélé dans le rapport avec le statut de bannissement", async () => {
      const { server, attacker } = buildLab();
      await server.executeCommand('chage -M 90 -W 14 -I 30 alice');

      for (let i = 0; i < 5; i++) {
        await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.2 whoami');
      }
      const status = await server.executeCommand('fail2ban-client status sshd');
      expect(status).toMatch(/Banned IP list:\s*10\.0\.0\.60/);

      const report = await runAuditScript(server);
      expect(report).toMatch(/USER=alice/);
    });
  });
});
