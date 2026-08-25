/**
 * Scénario 2 — Historique des connexions : last, lastb, et analyse des
 * patterns.
 *
 * `last`/`lastb` doivent produire un historique complet et cohérent des
 * connexions réussies et échouées — horodatage, source, type de session —
 * cohérent avec les fichiers binaires /var/log/wtmp et /var/log/btmp
 * sous-jacents.
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

describe('Scénario 2 — last / lastb : historique des connexions', () => {
  it('last liste une session SSH réussie : user, tty, ip, "still logged in"', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    const out = await srv.executeCommand('last');
    expect(out).toMatch(/alice\s+pts\/\d+\s+10\.0\.0\.1\s+\w{3} \w{3}\s+\d+ \d{2}:\d{2}\s+still logged in/);
  });

  it('last -n limite le nombre de lignes affichées', async () => {
    const { pc1, srv } = await buildLan();
    for (let i = 0; i < 3; i++) {
      await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    }
    const out = await srv.executeCommand('last -n 1');
    const sessionLines = out.split('\n').filter((l) => /^alice/.test(l));
    expect(sessionLines.length).toBe(1);
  });

  it('last <user> filtre par utilisateur', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    const out = await srv.executeCommand('last alice');
    expect(out).toContain('alice');
    expect(out).not.toMatch(/^mallory/m);
  });

  it('last -F affiche l\'heure complète avec secondes et année', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    const out = await srv.executeCommand('last -F');
    expect(out).toMatch(/alice.*\d{2}:\d{2}:\d{2} \d{4}/);
  });

  it('last se termine par la ligne "wtmp begins ..."', async () => {
    const { srv } = await buildLan();
    const out = await srv.executeCommand('last');
    expect(out).toMatch(/wtmp begins/);
  });

  it('un login SSH échoué (mauvais mot de passe) est tracé dans lastb, pas dans last', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('sshpass -p wrongpass ssh mallory@10.0.0.10 sleep 60');
    const lastOut = await srv.executeCommand('last');
    const lastbOut = await srv.executeCommand('sudo lastb');
    expect(lastbOut).toMatch(/mallory/);
    expect(lastOut).not.toMatch(/^mallory/m);
  });

  it('lastb -a affiche le nombre de tentatives par IP source', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('sshpass -p bad1 ssh mallory@10.0.0.10 sleep 60');
    const out = await srv.executeCommand("sudo lastb | awk '{print $3}' | sort | uniq -c");
    expect(out).toMatch(/10\.0\.0\.1/);
  });

  it('cohérence : la taille de /var/log/wtmp divisée par 384 correspond au nombre de lignes de last', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    const size = Number((await srv.executeCommand("stat -c '%s' /var/log/wtmp")).trim());
    const wtmpEntries = size / 384;
    const lastEntries = Number(
      (await srv.executeCommand("last | grep -v 'begins\\|^$' | wc -l")).trim(),
    );
    expect(Number.isInteger(wtmpEntries)).toBe(true);
    expect(wtmpEntries).toBe(lastEntries);
  });

  it('cohérence : la taille de /var/log/btmp divisée par 384 correspond au nombre de tentatives échouées', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('sshpass -p bad1 ssh mallory@10.0.0.10 sleep 60');
    await pc1.executeCommand('sshpass -p bad2 ssh mallory@10.0.0.10 sleep 60');
    const size = Number((await srv.executeCommand("stat -c '%s' /var/log/btmp")).trim());
    const btmpEntries = size / 384;
    const lastbEntries = Number(
      (await srv.executeCommand("sudo lastb | grep -v 'begins\\|^$' | wc -l")).trim(),
    );
    expect(btmpEntries).toBe(2);
    expect(btmpEntries).toBe(lastbEntries);
  });

  it('last reboot / last -x affiche l\'entrée de démarrage système', async () => {
    const { srv } = await buildLan();
    const out = await srv.executeCommand('last reboot');
    expect(out).toMatch(/reboot\s+system boot/);
  });
});
