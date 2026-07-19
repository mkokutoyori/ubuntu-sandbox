/**
 * Scénario 6 — Fichiers de trace binaires : /var/log/wtmp, /var/log/btmp,
 * /var/log/lastlog.
 *
 * wtmp/btmp doivent avoir une taille qui scale par blocs de 384 octets
 * (comme le vrai struct utmp) — mise à jour en temps réel à chaque
 * connexion/déconnexion/tentative échouée — avec des permissions plus
 * restrictives sur btmp (600, root uniquement) que sur wtmp (644).
 *
 * Note de fidélité : /var/log/lastlog reste un fichier normal (pas
 * sparse) dans ce simulateur — voir scenario-session-03-lastlog pour le
 * détail de cette limitation assumée.
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

async function buildLan() {
  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c1').connect(pc1.getPorts()[0], srv.getPorts()[0]);
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    setPassword(u: string, p: string): void;
    useradd(u: string, o?: object): void;
  } } }).executor.userMgr;
  um.setPassword('alice', 'admin');
  um.useradd('mallory', { m: true, s: '/bin/bash' });
  um.setPassword('mallory', 'x');
  return { pc1, srv };
}

describe('Scénario 6 — /var/log/wtmp, btmp, lastlog : fichiers binaires', () => {
  it('/var/log/wtmp existe dès le boot, taille multiple exact de 384', async () => {
    const { srv } = await buildLan();
    const size = Number((await srv.executeCommand("stat -c '%s' /var/log/wtmp")).trim());
    expect(size % 384).toBe(0);
    expect(size).toBeGreaterThan(0);
  });

  it('une connexion SSH augmente la taille de wtmp d\'exactement 384 octets', async () => {
    const { pc1, srv } = await buildLan();
    const before = Number((await srv.executeCommand("stat -c '%s' /var/log/wtmp")).trim());
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
    const after = Number((await srv.executeCommand("stat -c '%s' /var/log/wtmp")).trim());
    expect(after - before).toBe(384);
  });

  it('trois connexions SSH ajoutent exactement 3*384 octets à wtmp', async () => {
    const { pc1, srv } = await buildLan();
    const before = Number((await srv.executeCommand("stat -c '%s' /var/log/wtmp")).trim());
    for (let i = 0; i < 3; i++) await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
    const after = Number((await srv.executeCommand("stat -c '%s' /var/log/wtmp")).trim());
    expect(after - before).toBe(3 * 384);
  });

  it('/var/log/btmp est absent/vide avant toute tentative échouée', async () => {
    const { srv } = await buildLan();
    const size = Number((await srv.executeCommand("stat -c '%s' /var/log/btmp")).trim());
    expect(size).toBe(0);
  });

  it('une tentative SSH échouée peuple btmp avec exactement une entrée de 384 octets', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('sshpass -p wrongpass ssh mallory@10.0.0.10 whoami');
    const size = Number((await srv.executeCommand("stat -c '%s' /var/log/btmp")).trim());
    expect(size).toBe(384);
  });

  it('btmp est en 0600 (root uniquement) — plus restrictif que wtmp en 0644', async () => {
    const { srv } = await buildLan();
    const wtmpPerm = (await srv.executeCommand("stat -c '%a' /var/log/wtmp")).trim();
    const btmpPerm = (await srv.executeCommand("stat -c '%a' /var/log/btmp")).trim();
    expect(wtmpPerm).toBe('644');
    expect(btmpPerm).toBe('600');
  });

  it('un utilisateur non-root ne peut pas lire /var/log/btmp directement (mode 0600)', async () => {
    const { srv } = await buildLan();
    await srv.executeCommand('useradd -m -s /bin/bash plainuser');
    const out = await srv.executeCommand('su - plainuser -c "cat /var/log/btmp"');
    expect(out).toMatch(/Permission denied/);
  });

  it('lastb en root fonctionne normalement', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('sshpass -p wrongpass ssh mallory@10.0.0.10 whoami');
    const out = await srv.executeCommand('lastb');
    expect(out).toContain('mallory');
  });

  it('/var/log/lastlog existe et contient au moins l\'entrée root', async () => {
    const { srv } = await buildLan();
    expect(await srv.executeCommand('[ -e /var/log/lastlog ] && echo yes')).toContain('yes');
    const out = await srv.executeCommand('lastlog -u root');
    expect(out).not.toMatch(/Unknown user/);
  });

  it('cohérence globale : nombre d\'entrées wtmp/384 == nombre de lignes last (hors footer)', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
    const size = Number((await srv.executeCommand("stat -c '%s' /var/log/wtmp")).trim());
    const lastCount = Number(
      (await srv.executeCommand("last | grep -v 'begins\\|^$' | wc -l")).trim(),
    );
    expect(size / 384).toBe(lastCount);
  });
});
