/**
 * Scénario 10 — Audit croisé complet : corrélation des cinq familles de
 * commandes.
 *
 * Sessions (who/w/last), identité (id/whoami), processus (ps/pgrep),
 * fichiers de trace (lastlog), et comptes (getent/chage) doivent former
 * un tout cohérent : chaque utilisateur connecté est retrouvable dans
 * chacune des cinq sources sans contradiction.
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

async function buildActiveLan() {
  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c1').connect(pc1.getPorts()[0], srv.getPorts()[0]);
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.setPassword('alice', 'admin');
  um.setPassword('bob', 'admin');

  await srv.executeCommand('su - alice -c "sleep 300 &"');
  await srv.executeCommand('su - bob -c "sleep 300 &"');
  await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
  return { pc1, srv };
}

async function run(srv: LinuxServer, cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

describe('Scénario 10 — audit croisé : sessions, identité, processus, traces, comptes', () => {
  it('who et w rapportent le même nombre de sessions actives', async () => {
    const { srv } = await buildActiveLan();
    const whoN = Number((await run(srv, 'who | wc -l')).trim());
    const wN = Number((await run(srv, 'w -h | wc -l')).trim());
    expect(whoN).toBe(wN);
  });

  it('chaque utilisateur de who est retrouvable dans /etc/passwd via getent', async () => {
    const { srv } = await buildActiveLan();
    const users = (await run(srv, "who | awk '{print $1}' | sort -u")).split('\n').filter(Boolean);
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      const out = await run(srv, `getent passwd ${u} > /dev/null; echo "EXIT:$?"`);
      expect(out).toContain('EXIT:0');
    }
  });

  it('chaque utilisateur de who a au moins un processus dans ps/pgrep', async () => {
    const { srv } = await buildActiveLan();
    const users = (await run(srv, "who | awk '{print $1}' | sort -u")).split('\n').filter(Boolean);
    for (const u of users) {
      const count = Number((await run(srv, `pgrep -u ${u} | wc -l`)).trim());
      expect(count).toBeGreaterThan(0);
    }
  });

  it('les sessions "still logged in" de last correspondent aux utilisateurs de who', async () => {
    const { srv } = await buildActiveLan();
    const lastActive = (await run(srv, "last | grep 'still logged in' | awk '{print $1}' | sort -u"))
      .split('\n').filter(Boolean);
    const whoActive = (await run(srv, "who | awk '{print $1}' | sort -u"))
      .split('\n').filter(Boolean);
    expect(lastActive).toEqual(whoActive);
  });

  it('lastlog pour chaque utilisateur connecté correspond à la même IP source que last', async () => {
    const { srv } = await buildActiveLan();
    const users = (await run(srv, "who | awk '{print $1}' | sort -u")).split('\n').filter(Boolean);
    for (const u of users) {
      const lastlogOut = await run(srv, `lastlog -u ${u}`);
      const lastOut = await run(srv, `last -n 1 ${u}`);
      if (lastlogOut.includes('Never logged in')) continue;
      const lastlogIp = lastlogOut.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/)?.[1];
      const lastIp = lastOut.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/)?.[1];
      if (lastlogIp && lastIp) expect(lastlogIp).toBe(lastIp);
    }
  });

  it('aucun compte UID=0 autre que root (script d\'audit, section anomalies)', async () => {
    const { srv } = await buildActiveLan();
    const out = await run(srv, "awk -F: '$3==0 && $1!=\"root\" {print $1}' /etc/passwd");
    expect(out.trim()).toBe('');
  });

  it('script d\'audit complet : zéro anomalie sur une machine correctement configurée', async () => {
    const { srv } = await buildActiveLan();
    await srv.executeCommand(String.raw`cat << 'AUDIT' > /tmp/audit-users.sh
#!/bin/bash
ANOMALIES=0

UID0=$(awk -F: '$3==0 && $1!="root" {print $1}' /etc/passwd)
[ -n "$UID0" ] && ANOMALIES=$((ANOMALIES+1))

who | awk '{print $1}' | sort -u | while read user; do
  getent passwd "$user" > /dev/null 2>&1 || echo "ANOMALIE"
done > /tmp/audit-passwd-check.txt
[ -s /tmp/audit-passwd-check.txt ] && ANOMALIES=$((ANOMALIES+1))

who | awk '{print $1}' | sort -u | while read user; do
  COUNT=$(pgrep -u "$user" 2>/dev/null | wc -l)
  [ "$COUNT" -eq 0 ] && echo "ANOMALIE"
done > /tmp/audit-proc-check.txt
[ -s /tmp/audit-proc-check.txt ] && ANOMALIES=$((ANOMALIES+1))

exit $ANOMALIES
AUDIT
chmod +x /tmp/audit-users.sh`);
    const out = await run(srv, 'bash /tmp/audit-users.sh; echo "EXIT:$?"');
    expect(out).toContain('EXIT:0');
  });

  it('script d\'audit détecte une anomalie réelle : compte UID=0 non-root', async () => {
    const { srv } = await buildActiveLan();
    await run(srv, "echo 'rogue:x:0:0:rogue:/root:/bin/bash' >> /etc/passwd");
    const out = await run(srv, "awk -F: '$3==0 && $1!=\"root\" {print $1}' /etc/passwd");
    expect(out.trim()).toBe('rogue');
  });
});
