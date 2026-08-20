import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

const dhcpState = (h: LinuxPC, iface: string) => h.getDHCPClient().getState(iface);

// PXE-boot / VoIP-provisioning style pool: next-server + bootfile drive a
// netboot, netbios-name-server/-node-type drive legacy WINS resolution, and
// a raw vendor option (150 — Cisco's classic "TFTP server address list",
// used by IP phones) must reach the client exactly as configured.
async function buildPoolWithBootOptions() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const r1 = new CiscoRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  await run(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool LAN',
    'network 10.0.1.0 255.255.255.0',
    'default-router 10.0.1.1',
    'next-server 10.0.1.5',
    'bootfile pxelinux.0',
    'netbios-name-server 10.0.1.6 10.0.1.7',
    'netbios-node-type h-node',
    'option 150 ip 10.0.1.5',
    'exit',
    'ip dhcp excluded-address 10.0.1.1',
    'end',
  ]);
  return { h1, r1 };
}

describe('DHCP — boot/VoIP/NetBIOS pool options reach the client over the real wire', () => {
  it('a client leasing via real DORA actually receives next-server, bootfile, NetBIOS and vendor options', async () => {
    const { h1 } = await buildPoolWithBootOptions();

    const out = await h1.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');

    const state = dhcpState(h1, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.0\.1\./);

    expect(state.lease?.nextServer).toBe('10.0.1.5');
    expect(state.lease?.bootfileName).toBe('pxelinux.0');
    expect(state.lease?.netbiosServers).toEqual(['10.0.1.6', '10.0.1.7']);
    expect(state.lease?.netbiosNodeType).toBe(8); // h-node = 0x8 (RFC 2132)
    expect(state.lease?.vendorOptions?.[150]).toBe('10.0.1.5');
  });
});
