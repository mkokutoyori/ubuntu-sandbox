/*
 * Sniffers Cisco (`debug ip packet`) et FortiGate (`diagnose sniffer packet`) sur un port
 * du meme commutateur que le client et le serveur DHCP : l'ordre des lignes doit etre
 * l'ordre causal (Discover, Offer, Request, ACK). Meme defaut que pour tcpdump : la
 * livraison synchrone et imbriquee remettait a l'observateur la reponse du serveur avant
 * la requete qu'elle suivait. Les sniffers lisent desormais les trames dans l'ordre de leur
 * lignee d'emission (numero et heure de premiere emission) ; le FortiGate classe aussi
 * l'anneau de capture et ne fait jamais reculer l'horodatage affiche.
 *
 * Avant le correctif : les 2 cas d'ordre tombent ; les temoins « les quatre messages sont
 * vus » passent avant comme apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { collecteDebug } from './_helpers/debugLines';
import { openFortiConsole, key, tick } from './firewall/fortiConsoleHarness';
import type { FortiTerminalSession } from '@/terminal/sessions';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.clear();
});

async function segment() {
  const srv = new LinuxServer('linux-server', 'SRV');
  const client = new LinuxPC('linux-pc', 'C1');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('a').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(client.getPorts()[0], sw.getPorts()[1]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  await srv.executeCommand(`printf '%s' ${JSON.stringify('authoritative;\nsubnet 192.168.1.0 netmask 255.255.255.0 { range 192.168.1.100 192.168.1.110; }\n')} > /etc/dhcp/dhcpd.conf`);
  await srv.executeCommand('printf \'INTERFACESv4="eth0"\\n\' > /etc/default/isc-dhcp-server');
  await srv.executeCommand('systemctl start isc-dhcp-server');
  return { srv, client, sw };
}

const ORDER = ['0.0.0.0', '192.168.1.1', '0.0.0.0', '192.168.1.1'];

describe('Cisco : debug ip packet', () => {
  it('temoin : les quatre messages du DORA sont vus', async () => {
    const { client, sw } = await segment();
    const router = new CiscoRouter('R1', 0, 0);
    router.powerOn();
    new Cable('c').connect(router.getPort('GigabitEthernet0/0')!, sw.getPorts()[2]);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 192.168.1.250 255.255.255.0', 'no shutdown', 'end', 'debug ip packet']) await router.executeCommand(c);
    const lines: string[] = [];
    collecteDebug(router.getDebugService(), lines);
    await client.executeCommand('dhclient eth0');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(lines.filter(line => /d=255\.255\.255\.255/.test(line)).length).toBeGreaterThanOrEqual(4);
  });

  it('ordre : Discover, Offer, Request, ACK', async () => {
    const { client, sw } = await segment();
    const router = new CiscoRouter('R1', 0, 0);
    router.powerOn();
    new Cable('c').connect(router.getPort('GigabitEthernet0/0')!, sw.getPorts()[2]);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 192.168.1.250 255.255.255.0', 'no shutdown', 'end', 'debug ip packet']) await router.executeCommand(c);
    const lines: string[] = [];
    collecteDebug(router.getDebugService(), lines);
    await client.executeCommand('dhclient eth0');
    await new Promise(resolve => setTimeout(resolve, 20));
    const sources = lines.filter(line => /d=255\.255\.255\.255/.test(line) && /rcvd/.test(line))
      .map(line => /s=(\d+\.\d+\.\d+\.\d+)/.exec(line)![1]);
    expect(sources.slice(0, 4)).toEqual(ORDER);
  });
});

describe('FortiGate : diagnose sniffer packet', () => {
  const seen = (s: FortiTerminalSession) => s.lines.map(l => l.text).join('\n');
  async function sniffed() {
    const { client, sw } = await segment();
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    new Cable('d').connect(fgt.getPort('port2')!, sw.getPorts()[2]);
    for (const c of ['config system interface', 'edit port2', 'set mode static', 'set ip 192.168.1.251 255.255.255.0',
      'set allowaccess ping', 'next', 'end', 'config system console', 'set output standard', 'end']) await fgt.executeCommand(c);
    const console = await openFortiConsole(fgt);
    console.setInput("diagnose sniffer packet port2 'udp port 67 or udp port 68' 4 l");
    console.handleKey(key('Enter'));
    for (let i = 0; i < 10; i++) await tick();
    await client.executeCommand('dhclient eth0');
    for (let i = 0; i < 40; i++) await tick();
    return seen(console);
  }

  it('temoin : les quatre paquets sont captures', async () => {
    const text = await sniffed();
    expect((text.match(/\.6[78] /g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('ordre : 0.0.0.0, serveur, 0.0.0.0, serveur et horodatages croissants', async () => {
    const text = await sniffed();
    const rows = text.split('\n').filter(line => /^\d+\.\d{6}/.test(line.trim()) || /^\d+\.\d{6} port2/.test(line.trim()));
    const sources = rows.map(line => /(\d+\.\d+\.\d+\.\d+)\.6[78] ->/.exec(line)?.[1]).filter((value): value is string => !!value);
    expect(sources.slice(0, 4)).toEqual(ORDER);
    const stamps = rows.map(line => Number(/^(\d+\.\d{6})/.exec(line.trim())![1]));
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
  });
});
