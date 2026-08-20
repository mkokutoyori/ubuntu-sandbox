import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

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
    'config firewall policy', 'edit 2',
    'set name "LAN-vers-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"',
    'set action accept', 'set logtraffic all', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

async function listeUrl(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config webfilter urlfilter', 'edit 1',
    'set name "Liste-Locale-Lab"',
    'config entries',
    'edit 1', 'set url "example.com"', 'set type simple', 'set action block', 'next',
    'edit 2', 'set url "*.example.org"', 'set type wildcard', 'set action block', 'next',
    'end', 'next', 'end',
  ]);
}

async function profilWeb(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config webfilter profile', 'edit "WF-Lab"',
    'set feature-set flow',
    'set comment "Filtrage du laboratoire"',
    'config web', 'set urlfilter-table 1', 'end',
    'set log-all-url enable',
    'next', 'end',
  ]);
}

async function profilFichiers(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config file-filter profile', 'edit "FF-Lab"',
    'set feature-set flow',
    'set log enable',
    'config rules', 'edit "Bloquer-Executables"',
    'set protocol http-get http-post',
    'set action block',
    'set direction any',
    'set file-type "exe" "msi"',
    'next', 'end',
    'next', 'end',
  ]);
}

describe('TP 12 — bloquer pour de vrai, sans licence', () => {
  it('etape 1 : une liste d\'URL locale se declare et se relit', async () => {
    const { fgt } = await laboratoire();
    propre(await listeUrl(fgt));
    const conf = await fgt.executeCommand('show webfilter urlfilter');
    expect(conf).toContain('set name "Liste-Locale-Lab"');
    expect(conf).toContain('set url "example.com"');
    expect(conf).toContain('set type wildcard');
    expect(conf).toContain('set action block');
  });

  it('etape 2 : le profil web rattache la liste par son NUMERO', async () => {
    const { fgt } = await laboratoire();
    await listeUrl(fgt);
    propre(await profilWeb(fgt));
    const conf = await fgt.executeCommand('show webfilter profile WF-Lab');
    expect(conf).toContain('set urlfilter-table 1');
    expect(conf).toContain('set log-all-url enable');
  });

  it('etape 3 : le profil s\'attache a la politique', async () => {
    const { fgt } = await laboratoire();
    await listeUrl(fgt);
    await profilWeb(fgt);
    propre(await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set utm-status enable',
      'set inspection-mode flow',
      'set webfilter-profile "WF-Lab"',
      'set ssl-ssh-profile "certificate-inspection"',
      'set logtraffic all',
      'next', 'end',
    ]));
    expect(await fgt.executeCommand('show firewall policy 2'))
      .toContain('set webfilter-profile "WF-Lab"');
  });

  it('etape 4 : une URL de la liste est REELLEMENT bloquee', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await taper(srvDmz, ['ip addr add 192.168.20.11/24 dev eth0']);
    await taper(fgt, [
      'config system dns-server', 'edit "port2"', 'set mode forward-only', 'next', 'end',
      'config system dns-database', 'edit "z"', 'set domain "example.com"',
      'set type primary', 'config dns-entry', 'edit 1',
      'set hostname "www"', 'set ip 192.168.20.10', 'next', 'end', 'next', 'end',
    ]);
    await listeUrl(fgt);
    await profilWeb(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set webfilter-profile "WF-Lab"', 'set logtraffic all', 'next', 'end',
    ]);

    const bloque = await pcLan.executeCommand(
      'curl -sS -H "Host: example.com" http://192.168.20.10/');
    expect(bloque).not.toContain('Welcome to nginx!');
  });

  it('etape 4 : une URL HORS de la liste passe — le temoin', async () => {
    const { fgt, pcLan } = await laboratoire();
    await listeUrl(fgt);
    await profilWeb(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set webfilter-profile "WF-Lab"', 'set logtraffic all', 'next', 'end',
    ]);

    expect(await pcLan.executeCommand(
      'curl -sS -H "Host: autre.test" http://192.168.20.10/'))
      .toContain('Welcome to nginx!');
  });

  it('etape 5 : le blocage figure dans les journaux UTM', async () => {
    const { fgt, pcLan } = await laboratoire();
    await listeUrl(fgt);
    await profilWeb(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set webfilter-profile "WF-Lab"', 'set logtraffic all', 'next', 'end',
    ]);
    await pcLan.executeCommand('curl -sS -H "Host: example.com" http://192.168.20.10/');

    await taper(fgt, [
      'execute log filter category 3',
      'execute log filter field action "blocked"',
    ]);
    const journal = await fgt.executeCommand('execute log display');
    expect(journal).not.toContain('No matching log data.');
    expect(journal).toContain('example.com');
  });

  it('etape 5 : `execute log filter category ?` decrit les categories', async () => {
    const { fgt } = await laboratoire();
    const aide = await fgt.executeCommand('execute log filter category ?');
    expect(aide).not.toMatch(/Unknown action/i);
    expect(aide).toMatch(/traffic/i);
    expect(aide).toMatch(/utm|webfilter/i);
  });

  it('etape 6 : un profil de filtrage de fichiers se declare', async () => {
    const { fgt } = await laboratoire();
    propre(await profilFichiers(fgt));
    const conf = await fgt.executeCommand('show file-filter profile FF-Lab');
    expect(conf).toContain('set feature-set flow');
    expect(conf).toContain('edit "Bloquer-Executables"');
    expect(conf).toContain('set action block');
    expect(conf).toMatch(/set file-type .*exe/);
    expect(conf).toContain('set protocol http-get http-post');
  });

  it('etape 7 : un executable DEGUISE en image est bloque', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await srvDmz.executeCommand(
      "printf 'MZ\\x90\\x00\\x03\\x00\\x00\\x00\\x04\\x00' > /var/www/html/photo.jpg");
    await profilFichiers(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set file-filter-profile "FF-Lab"',
      'set logtraffic all', 'next', 'end',
    ]);

    expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/photo.jpg'))
      .not.toContain('MZ');
  });

  it('etape 7 : une VRAIE image passe — le temoin', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await srvDmz.executeCommand(
      "printf '\\xff\\xd8\\xff\\xe0 vraie image' > /var/www/html/vraie.jpg");
    await profilFichiers(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set file-filter-profile "FF-Lab"',
      'set logtraffic all', 'next', 'end',
    ]);

    expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/vraie.jpg'))
      .toContain('vraie image');
  });

  it('etape 8 : un profil antivirus se declare en `monitor`', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config antivirus profile', 'edit "AV-Lab"',
      'set feature-set flow',
      'config http', 'set av-scan monitor', 'end',
      'next', 'end',
    ]));
    expect(await fgt.executeCommand('show antivirus profile AV-Lab'))
      .toContain('set av-scan monitor');
  });

  it('etape 9 : l\'etat des bases FortiGuard se lit', async () => {
    const { fgt } = await laboratoire();
    const versions = await fgt.executeCommand('diagnose autoupdate versions');
    expect(versions).not.toMatch(/Unknown action/i);
    expect(versions).toMatch(/Virus|IPS|Definitions/i);

    const service = await fgt.executeCommand('get system fortiguard-service status');
    expect(service).not.toMatch(/Unknown action/i);
  });

  it('etape 10 : detacher le profil rend le fichier a nouveau accessible', async () => {
    const { fgt, pcLan, srvDmz } = await laboratoire();
    await srvDmz.executeCommand(
      "printf 'MZ\\x90\\x00\\x03\\x00\\x00\\x00\\x04\\x00' > /var/www/html/photo.jpg");
    await profilFichiers(fgt);
    await taper(fgt, [
      'config firewall policy', 'edit 2',
      'set utm-status enable', 'set inspection-mode flow',
      'set file-filter-profile "FF-Lab"', 'next', 'end',
    ]);
    propre(await taper(fgt, [
      'config firewall policy', 'edit 2', 'unset file-filter-profile', 'next', 'end',
    ]));

    expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/photo.jpg'))
      .toContain('MZ');
  });
});
