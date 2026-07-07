/**
 * Windows as a first-class DHCP + DNS client — Linux parity.
 *
 * Topology: CiscoRouter DHCP server (pool with dns-server + domain-name),
 * a dnsmasq LinuxServer answering UDP/53, one WindowsPC client. Everything
 * travels over real cables: the DHCP lease must feed the Windows resolver
 * exactly like dhclient writes resolv.conf on Linux.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function buildLab() {
  const router = new CiscoRouter('R1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const win = new WindowsPC('windows-pc', 'WINPC');
  const dns = new LinuxServer('linux-server', 'DNS1');

  new Cable('c-r').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('eth0')!);
  new Cable('c-w').connect(win.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c-d').connect(dns.getPort('eth0')!, sw.getPort('eth2')!);

  router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  dns.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

  for (const cmd of [
    'enable', 'configure terminal',
    'service dhcp',
    'ip dhcp pool LAN',
    'network 192.168.1.0 255.255.255.0',
    'default-router 192.168.1.1',
    'dns-server 192.168.1.10',
    'domain-name lab.local',
    'exit',
    'ip dhcp excluded-address 192.168.1.1 192.168.1.20',
    'end',
  ]) await router.executeCommand(cmd);

  dns.dnsService.addRecord({ name: 'webserver', type: 'A', value: '192.168.1.88', ttl: 3600 });
  dns.dnsService.addRecord({ name: 'intra.lab.local', type: 'A', value: '192.168.1.99', ttl: 3600 });
  dns.dnsService.start();

  return { router, sw, win, dns };
}

function psShell(win: WindowsPC) {
  const { subShell } = PowerShellSubShell.create(win);
  return async (line: string) => (await subShell.processLine(line)).output.join('\n');
}

describe('bail DHCP → configuration DNS du résolveur', () => {
  it('netsh interface ip show dns liste les serveurs DNS reçus par DHCP', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const out = await win.executeCommand('netsh interface ip show dns');

    expect(out).toContain('192.168.1.10');
  }, 20000);

  it('ipconfig affiche le suffixe DNS du bail (option domain-name)', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const out = await win.executeCommand('ipconfig');

    expect(out).toMatch(/Connection-specific DNS Suffix {2}\. : lab\.local/);
  }, 20000);

  it('ipconfig /all affiche le suffixe du bail sur l\'adaptateur', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const out = await win.executeCommand('ipconfig /all');

    expect(out).toMatch(/Connection-specific DNS Suffix {2}\. : lab\.local/);
  }, 20000);

  it('Get-DnsClientServerAddress expose le serveur du bail', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const out = await psShell(win)('Get-DnsClientServerAddress');

    expect(out).toContain('192.168.1.10');
  }, 20000);

  it('ipconfig /release retire les serveurs DNS du bail', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    await win.executeCommand('ipconfig /release');

    const out = await win.executeCommand('netsh interface ip show dns');

    expect(out).not.toContain('192.168.1.10');
  }, 20000);

  it('la config statique netsh garde la priorité sur le bail', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    await win.executeCommand('netsh interface ip set dns "Ethernet 0" static 192.168.1.53');

    const out = await win.executeCommand('netsh interface ip show dns');

    expect(out).toContain('192.168.1.53');
    expect(out).not.toContain('192.168.1.10');
  }, 20000);
});

describe('résolution DNS sur le fil avec les serveurs du bail', () => {
  it('nslookup interroge le serveur DNS fourni par DHCP', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const out = await win.executeCommand('nslookup webserver');

    expect(out).toContain('192.168.1.88');
  }, 20000);

  it('ping par nom résout via le serveur du bail', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const out = await win.executeCommand('ping -n 1 webserver');

    expect(out).toContain('192.168.1.88');
    expect(out).not.toContain('could not find host');
  }, 20000);

  it('un nom court est qualifié avec le suffixe du bail', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const out = await win.executeCommand('ping -n 1 intra');

    expect(out).toContain('192.168.1.99');
    expect(out).not.toContain('could not find host');
  }, 20000);

  it('Resolve-DnsName résout sur le fil via le serveur du bail', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const out = await psShell(win)('Resolve-DnsName webserver');

    expect(out).toContain('192.168.1.88');
  }, 20000);

  it('la résolution échoue quand le serveur DNS du bail est éteint', async () => {
    const { win, dns } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    dns.dnsService.stop();

    const out = await win.executeCommand('ping -n 1 webserver');

    expect(out).toContain('could not find host');
  }, 20000);
});

describe('cache du résolveur Windows', () => {
  it('une résolution réussie alimente ipconfig /displaydns', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    await win.executeCommand('ping -n 1 webserver');

    const out = await win.executeCommand('ipconfig /displaydns');

    expect(out).toContain('webserver');
    expect(out).toContain('192.168.1.88');
  }, 20000);

  it('le cache répond quand le serveur DNS devient injoignable', async () => {
    const { win, dns } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    await win.executeCommand('ping -n 1 webserver');
    dns.dnsService.stop();

    const out = await win.executeCommand('ping -n 1 webserver');

    expect(out).toContain('192.168.1.88');
    expect(out).not.toContain('could not find host');
  }, 20000);

  it('ipconfig /flushdns vide le cache et force une requête sur le fil', async () => {
    const { win, dns } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    await win.executeCommand('ping -n 1 webserver');
    dns.dnsService.stop();
    await win.executeCommand('ipconfig /flushdns');

    const out = await win.executeCommand('ping -n 1 webserver');

    expect(out).toContain('could not find host');
  }, 20000);

  it('Get-DnsClientCache liste les entrées, Clear-DnsClientCache les purge', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    await win.executeCommand('ping -n 1 webserver');
    const ps = psShell(win);

    const before = await ps('Get-DnsClientCache');
    expect(before).toContain('webserver');
    expect(before).toContain('192.168.1.88');

    await ps('Clear-DnsClientCache');

    const after = await win.executeCommand('ipconfig /displaydns');
    expect(after).toContain('(no entries)');
  }, 20000);
});
