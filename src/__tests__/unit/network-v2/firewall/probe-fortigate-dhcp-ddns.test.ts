/*
 * `config system dhcp server` : ddns-update, ddns-update-override,
 * ddns-server-ip, ddns-zone, ddns-auth tsig, ddns-keyname, ddns-key et
 * ddns-ttl. Un FortiGate qui sert un bail inscrit le nom du client dans la
 * zone d'un serveur DNS par une vraie mise a jour dynamique (RFC 2136) sur
 * UDP 53, signee TSIG (RFC 2845, HMAC-MD5) si ddns-auth vaut tsig, et
 * retire l'enregistrement quand le bail disparait.
 *
 * L'AUTORITE : reference CLI du depot (official_docs/forti-cli-ref-60.txt,
 * FortiOS 6.0.4) : « ddns-auth {disable | tsig} », « ddns-ttl range[60-86400] »,
 * « ddns-key ... (base 64 encoding) » ; RFC 2136, RFC 2845, RFC 4702 (bit S
 * de l'option 81 : le serveur met a jour le A si S vaut 1). Non source : le
 * defaut ddns-ttl 300, et le sens exact de ddns-update-override (lu comme
 * « le serveur met a jour meme quand le client dit le faire lui-meme »). La
 * cle est transmise telle quelle, comme le font les autres serveurs du
 * simulateur pour leurs cles TSIG (pas de decodage base64). Seul l'
 * enregistrement A est tenu : pas de PTR.
 *
 * Le laboratoire : un FortiGate sert un client Windows, un Windows Server
 * DNS heberge la zone lab.test. Avant le correctif chaque attribut ddns-*
 * etait refuse par la CLI : 4 des 8 cas tombent (git stash de src/network),
 * les quatre positifs (inscription, TTL, zone Secure signee, retrait). Les autres sont
 * des refus ou des temoins : sans ddns-update aucune inscription ; le
 * retrait par lease-clear ne prouve rien seul, il verifie d'abord la
 * presence de l'enregistrement ; un refus (zone etrangere, non signee,
 * mauvaise cle) passe avant parce que rien n'etait envoye, et n'a de sens
 * que contre les positifs du meme laboratoire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const type = async (device: { executeCommand(c: string): Promise<string> }, lines: readonly string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
};
const ps = async (device: WindowsServer, line: string) => (await PowerShellSubShell.create(device).subShell.processLine(line)).output.join('\n');
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

async function lab(ddns: readonly string[], zone = 'Add-DnsServerPrimaryZone -Name lab.test -ZoneFile lab.test.dns -DynamicUpdate NonsecureAndSecure') {
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  const pc = new WindowsPC('windows-pc', 'PC', 0, 0);
  const dns = new WindowsServer('DNS1');
  new Cable('up').connect(sw.getPort('eth0')!, fw.getPort('port2')!);
  new Cable('p').connect(pc.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('d').connect(dns.getPort('eth0')!, sw.getPort('eth2')!);
  dns.getPorts()[0].configureIP(new IPAddress('192.168.10.53'), new SubnetMask('255.255.255.0'));
  dns.setCurrentUser('Administrator');
  await ps(dns, 'Install-WindowsFeature DNS');
  await ps(dns, zone);
  await ps(dns, 'Add-DnsServerTsigKey -Name dhcp-key -Algorithm hmac-md5.sig-alg.reg.int. -Secret s3cr3t');
  await type(fw, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 192.168.10.1 255.255.255.0', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"', 'set default-gateway 192.168.10.1',
    'set netmask 255.255.255.0', ...ddns,
    'config ip-range', 'edit 1', 'set start-ip 192.168.10.100', 'set end-ip 192.168.10.120', 'next', 'end', 'next', 'end',
  ]);
  return { fw, pc, dns };
}

const UPDATE = ['set ddns-update enable', 'set ddns-server-ip 192.168.10.53', 'set ddns-zone "lab.test"', 'set ddns-update-override enable'];
const record = (dns: WindowsServer) => ps(dns, 'Get-DnsServerResourceRecord -ZoneName lab.test -Name PC');

describe('mise a jour DNS par le serveur DHCP', () => {
  it('WITNESS : sans ddns-update, aucune inscription', async () => {
    const { pc, dns } = await lab([]);
    await pc.executeCommand('ipconfig /renew');
    await settle();
    expect(await record(dns)).not.toMatch(/192\.168\.10\.1/);
  });

  it('avec ddns-update, le nom du client est inscrit dans la zone', async () => {
    const { pc, dns } = await lab(UPDATE);
    await pc.executeCommand('ipconfig /renew');
    await settle();
    expect(await record(dns)).toMatch(/192\.168\.10\.1\d\d/);
  });

  it('le TTL de l enregistrement est ddns-ttl', async () => {
    const { pc, dns } = await lab([...UPDATE, 'set ddns-ttl 120']);
    await pc.executeCommand('ipconfig /renew');
    await settle();
    expect(await record(dns)).toMatch(/\s120\s/);
  });

  it('lease-clear retire l enregistrement', async () => {
    const { fw, pc, dns } = await lab(UPDATE);
    await pc.executeCommand('ipconfig /renew');
    await settle();
    expect(await record(dns)).toMatch(/192\.168\.10\.1\d\d/);
    await fw.executeCommand('execute dhcp lease-clear all');
    await settle();
    expect(await record(dns)).not.toMatch(/192\.168\.10\.1/);
  });

  it('ddns-zone hors de la zone servie : le serveur DNS refuse et rien n est inscrit', async () => {
    const { pc, dns } = await lab(['set ddns-update enable', 'set ddns-server-ip 192.168.10.53', 'set ddns-zone "elsewhere.test"', 'set ddns-update-override enable']);
    await pc.executeCommand('ipconfig /renew');
    await settle();
    expect(await record(dns)).not.toMatch(/192\.168\.10\.1/);
  });
});

describe('TSIG', () => {
  const SECURE = 'Add-DnsServerPrimaryZone -Name lab.test -ZoneFile lab.test.dns -DynamicUpdate Secure';
  const SIGNED = [...UPDATE, 'set ddns-auth tsig', 'set ddns-keyname "dhcp-key"', 'set ddns-key "s3cr3t"'];

  it('zone Secure : une mise a jour signee avec la bonne cle est acceptee', async () => {
    const { pc, dns } = await lab(SIGNED, SECURE);
    await pc.executeCommand('ipconfig /renew');
    await settle();
    expect(await record(dns)).toMatch(/192\.168\.10\.1\d\d/);
  });

  it('zone Secure : une mise a jour non signee est refusee', async () => {
    const { pc, dns } = await lab(UPDATE, SECURE);
    await pc.executeCommand('ipconfig /renew');
    await settle();
    expect(await record(dns)).not.toMatch(/192\.168\.10\.1/);
  });

  it('zone Secure : une mauvaise cle est refusee', async () => {
    const { pc, dns } = await lab([...UPDATE, 'set ddns-auth tsig', 'set ddns-keyname "dhcp-key"', 'set ddns-key "wrong"'], SECURE);
    await pc.executeCommand('ipconfig /renew');
    await settle();
    expect(await record(dns)).not.toMatch(/192\.168\.10\.1/);
  });
});
