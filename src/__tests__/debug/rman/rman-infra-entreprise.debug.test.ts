/**
 * Suite de RELEVE (pas d'assertions de contrat) — `src/__tests__/debug/`.
 *
 * Elle monte l'infrastructure minimale d'une entreprise autour d'un
 * RMAN : deux LAN, un FortiGate entre eux, une politique qu'on ouvre
 * puis qu'on ferme, un serveur de base et un serveur de sauvegarde. Elle
 * sert a MESURER ce que RMAN fait dans ce decor, et son releve est cite
 * dans `docs/ASSESSMENT-RMAN.md` §4.
 *
 * Le releve du 2026-09-10 :
 *
 *   [A] ping sans politique        100% packet loss
 *   [B] ping, politique ACCEPT       0% packet loss
 *   [E] ping, politique DENY       100% packet loss     <- TEMOIN
 *   [C] RMAN @10.10.20.20, ouvert  connected to target database: ORCL
 *   [F] RMAN @10.10.20.20, FERME   connected to target database: ORCL
 *   [D] sessions du pare-feu       4 avant, 4 apres
 *   [G] BACKUP vers /mnt/backup_nfs  Finished backup
 *   [H] cote serveur de sauvegarde   No such file or directory
 *
 * Ce que le TEMOIN [E] rend opposable : le pare-feu bloque REELLEMENT le
 * trafic de ce laboratoire. Que [C] et [F] rendent la MEME reponse ne
 * peut donc pas s'expliquer par un pare-feu inerte — la connexion RMAN
 * n'existe pas, et un pare-feu ne bloque pas ce qui ne traverse rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  resetAllOracleInstances(); Logger.reset();
});

const sh = (s: LinuxServer, c: string) => s.executeShellCommandSync(c);

async function jouer(d: { executeCommand(c: string): Promise<string> }, l: string[]): Promise<string> {
  let out = '';
  for (const c of l) out = await d.executeCommand(c);
  return out;
}

describe('RMAN dans une infra d entreprise', () => {
  it('deux LAN, un pare-feu, des politiques', async () => {
    const notes: string[] = [];

    const fw = new FortiGate('firewall-fortinet', 'FGT-DC', 0, 0);
    const dbSrv = new LinuxServer('linux-server', 'ORA-PROD', -200, 0);
    const bkpSrv = new LinuxServer('linux-server', 'BACKUP-SRV', 200, 0);

    new Cable('lan-db').connect(dbSrv.getPort('eth0')!, fw.getPort('port1')!);
    new Cable('lan-bkp').connect(bkpSrv.getPort('eth0')!, fw.getPort('port2')!);

    await jouer(fw, [
      'config system interface',
      'edit port1', 'set mode static', 'set ip 10.10.10.1 255.255.255.0',
      'set allowaccess ping', 'next',
      'edit port2', 'set mode static', 'set ip 10.10.20.1 255.255.255.0',
      'set allowaccess ping', 'next', 'end',
    ]);
    sh(dbSrv, 'ip addr add 10.10.10.10/24 dev eth0');
    sh(dbSrv, 'ip link set eth0 up');
    sh(dbSrv, 'ip route add default via 10.10.10.1');
    sh(bkpSrv, 'ip addr add 10.10.20.20/24 dev eth0');
    sh(bkpSrv, 'ip link set eth0 up');
    sh(bkpSrv, 'ip route add default via 10.10.20.1');

    const perte = async () => (await pingOnSimulatedClock(dbSrv, 'ping -c 2 10.10.20.20'))
      .split('\n').filter((l) => /packet loss/.test(l)).join('').trim();
    notes.push(`[A] ping DB->BACKUP SANS politique : ${await perte()}`);

    await jouer(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end',
    ]);
    notes.push(`[B] ping apres politique ACCEPT : ${await perte()}`);

    SqlPlusSubShell.create(dbSrv, ['/', 'as', 'sysdba']).subShell.dispose();

    const sessionsAvant = fw.getSessionTable?.()?.count?.() ?? -1;
    const rmanDistant = sh(dbSrv, 'echo "CONNECT TARGET sys/oracle@10.10.20.20:1521/BKPCAT;" | rman');
    const sessionsApres = fw.getSessionTable?.()?.count?.() ?? -1;
    notes.push(`[C] RMAN vers une cible DISTANTE repond : ${
      rmanDistant.split('\n').filter(l => l.trim()).slice(-2).join(' | ')}`);
    notes.push(`[D] sessions vues par le pare-feu : avant=${sessionsAvant} apres=${sessionsApres}`);

    await jouer(fw, [
      'config firewall policy', 'edit 1', 'set action deny', 'next', 'end',
    ]);
    notes.push(`[E] TEMOIN — ping apres politique DENY : ${await perte()}`);
    const rmanBloque = sh(dbSrv, 'echo "CONNECT TARGET sys/oracle@10.10.20.20:1521/BKPCAT;" | rman');
    notes.push(`[F] RMAN vers la MEME cible, pare-feu FERME : ${
      rmanBloque.split('\n').filter(l => l.trim()).slice(-2).join(' | ')}`);

    const backupDistant = sh(dbSrv,
      'echo "BACKUP DATABASE FORMAT \'/mnt/backup_nfs/%U\';" | rman target /');
    notes.push(`[G] BACKUP vers un chemin distant : ${
      backupDistant.split('\n').filter(l => /Finished|RMAN-|piece/i.test(l)).slice(0, 3).join(' | ')}`);
    notes.push(`[H] le fichier existe-t-il cote BACKUP-SRV ? ${
      sh(bkpSrv, 'ls -l /mnt/backup_nfs 2>&1').trim().replace(/\n/g, ' / ')}`);

    writeFileSync('/tmp/mes/lab.txt', notes.join('\n') + '\n');
    expect(true).toBe(true);
  }, 180000);
});
