/*
 * RFC 8415 §19 (relais) et §18.3.10 : deux relais en cascade, et un serveur DHCPv6
 * Windows joint a travers un relais.
 *
 * Exigences : §19.1 un relais qui recoit un Relay-forward le RE-EMBALLE vers ses
 * propres destinations au lieu de le servir ; le hop-count vaut 0 pour un message
 * de client et monte de 1 a chaque relais (limite de 8 : voir dhcpv6-rfc8415-unicast-refresh-reconfigure) ; §19.4 un Relay-reply dont le message est
 * lui-meme un Relay-reply est renvoye AU PAIR (peer-address) du relais, pas au
 * client ; §18.3.10 le serveur repond au relais, par le meme chemin inverse.
 *
 * Avant le correctif : le premier relais servait le Relay-forward recu du second
 * comme un serveur (reponse renvoyee directement au client, sans repasser par
 * les relais) et le serveur Windows n'ecoutait pas le port 547 : les 4 cas tombent,
 * sauf le temoin (un relais simple) qui passe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPv6Address, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { DHCPv6Packet } from '@/network/dhcpv6/DHCPv6Packet';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = async (d: Cmd, cmds: string[]) => { for (const c of cmds) await d.executeCommand(c); };

async function chain() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const relay1 = new CiscoRouter('RELAY1');
  const relay2 = new CiscoRouter('RELAY2');
  const server = new CiscoRouter('SERVER');
  new Cable('a').connect(h1.getPort('eth0')!, relay1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(relay1.getPort('GigabitEthernet0/1')!, relay2.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(relay2.getPort('GigabitEthernet0/1')!, server.getPort('GigabitEthernet0/0')!);
  await run(relay1, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown',
    'ipv6 dhcp relay destination 2001:db8:98::2', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:98::1/64', 'no shutdown', 'exit',
    'ipv6 route 2001:db8:99::/64 2001:db8:98::2', 'end',
  ]);
  await run(relay2, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:98::2/64', 'no shutdown',
    'ipv6 dhcp relay destination 2001:db8:99::2', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:99::1/64', 'no shutdown', 'exit',
    'ipv6 route 2001:db8:1::/64 2001:db8:98::1', 'end',
  ]);
  await run(server, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:99::2/64', 'no shutdown', 'exit',
    'ipv6 route 2001:db8:1::/64 2001:db8:99::1',
    'ipv6 route 2001:db8:98::/64 2001:db8:99::1',
    'ipv6 dhcp pool POOL1', 'address prefix 2001:db8:1::/64 lifetime 3600 1800', 'exit', 'end',
  ]);
  return { h1, relay1, relay2, server };
}

async function simpleRelay() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const relay = new CiscoRouter('RELAY');
  const server = new CiscoRouter('SERVER');
  new Cable('a').connect(h1.getPort('eth0')!, relay.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(relay.getPort('GigabitEthernet0/1')!, server.getPort('GigabitEthernet0/0')!);
  await run(relay, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown',
    'ipv6 dhcp relay destination 2001:db8:99::2', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:99::1/64', 'no shutdown', 'exit', 'end',
  ]);
  await run(server, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:99::2/64', 'no shutdown', 'exit',
    'ipv6 route 2001:db8:1::/64 2001:db8:99::1',
    'ipv6 dhcp pool POOL1', 'address prefix 2001:db8:1::/64 lifetime 3600 1800', 'exit', 'end',
  ]);
  return { h1, relay, server };
}

describe('temoin', () => {
  it('un relais simple : le client obtient son adresse', async () => {
    const { h1, server } = await simpleRelay();
    await h1.executeCommand('dhclient -6 eth0');
    expect(server._getDHCPv6ServerInternal().getBindings().length).toBe(1);
  });
});

describe('deux relais en cascade', () => {
  it('le client obtient son bail du serveur central', async () => {
    const { h1, server } = await chain();
    const out = await h1.executeCommand('dhclient -6 -v eth0');
    expect(out).toContain('DHCPv6 REPLY');
    expect(server._getDHCPv6ServerInternal().getBindings().length).toBe(1);
    expect(h1.getDhcpv6Lease('eth0')?.address).toBe(server._getDHCPv6ServerInternal().getBindings()[0].address);
  });

  it('les messages traversent les deux relais : le serveur voit un Relay-forward imbrique', async () => {
    const { h1, server } = await chain();
    const seen: DHCPv6Packet[] = [];
    server.getPort('GigabitEthernet0/0')!.attachTap(({ frame, direction }) => {
      const message = (frame.payload as { payload?: { payload?: unknown } }).payload?.payload;
      if (direction === 'in' && message instanceof DHCPv6Packet && message.msgType === 'RELAY-FORW') seen.push(message);
    });
    await h1.executeCommand('dhclient -6 eth0');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].relayedMessage?.msgType).toBe('RELAY-FORW');
    expect(seen[0].hopCount).toBe(1);
    expect(seen[0].relayedMessage?.hopCount).toBe(0);
  });

  it('Renew a travers les deux relais', async () => {
    const { h1 } = await chain();
    await h1.executeCommand('dhclient -6 eth0');
    expect(h1.renewDhcpv6Lease('eth0')).toBe('extended');
  });
});

describe('serveur DHCPv6 Windows derriere un relais', () => {
  it('le client recoit un bail du serveur Windows via Relay-forward / Relay-reply', async () => {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const relay = new CiscoRouter('RELAY');
    const win = new WindowsServer('DHCP1');
    new Cable('a').connect(h1.getPort('eth0')!, relay.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(relay.getPort('GigabitEthernet0/1')!, win.getPorts()[0]);
    await run(relay, [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown',
      'ipv6 dhcp relay destination 2001:db8:99::2', 'exit',
      'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:99::1/64', 'no shutdown', 'exit', 'end',
    ]);
    win.getPorts()[0].enableIPv6();
    win.getPorts()[0].configureIPv6(new IPv6Address('2001:db8:99::2'), 64);
    win.setCurrentUser('Administrator');
    const shell = PowerShellSubShell.create(win).subShell;
    await shell.processLine('Install-WindowsFeature DHCP');
    await shell.processLine('Add-DhcpServerv6Scope -Prefix 2001:db8:1:: -Name LAN6');
    await h1.executeCommand('dhclient -6 eth0');
    expect(h1.getDhcpv6Lease('eth0')?.address).toMatch(/^2001:db8:1:/);
    expect(win.getDhcpServerRole()!.v6.getLeases().length).toBe(1);
  });
});
