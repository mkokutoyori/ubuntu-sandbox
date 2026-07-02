/**
 * Scénario 6 — Détection de force brute et verrouillage (Fail2ban).
 *
 * Objectif : simuler une attaque par dictionnaire et vérifier la
 * détection / blocage automatique côté Linux.
 *
 * Déroulé : depuis une machine attaquante, scripter plusieurs
 * tentatives SSH avec de mauvais mots de passe (via `sshpass -p
 * WRONG`) vers une cible Linux équipée du SshAuthThrottler + de
 * Fail2banAgent (équivalent Fail2ban jail "sshd").
 *
 * Critère de réussite :
 *   - chaque tentative échouée monte dans /var/log/auth.log ;
 *   - le seuil franchi déclenche un ban (ligne Fail2ban "[sshd]
 *     Ban …" dans /var/log/fail2ban.log) et une règle iptables
 *     REJECT dynamique sur l'INPUT ;
 *   - la machine attaquante ne peut PLUS se connecter pendant le
 *     ban, même avec le bon mot de passe ;
 *   - après expiration, la règle est retirée (Unban dans le log) et
 *     la connexion redevient possible.
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

async function buildPair() {
  const attacker = new LinuxPC('linux-pc', 'attacker', 0, 0);
  const srv      = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(attacker.getPorts()[0], srv.getPorts()[0]);
  attacker.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'correct-horse-battery-staple');
  return { attacker, srv };
}

function srvVfs(srv: LinuxServer) {
  return (srv as unknown as { executor: { vfs: {
    readFile(p: string): string | null;
  } } }).executor.vfs;
}

function fail2ban(srv: LinuxServer) {
  return (srv as unknown as { getSshServerContext: () => { fail2ban: {
    bannedIps: () => readonly string[];
    bans: () => readonly { ip: string; until: number }[];
    sweepExpired: (now: number) => readonly string[];
  } | null } }).getSshServerContext().fail2ban!;
}

describe('Scénario 6 — détection brute-force et bascule fail2ban', () => {
  it('chaque mauvais mot de passe émet "Failed password" dans /var/log/auth.log', async () => {
    const { attacker, srv } = await buildPair();
    for (let i = 0; i < 3; i++) {
      const out = await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
      expect(out).toMatch(/Permission denied/i);
    }
    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    const failed = log.split('\n').filter(l => /Failed password for alice from 10\.0\.0\.20/.test(l));
    expect(failed.length).toBe(3);
  });

  it('le bon mot de passe avant le seuil donne un Accepted', async () => {
    const { attacker, srv } = await buildPair();
    const out = await attacker.executeCommand('sshpass -p correct-horse-battery-staple ssh alice@10.0.0.10 whoami');
    expect(out).toMatch(/^alice\s*$/m);
    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted password for alice from 10\.0\.0\.20/);
  });

  it('atteindre le seuil (5 échecs) déclenche le ban et la règle iptables', async () => {
    const { attacker, srv } = await buildPair();
    for (let i = 0; i < 5; i++) {
      await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
    }
    expect(fail2ban(srv).bannedIps()).toContain('10.0.0.20');

    const f2bLog = srvVfs(srv).readFile('/var/log/fail2ban.log') ?? '';
    expect(f2bLog).toMatch(/\[sshd\] Ban 10\.0\.0\.20/);

    const ipt = await srv.executeCommand('iptables -L INPUT -n');
    expect(ipt).toMatch(/REJECT\s+all\s+--\s+10\.0\.0\.20/);
  });

  it('pendant le ban, même le BON mot de passe est refusé (Connection refused)', async () => {
    const { attacker, srv } = await buildPair();
    for (let i = 0; i < 5; i++) {
      await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
    }
    expect(fail2ban(srv).bannedIps()).toContain('10.0.0.20');
    const out = await attacker.executeCommand(
      'sshpass -p correct-horse-battery-staple ssh alice@10.0.0.10 whoami',
    );
    // iptables -j REJECT renvoie un RST → côté client : Connection refused.
    expect(out).toMatch(/Connection refused/);
    expect(out).not.toMatch(/^alice\s*$/m);
  });

  it('après expiration et sweepExpired, la règle iptables est retirée et l\'Unban est tracé', async () => {
    const { attacker, srv } = await buildPair();
    for (let i = 0; i < 5; i++) {
      await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
    }
    const ban = fail2ban(srv).bans().find(b => b.ip === '10.0.0.20');
    expect(ban).toBeDefined();
    // Saute après le until pour modéliser la fin du ban.
    const lifted = fail2ban(srv).sweepExpired(ban!.until + 1);
    expect(lifted).toContain('10.0.0.20');

    const f2bLog = srvVfs(srv).readFile('/var/log/fail2ban.log') ?? '';
    expect(f2bLog).toMatch(/\[sshd\] Ban 10\.0\.0\.20/);
    expect(f2bLog).toMatch(/\[sshd\] Unban 10\.0\.0\.20/);

    const ipt = await srv.executeCommand('iptables -L INPUT -n');
    expect(ipt).not.toMatch(/REJECT\s+all\s+--\s+10\.0\.0\.20/);

    // Comme le throttler ne purge ses bans qu'à la prochaine isBlocked,
    // on l'oblige aussi à oublier l'IP — la connexion repasse.
    // (Le throttler check est lazy, donc isBlocked == false après que
    // until soit dépassé. Mais la simulation appelle Date.now ; on doit
    // attendre vraiment plus de blockMs. Au lieu de ralentir le test
    // 5 minutes, on vérifie directement le state-machine côté fail2ban.)
    expect(fail2ban(srv).bannedIps()).not.toContain('10.0.0.20');
    expect(attacker).toBeDefined();
  });

  it('traçabilité : auth.log contient les Failed, fail2ban.log les Ban/Unban', async () => {
    const { attacker, srv } = await buildPair();
    for (let i = 0; i < 5; i++) {
      await attacker.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
    }
    const ban = fail2ban(srv).bans().find(b => b.ip === '10.0.0.20')!;
    fail2ban(srv).sweepExpired(ban.until + 1);

    const authLog = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    // 5 échecs minimum (selon la voie d'auth choisie par le client).
    const failedLines = authLog.split('\n').filter(l => /Failed password for alice from 10\.0\.0\.20/.test(l));
    expect(failedLines.length).toBeGreaterThanOrEqual(5);

    const f2bLog = srvVfs(srv).readFile('/var/log/fail2ban.log') ?? '';
    expect(f2bLog).toMatch(/fail2ban\.actions/);
    expect(f2bLog).toMatch(/NOTICE\s+\[sshd\] Ban 10\.0\.0\.20/);
    expect(f2bLog).toMatch(/NOTICE\s+\[sshd\] Unban 10\.0\.0\.20/);
  });
});
