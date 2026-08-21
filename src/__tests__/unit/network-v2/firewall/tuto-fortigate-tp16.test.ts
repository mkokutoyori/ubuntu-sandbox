import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await srvDmz.executeCommand('systemctl start nginx');

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'edit "NET-DMZ"', 'set subnet 192.168.20.0 255.255.255.0', 'next',
    'end',
    'config firewall policy', 'edit 2',
    'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'set logtraffic all', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

async function comptes(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config user local',
    'edit "marie.durand"', 'set type password',
    'set passwd "Direction2026!"', 'set status enable', 'next',
    'edit "paul.stagiaire"', 'set type password',
    'set passwd "Stagiaire2026!"', 'set status enable', 'next',
    'end',
    'config user group',
    'edit "GRP-Direction"', 'set member "marie.durand"', 'next',
    'edit "GRP-Stagiaires"', 'set member "paul.stagiaire"', 'next',
    'end',
  ]);
}

async function seConnecter(
  pcLan: LinuxPC, utilisateur: string, motDePasse: string,
): Promise<string> {
  return pcLan.executeCommand(
    `curl -sS -d "username=${utilisateur}&password=${motDePasse}" `
    + 'http://192.168.10.1:1000/');
}

describe('TP 16 — une politique qui parle de personnes', () => {
  it('etape 1 et 2 : les comptes locaux et les groupes se declarent', async () => {
    const { fgt } = await laboratoire();
    propre(await comptes(fgt));

    const users = await fgt.executeCommand('show user local');
    expect(users).toContain('edit "marie.durand"');
    expect(users).toContain('set type password');
    expect(users).not.toContain('Direction2026!');

    const groups = await fgt.executeCommand('show user group');
    expect(groups).toContain('edit "GRP-Direction"');
    expect(groups).toContain('set member "marie.durand"');
  });

  it('etape 3 : `set groups` rend la politique AUTHENTIFIEE', async () => {
    const { fgt } = await laboratoire();
    await comptes(fgt);
    propre(await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set groups "GRP-Direction" "GRP-Stagiaires"', 'next', 'end',
    ]));

    const conf = await fgt.executeCommand('show firewall policy 2');
    expect(conf).toContain('set groups "GRP-Direction" "GRP-Stagiaires"');
  });

  it('etape 3 : un groupe INCONNU est refuse', async () => {
    const { fgt } = await laboratoire();
    const vu = await fgt.executeCommand('config firewall policy');
    expect(vu).not.toMatch(/Unknown action/i);
    await fgt.executeCommand('edit 2');
    const refus = await fgt.executeCommand('set groups "GRP-Absent"');
    await taper(fgt, ['next', 'end']);

    expect(refus).toMatch(/Command fail|entry not found|does not exist/i);
  });

  it('etape 4 : les reglages du portail se declarent', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config user setting',
      'set auth-timeout 480',
      'set auth-timeout-type idle-timeout',
      'set auth-secure-http enable',
      'end',
    ]));

    const conf = await fgt.executeCommand('show user setting');
    expect(conf).toContain('set auth-timeout 480');
    expect(conf).toContain('set auth-secure-http enable');
  });

  it('etape 4 : `auth-secure-http` redirige la page de connexion vers HTTPS', async () => {
    const { fgt, pcLan } = await laboratoire();
    await comptes(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2', 'set groups "GRP-Direction"', 'next', 'end',
    ]);

    const clair = await pcLan.executeCommand('curl -sS -i http://192.168.20.10/');
    expect(clair).toMatch(/Location: http:\/\/192\.168\.10\.1:1000\//);

    await taper(fgt, [
      'config user setting', 'set auth-secure-http enable', 'end',
    ]);

    const sur = await pcLan.executeCommand('curl -sS -i http://192.168.20.10/');
    expect(sur).toMatch(/Location: https:\/\/192\.168\.10\.1:1003\//);
  });

  it('etape 5 : un non-authentifie est REDIRIGE vers le portail', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await comptes(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2', 'set groups "GRP-Direction"', 'next', 'end',
    ]);

    const vu = await pcLan.executeCommand('curl -sS -i http://192.168.20.10/');
    expect(vu).toMatch(/303|302|Location:|Authentication required/i);
    expect(vu).not.toContain('Welcome to nginx!');
    expect(srvDmz.getName()).toBe('SRV-DMZ');
  });

  it('etape 6 : `diagnose firewall auth list` associe une adresse a une PERSONNE',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await comptes(fgt);
      await taper(fgt, [
        'config firewall policy', 'edit 2', 'set groups "GRP-Direction"', 'next', 'end',
      ]);
      await pcLan.executeCommand('curl -sS http://192.168.20.10/');

      const avant = await fgt.executeCommand('diagnose firewall auth list');
      expect(avant).not.toContain('marie.durand');

      const bienvenue = await seConnecter(pcLan, 'marie.durand', 'Direction2026!');
      expect(bienvenue).toMatch(/Authentication successful/i);

      const vue = await fgt.executeCommand('diagnose firewall auth list');
      expect(vue).toContain('192.168.10.10');
      expect(vue).toContain('marie.durand');
      expect(vue).toContain('GRP-Direction');
    });

  it('etape 4 : `auth-timeout-type` decide si le trafic REPOUSSE l\'expiration',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await comptes(fgt);
      await taper(fgt, [
        'config user setting', 'set auth-timeout 480',
        'set auth-timeout-type idle-timeout', 'end',
        'config firewall policy', 'edit 2', 'set groups "GRP-Direction"', 'next', 'end',
      ]);
      expect(fgt.getIdentityTable().timeoutPolicy())
        .toEqual({ type: 'idle-timeout', seconds: 480 * 60 });

      await seConnecter(pcLan, 'marie.durand', 'Direction2026!');
      const identite = fgt.getIdentityTable().lookup('192.168.10.10')!;
      const avant = identite.expiresAt;

      fgt.getIdentityTable().touch('192.168.10.10', 'in', 84);
      expect(identite.expiresAt).toBeGreaterThanOrEqual(avant);

      await taper(fgt, [
        'config user setting', 'set auth-timeout-type hard-timeout', 'end',
      ]);
      const fige = fgt.getIdentityTable().lookup('192.168.10.10')!.expiresAt;
      fgt.getIdentityTable().touch('192.168.10.10', 'in', 84);
      expect(fgt.getIdentityTable().lookup('192.168.10.10')!.expiresAt).toBe(fige);
    });

  it('etape 6 : la vue rend l\'expiration et le delai d\'inactivite', async () => {
    const { fgt, pcLan } = await laboratoire();
    await comptes(fgt);
    await taper(fgt, [
      'config user setting', 'set auth-timeout 480', 'end',
      'config firewall policy', 'edit 2', 'set groups "GRP-Direction"', 'next', 'end',
    ]);
    await seConnecter(pcLan, 'marie.durand', 'Direction2026!');

    const vue = await fgt.executeCommand('diagnose firewall auth list');
    expect(vue).toMatch(/expire: \d+, allow-idle: 28800/);
    expect(vue).toContain('----- 1 listed, 0 filtered ------');
  });

  it('etape 7 et 8 : la MEME machine se comporte selon QUI est connecte', async () => {
    const { fgt, pcLan } = await laboratoire();
    await comptes(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set groups "GRP-Direction" "GRP-Stagiaires"', 'next', 'end',
      'config firewall policy', 'edit 4',
      'set name "Stagiaires-restreints"',
      'set srcintf "port2"', 'set dstintf "port3"',
      'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
      'set groups "GRP-Stagiaires"',
      'set service "PING"', 'set schedule "always"',
      'set action deny', 'set logtraffic all', 'next',
      'move 4 before 2', 'end',
    ]);

    await seConnecter(pcLan, 'paul.stagiaire', 'Stagiaire2026!');
    const stagiaire = await pingOnSimulatedClock(pcLan, 'ping -c 2 -W 1 192.168.20.10');
    expect(stagiaire).toMatch(/100% packet loss/);

    await fgt.executeCommand('diagnose firewall auth clear');
    await seConnecter(pcLan, 'marie.durand', 'Direction2026!');
    const direction = await pingOnSimulatedClock(pcLan, 'ping -c 2 -W 1 192.168.20.10');
    expect(direction).toMatch(/, 0% packet loss/);
  });

  it('etape 8 : `diagnose firewall auth clear` vide vraiment la table', async () => {
    const { fgt, pcLan } = await laboratoire();
    await comptes(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2', 'set groups "GRP-Direction"', 'next', 'end',
    ]);
    await seConnecter(pcLan, 'marie.durand', 'Direction2026!');
    expect(await fgt.executeCommand('diagnose firewall auth list'))
      .toContain('marie.durand');

    const vide = await fgt.executeCommand('diagnose firewall auth clear');
    expect(vide).not.toMatch(/Unknown action|command parse error/i);
    expect(await fgt.executeCommand('diagnose firewall auth list'))
      .not.toContain('marie.durand');
  });

  it('etape 9 : le journal porte le champ `user`, et il DISCRIMINE', async () => {
    const { fgt, pcLan } = await laboratoire();
    await comptes(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set groups "GRP-Direction"',
      'set logtraffic all', 'set logtraffic-start enable', 'next', 'end',
    ]);
    await seConnecter(pcLan, 'marie.durand', 'Direction2026!');
    await pingOnSimulatedClock(pcLan, 'ping -c 2 -W 1 192.168.20.10');

    await taper(fgt, [
      'execute log filter category 0',
      'execute log filter field user "marie.durand"',
    ]);
    const journal = await fgt.executeCommand('execute log display');
    expect(journal).toContain('user="marie.durand"');
    expect(journal).toContain('group="GRP-Direction"');
    expect(journal).toContain('authserver="local"');

    await fgt.executeCommand('execute log filter field user "paul.stagiaire"');
    expect(await fgt.executeCommand('execute log display'))
      .toBe('No matching log data.');
  });

  it('une politique authentifiee que l\'utilisateur ne satisfait pas TOMBE sur la suivante',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await comptes(fgt);
      await taper(fgt, [
        'config firewall policy', 'edit 1',
        'set name "Direction-seule"',
        'set srcintf "port2"', 'set dstintf "port3"',
        'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
        'set groups "GRP-Direction"',
        'set service "ALL"', 'set schedule "always"',
        'set action deny', 'next',
        'move 1 before 2', 'end',
      ]);

      await seConnecter(pcLan, 'paul.stagiaire', 'Stagiaire2026!');
      const stagiaire = await pingOnSimulatedClock(pcLan, 'ping -c 2 -W 1 192.168.20.10');
      expect(stagiaire).toMatch(/, 0% packet loss/);

      await fgt.executeCommand('diagnose firewall auth clear');
      await seConnecter(pcLan, 'marie.durand', 'Direction2026!');
      const direction = await pingOnSimulatedClock(pcLan, 'ping -c 2 -W 1 192.168.20.10');
      expect(direction).toMatch(/100% packet loss/);
    });

  it('un NON authentifie ne peut correspondre qu\'a une politique SANS groupe',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await comptes(fgt);
      await taper(fgt, [
        'config firewall policy', 'edit 1',
        'set name "Authentifiee"',
        'set srcintf "port2"', 'set dstintf "port3"',
        'set srcaddr "NET-LAN"', 'set dstaddr "NET-DMZ"',
        'set groups "GRP-Direction"',
        'set service "ALL"', 'set schedule "always"',
        'set action accept', 'next',
        'move 1 before 2', 'end',
      ]);

      const sansCompte = await pingOnSimulatedClock(pcLan, 'ping -c 2 -W 1 192.168.20.10');
      expect(sansCompte).toMatch(/, 0% packet loss/);
    });

  it('etape 10 : `unset groups` rend la politique a tout le monde', async () => {
    const { fgt, pcLan } = await laboratoire();
    await comptes(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2', 'set groups "GRP-Direction"', 'next', 'end',
    ]);
    const bloque = await pingOnSimulatedClock(pcLan, 'ping -c 2 -W 1 192.168.20.10');
    expect(bloque).toMatch(/100% packet loss/);

    propre(await taper(fgt, [
      'config firewall policy', 'edit 2', 'unset groups', 'next', 'end',
    ]));
    expect(await fgt.executeCommand('show firewall policy 2'))
      .not.toContain('set groups');

    const passe = await pingOnSimulatedClock(pcLan, 'ping -c 2 -W 1 192.168.20.10');
    expect(passe).toMatch(/, 0% packet loss/);
  });
});
