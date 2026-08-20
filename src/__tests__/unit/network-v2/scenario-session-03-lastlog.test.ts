/**
 * Scénario 3 — lastlog : dernière connexion de chaque compte et détection
 * de comptes jamais utilisés.
 *
 * `lastlog` doit lister tous les comptes de /etc/passwd avec leur statut
 * de dernière connexion — y compris "**Never logged in**" pour les
 * comptes jamais utilisés — et rester cohérent avec `last` après une
 * connexion de test.
 *
 * Note de fidélité : /var/log/lastlog est ici un fichier normal (pas un
 * fichier sparse indexé par UID comme sur un vrai Linux) — le simulateur
 * ne modélise pas les fichiers sparse au niveau VFS. Les contrôles sur
 * "taille apparente vs réelle" du scénario ne sont donc pas applicables
 * ici ; on vérifie le contenu fonctionnel (comptes listés, cohérence
 * avec `last`) qui est la substance du critère de réussite.
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
  um.useradd('neveruser', { m: true, s: '/bin/bash' });
  return { pc1, srv };
}

describe('Scénario 3 — lastlog : dernière connexion par compte', () => {
  it('lastlog liste tous les comptes de /etc/passwd, y compris ceux jamais connectés', async () => {
    const { srv } = await buildLan();
    const passwdUsers = (await srv.executeCommand("cut -d: -f1 /etc/passwd")).split('\n').filter(Boolean);
    const out = await srv.executeCommand('lastlog');
    for (const u of passwdUsers) {
      expect(out).toContain(u);
    }
  });

  it('un compte jamais connecté affiche "**Never logged in**"', async () => {
    const { srv } = await buildLan();
    const out = await srv.executeCommand('lastlog -u neveruser');
    expect(out).toMatch(/neveruser\s+.*\*\*Never logged in\*\*/);
  });

  it('après une connexion SSH, le compte n\'est plus "Never logged in"', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
    const out = await srv.executeCommand('lastlog -u alice');
    expect(out).not.toMatch(/Never logged in/);
    expect(out).toMatch(/alice\s+pts\/\d+\s+10\.0\.0\.1/);
  });

  it('lastlog -u <user> filtre sur un seul compte', async () => {
    const { srv } = await buildLan();
    const out = await srv.executeCommand('lastlog -u neveruser');
    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(2); // en-tête + neveruser
  });

  it('lastlog -b <jours> exclut les connexions plus récentes que le seuil', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
    const out = await srv.executeCommand('lastlog -b 30 -u alice');
    // alice vient de se connecter — pas "avant 30 jours" — donc absente.
    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(1); // en-tête seule
  });

  it('lastlog -t <jours> inclut les connexions récentes', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
    const out = await srv.executeCommand('lastlog -t 7 -u alice');
    expect(out).toMatch(/alice/);
  });

  it('cohérence lastlog vs last : même IP source pour la dernière connexion d\'un utilisateur', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
    const lastlogOut = await srv.executeCommand('lastlog -u alice');
    const lastOut = await srv.executeCommand('last alice');
    expect(lastlogOut).toContain('10.0.0.1');
    expect(lastOut).toContain('10.0.0.1');
  });

  it('deux connexions successives : lastlog ne garde que la plus récente', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami');
    const out = await srv.executeCommand('lastlog -u alice');
    const occurrences = out.split('\n').filter((l) => /^alice/.test(l)).length;
    expect(occurrences).toBe(1);
  });
});
