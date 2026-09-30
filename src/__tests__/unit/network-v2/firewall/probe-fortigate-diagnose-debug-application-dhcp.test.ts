/*
 * `diagnose debug application dhcps|dhcpc|dhcprelay <niveau>`, `diagnose
 * debug console timestamp enable|disable`, `diagnose debug enable|disable|
 * reset` : la trace des demons DHCP d'un FortiGate.
 *
 * L'AUTORITE : les sources recentes (Fortinet Community « Technical Tip:
 * Diagnosing DHCP on a FortiGate », le guide d'administration 7.x et une
 * fiche GitHub de commandes FortiGate), lues par extraits de recherche et
 * une page : `diagnose debug reset` puis `diagnose debug application dhcps
 * -1` puis `diagnose debug enable` ; `dhcpc` pour le FortiGate client,
 * `dhcprelay` pour le relais ; `diagnose debug console timestamp enable` ;
 * une ligne `[note]DHCPDISCOVER from 00:66:65:72:36:03 via
 * port2(ethernet)`. Le reste du format (DHCPOFFER on, DHCPREQUEST for,
 * DHCPACK on, DHCPNAK on, no free leases ; DHCPDISCOVER on ... to
 * 255.255.255.255 port 67, bound to ... ; Forwarded BOOTREQUEST/BOOTREPLY
 * for) est celui d'ISC dhcpd, dhclient et dhcrelay, sur lesquels ces
 * demons sont construits : NON attesté par une capture FortiOS, et la
 * ligne `[debug]...` interne des demons n'est pas reproduite. Non modelise :
 * `dhcp6s`, `dhcp6c` et `dhcp6r` (le serveur DHCPv6 du FortiGate ne repond
 * pas sur le fil ici, et il n'y a ni client ni relais DHCPv6) sont refuses
 * par leur nom. Un niveau non nul vaut -1 (tout) : la signification des
 * autres bits n'est pas sourcee. Les lignes vont a la console en direct
 * (comme le renifleur, Ctrl+C rend la main) ; l'historique est lisible par
 * getDhcpDebug().lines().
 *
 * Avant le correctif `diagnose debug application` et `debug console` etaient
 * inconnues : 10 des 12 cas tombent (git stash de src/network et
 * src/terminal), le temoin « sans enable » compris (l'API n'existait pas).
 * Passent des deux cotes les deux refus par la ligne de commande (demon
 * inconnu, niveau manquant), qui n'ont de sens que contre les positifs du
 * meme laboratoire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { openFortiConsole, key, tick } from './fortiConsoleHarness';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }
const type = async (device: Terminal, lines: readonly string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
};

async function serverLab(rangeEnd = '192.168.10.120') {
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  const pc = new WindowsPC('windows-pc', 'PC', 0, 0);
  const pc2 = new WindowsPC('windows-pc', 'PC2', 0, 0);
  new Cable('up').connect(sw.getPort('eth0')!, fw.getPort('port2')!);
  new Cable('a').connect(pc.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('b').connect(pc2.getPort('eth0')!, sw.getPort('eth2')!);
  await type(fw, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"', 'set default-gateway 192.168.10.1',
    'set netmask 255.255.255.0',
    'config ip-range', 'edit 1', 'set start-ip 192.168.10.100', `set end-ip ${rangeEnd}`, 'next', 'end', 'next', 'end',
  ]);
  return { fw, pc, pc2, mac: pc.getPort('eth0')!.getMAC().toString().toLowerCase() };
}

const trace = (fw: FortiGate): string => fw.getDhcpDebug().lines().join('\n');
const START = ['diagnose debug reset', 'diagnose debug application dhcps -1', 'diagnose debug enable'];

describe('dhcps', () => {
  it('WITNESS : sans diagnose debug enable, rien n est trace', async () => {
    const { fw, pc } = await serverLab();
    await type(fw, ['diagnose debug application dhcps -1']);
    await pc.executeCommand('ipconfig /renew');
    expect(trace(fw)).toBe('');
  });

  it('un DORA est trace, du DISCOVER a l ACK', async () => {
    const { fw, pc, mac } = await serverLab();
    await type(fw, START);
    await pc.executeCommand('ipconfig /renew');
    const lines = trace(fw);
    expect(lines).toContain(`[note]DHCPDISCOVER from ${mac} via port2(ethernet)`);
    expect(lines).toMatch(new RegExp(`\\[note\\]DHCPOFFER on 192\\.168\\.10\\.1\\d\\d to ${mac} via port2\\(ethernet\\)`));
    expect(lines).toMatch(new RegExp(`\\[note\\]DHCPREQUEST for 192\\.168\\.10\\.1\\d\\d from ${mac} via port2\\(ethernet\\)`));
    expect(lines).toMatch(new RegExp(`\\[note\\]DHCPACK on 192\\.168\\.10\\.1\\d\\d to ${mac} via port2\\(ethernet\\)`));
  });

  it('niveau 0 arrete la trace', async () => {
    const { fw, pc } = await serverLab();
    await type(fw, [...START, 'diagnose debug application dhcps 0']);
    await pc.executeCommand('ipconfig /renew');
    expect(trace(fw)).toBe('');
  });

  it('une plage epuisee donne « no free leases »', async () => {
    const { fw, pc, pc2 } = await serverLab('192.168.10.100');
    await type(fw, START);
    await pc.executeCommand('ipconfig /renew');
    await pc2.executeCommand('ipconfig /renew');
    expect(trace(fw)).toMatch(/DHCPDISCOVER from \S+ via port2\(ethernet\): no free leases/);
  });

  it('diagnose debug reset efface les niveaux : plus rien n est trace', async () => {
    const { fw, pc } = await serverLab();
    await type(fw, [...START, 'diagnose debug reset', 'diagnose debug enable']);
    await pc.executeCommand('ipconfig /renew');
    expect(trace(fw)).toBe('');
  });

  it('diagnose debug console timestamp enable prefixe les lignes de la date', async () => {
    const { fw, pc } = await serverLab();
    await type(fw, [...START, 'diagnose debug console timestamp enable']);
    await pc.executeCommand('ipconfig /renew');
    expect(trace(fw)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[note\]DHCPDISCOVER/m);
  });
});

describe('dhcpc et dhcprelay', () => {
  it('dhcpc trace le FortiGate client', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW-C', 0, 0);
    const srv = new LinuxServer('linux-server', 'DHCP', 0, 0);
    new Cable('c').connect(fw.getPort('wan1')!, srv.getPort('eth0')!);
    await type(srv, [
      'ip link set eth0 up', 'ip addr add 172.16.0.1/24 dev eth0',
      `printf 'authoritative;\\ndefault-lease-time 3600;\\nmax-lease-time 7200;\\nsubnet 172.16.0.0 netmask 255.255.255.0 {\\n  range 172.16.0.100 172.16.0.110;\\n}\\n' > /etc/dhcp/dhcpd.conf`,
      'systemctl start isc-dhcp-server',
    ]);
    await type(fw, ['diagnose debug reset', 'diagnose debug application dhcpc -1', 'diagnose debug enable',
      'config system interface', 'edit wan1', 'set mode dhcp', 'next', 'end']);
    const lines = trace(fw);
    expect(lines).toContain('[note]DHCPDISCOVER on wan1 to 255.255.255.255 port 67');
    expect(lines).toMatch(/\[note\]DHCPOFFER of 172\.16\.0\.1\d\d from 172\.16\.0\.1/);
    expect(lines).toMatch(/\[note\]DHCPACK of 172\.16\.0\.1\d\d from 172\.16\.0\.1/);
    expect(lines).toMatch(/\[note\]bound to 172\.16\.0\.1\d\d -- renewal in 1800 seconds\./);
  });

  it('dhcprelay trace le relais', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW-R', 0, 0);
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
    new Cable('lan').connect(pc.getPort('eth0')!, fw.getPort('port1')!);
    new Cable('wan').connect(srv.getPort('eth0')!, fw.getPort('wan1')!);
    await type(fw, ['diagnose debug reset', 'diagnose debug application dhcprelay -1', 'diagnose debug enable',
      'config system interface',
      'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0',
      'set dhcp-relay-service enable', 'set dhcp-relay-ip "203.0.113.9"', 'next',
      'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end']);
    await type(srv, [
      'ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1',
      `printf 'authoritative;\\nsubnet 192.168.1.0 netmask 255.255.255.0 {\\n  range 192.168.1.100 192.168.1.110;\\n}\\nsubnet 203.0.113.0 netmask 255.255.255.0 {\\n}\\n' > /etc/dhcp/dhcpd.conf`,
      'systemctl start isc-dhcp-server',
    ]);
    await type(pc, ['ip link set eth0 up', 'dhclient eth0']);
    expect(trace(fw)).toContain('[note]Forwarded BOOTREQUEST for');
    expect(trace(fw)).toContain('to 203.0.113.9');
    expect(trace(fw)).toMatch(/\[note\]Forwarded BOOTREPLY for \S+ to 192\.168\.1\.1\d\d/);
  });
});

describe('la ligne de commande', () => {
  it('un demon inconnu est refuse par son nom — non-regression', async () => {
    const { fw } = await serverLab();
    expect(await fw.executeCommand('diagnose debug application zorglub -1')).toMatch(/zorglub|known daemons/);
  });

  it('dhcp6s n est pas modelise : refuse par son nom', async () => {
    const { fw } = await serverLab();
    expect(await fw.executeCommand('diagnose debug application dhcp6s -1')).toMatch(/known daemons/);
  });

  it('un niveau manquant est incomplet', async () => {
    const { fw } = await serverLab();
    expect(await fw.executeCommand('diagnose debug application dhcps')).toMatch(/[Ii]ncomplete|Command fail/);
  });
});

describe('a la console', () => {
  const seen = (s: { lines: { text: string }[] }) => s.lines.map(l => l.text).join('\n');

  it('diagnose debug enable garde la main et ecrit les lignes en direct, Ctrl+C rend la main', async () => {
    const { fw, pc } = await serverLab();
    await type(fw, ['config system console', 'set output standard', 'end', 'diagnose debug application dhcps -1']);
    const s = await openFortiConsole(fw);
    s.setInput('diagnose debug enable');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 10; i++) await tick();
    expect(s.hasForegroundAsyncJob).toBe(true);

    await pc.executeCommand('ipconfig /renew');
    for (let i = 0; i < 40; i++) await tick();
    expect(seen(s)).toContain('[note]DHCPDISCOVER from');

    s.handleKey(key('c', true));
    for (let i = 0; i < 10; i++) await tick();
    expect(s.hasForegroundAsyncJob).toBe(false);
  });
});
