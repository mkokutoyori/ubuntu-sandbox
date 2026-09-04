/**
 * Scénario 1 — Commandes de session actives : who, w, et cohérence des
 * informations.
 *
 * `who`/`w` doivent refléter fidèlement l'état des sessions actives —
 * utilisateur, terminal, heure de connexion, source — avec des
 * informations strictement cohérentes entre les deux commandes et avec
 * l'état réel du système (/dev/pts, /proc).
 */
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

async function buildLan() {
  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'pc2', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(pc2.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(srv.getPorts()[0], sw.getPorts()[2]);
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.setPassword('alice', 'admin');
  um.setPassword('bob', 'admin');
  return { pc1, pc2, srv };
}

describe('Scénario 1 — who / w : sessions actives', () => {
  it('who liste user/terminal/heure/(ip) pour chaque session SSH active', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    const out = await srv.executeCommand('who');
    expect(out).toMatch(/alice\s+pts\/\d+\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(10\.0\.0\.1\)/);
  });

  it('who -q affiche les noms uniques et le total', async () => {
    const { pc1, pc2, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    await pc2.executeCommand('ssh bob@10.0.0.10 sleep 60');
    const out = await srv.executeCommand('who -q');
    expect(out).toContain('alice');
    expect(out).toContain('bob');
    expect(out).toMatch(/# users=\d+/);
  });

  it('who -H affiche un en-tête de colonnes', async () => {
    const { srv } = await buildLan();
    const out = await srv.executeCommand('who -H');
    expect(out).toMatch(/^NAME\s+LINE\s+TIME/);
  });

  it('who -b affiche l\'heure de démarrage, cohérente avec uptime -s', async () => {
    const { srv } = await buildLan();
    const whoB = await srv.executeCommand('who -b');
    const uptimeS = await srv.executeCommand('uptime -s');
    expect(whoB).toMatch(/system boot\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    const whoDate = whoB.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1];
    expect(uptimeS.trim().slice(0, 16)).toBe(whoDate);
  });

  it('who | wc -l compte les sessions pts actives + la console locale', async () => {
    const { pc1, pc2, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    await pc2.executeCommand('ssh bob@10.0.0.10 sleep 60');
    const whoCount = Number((await srv.executeCommand('who | wc -l')).trim());
    const ptsCount = Number((await srv.executeCommand("ls -1 /dev/pts/ | grep -v ptmx | wc -l")).trim());
    // who compte aussi la console locale (tty1), absente de /dev/pts/.
    expect(whoCount).toBe(ptsCount + 1);
    expect(ptsCount).toBe(2);
  });

  it('chaque terminal listé par who existe réellement sous /dev/', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    const who = await srv.executeCommand('who');
    const ttys = who.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]);
    for (const tty of ttys) {
      const exists = await srv.executeCommand(`[ -e /dev/${tty} ] && echo yes || echo no`);
      expect(exists.trim()).toBe('yes');
    }
  });

  it('w affiche l\'en-tête uptime/load puis une ligne par session', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    const out = await srv.executeCommand('w');
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/up.*load average:/);
    expect(lines[1]).toMatch(/USER\s+TTY\s+FROM\s+LOGIN@\s+IDLE\s+JCPU\s+PCPU\s+WHAT/);
    expect(out).toMatch(/alice\s+pts\/\d+\s+10\.0\.0\.1/);
  });

  it('who et w rapportent le même nombre de sessions', async () => {
    const { pc1, pc2, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    await pc2.executeCommand('ssh bob@10.0.0.10 sleep 60');
    const whoCount = Number((await srv.executeCommand('who | wc -l')).trim());
    const wCount = Number((await srv.executeCommand('w -h | wc -l')).trim());
    expect(whoCount).toBe(wCount);
  });

  it('who -a inclut boot, runlevel et la liste des sessions', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60');
    const out = await srv.executeCommand('who -a');
    expect(out).toMatch(/system boot/);
    expect(out).toMatch(/run-level/);
    expect(out).toMatch(/alice/);
  });
});
