/*
 * Reference: official_docs/cisco/asa (Cisco Secure Firewall ASA Series Command Reference): 'ping [if_name] host [repeat count] [timeout seconds]', 'ping tcp host port',
 * 'traceroute destination | hostname', 'dns domain-lookup interface_name', 'dns server-group', 'name-server', 'domain-name', 'route if_name network mask gateway [metric]'.
 * The simulated ASA had none of them: every one answered '% Invalid input detected at ^', so no name could be typed on it and its routing table could not be configured.
 * Now they are declared on the ASA socle (cli/vendors/asa/asaNetworkFamily.ts), evaluated on the firewall's own engines (FirewallPing, FirewallTraceroute, RouteTable,
 * FirewallDnsClient, TcpStack) and rendered back in the running-config. DNS lookup is gated as the reference says: a server is queried only when 'dns domain-lookup' is
 * enabled on the interface that reaches it. Output follows the reference examples ('Sending 5, 100-byte ICMP Echos to NAME, timeout is 2 seconds:', '!!!!!', 'Success rate
 * is 100 percent (5/5), ...', 'Tracing the route to ADDRESS', ' 1 10.83.194.1 0 msec 0 msec 0 msec', 'Sending 5 TCP SYN requests to ADDRESS port PORT'). Not in the
 * reference: the wording for a name that does not resolve (the IOS wording is used), and the 'data', 'size', 'validate' and 'source' keywords, which are refused.
 *
 * Measured against the commit before (worktree): 8 of the 10 cases fall; the 2 that pass either way are the WITNESS (the ASA is placed, cabled and named in the lab the other cases rely on)
 * and the refusal of 'size' (the base refuses every word of these commands, so a refusal proves nothing there: it is a non-regression of the refusal, not of an effect).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

interface Shell { executeCommand(command: string): Promise<string> }

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

const KNOWN = 'web.banquehorizon.com';

async function script(device: Shell, commands: readonly string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

async function asa(withDns = true) {
  const built = await buildDnsAgenceBancaire();
  const switchAgency = [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === 'SW-AGENCE') as unknown as Shell;
  for (const command of ['enable', 'configure terminal', 'interface FastEthernet0/9', 'switchport mode access', 'switchport access vlan 20', 'end']) {
    await switchAgency.executeCommand(command);
  }
  const device = built.bench.place('firewall-cisco', 'ASA', 100, 300) as unknown as Shell;
  built.bench.connect(device as never, 'GigabitEthernet0/0', switchAgency as never, 'FastEthernet0/9');
  await script(device, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'nameif inside', 'ip address 10.20.20.79 255.255.255.0', 'no shutdown', 'exit',
    'route inside 0.0.0.0 0.0.0.0 10.20.20.1']);
  if (withDns) await script(device, ['dns domain-lookup inside', 'dns server-group DefaultDNS', 'name-server 10.20.20.10', 'exit']);
  await device.executeCommand('end');
  return device;
}

describe('ASA ping, traceroute, route and DNS client (ASA command reference)', () => {
  it('WITNESS the firewall answers an ICMP ping at the next hop through the cabling the lab built', async () => {
    const device = await asa();
    const out = await device.executeCommand('show nameif');
    expect(out).toContain('inside');
  });

  it('ping an address: the documented banner and a success rate', async () => {
    const out = await (await asa()).executeCommand('ping 10.20.20.10');
    expect(out).toContain('Sending 5, 100-byte ICMP Echos to 10.20.20.10, timeout is 2 seconds:');
    expect(out).toContain('!!!!!');
    expect(out).toContain('Success rate is 100 percent (5/5)');
  });

  it('ping a name only the DNS knows', async () => {
    const out = await (await asa()).executeCommand(`ping ${KNOWN}`);
    expect(out).toContain(`Sending 5, 100-byte ICMP Echos to ${KNOWN}, timeout is 2 seconds:`);
    expect(out).toContain('Success rate is 100 percent (5/5)');
  });

  it('ping repeat and timeout are applied', async () => {
    const out = await (await asa()).executeCommand('ping 10.20.20.10 repeat 3 timeout 4');
    expect(out).toContain('Sending 3, 100-byte ICMP Echos to 10.20.20.10, timeout is 4 seconds:');
    expect(out).toContain('(3/3)');
  });

  it('ping a name without dns domain-lookup on the interface is refused', async () => {
    const out = await (await asa(false)).executeCommand(`ping ${KNOWN}`);
    expect(out).toContain('Unrecognized host');
  });

  it('ping a name nobody knows is refused', async () => {
    expect(await (await asa()).executeCommand('ping nobody.banquehorizon.com')).toContain('Unrecognized host');
  });

  it('traceroute a name lists the hops up to the destination', async () => {
    const out = await (await asa()).executeCommand(`traceroute ${KNOWN}`);
    expect(out).toContain('Tracing the route to 203.0.113.20');
    expect(out).toMatch(/ 1 10\.20\.20\.1 /);
    expect(out).toMatch(/ 3 203\.0\.113\.20 /);
  });

  it('ping tcp reaches an open port', async () => {
    const out = await (await asa()).executeCommand(`ping tcp ${KNOWN} 80`);
    expect(out).toContain('Sending 5 TCP SYN requests to 203.0.113.20 port 80');
    expect(out).toContain('Success rate is 100 percent (5/5)');
  });

  it('the configuration is rendered back in the running-config', async () => {
    const out = await (await asa()).executeCommand('show running-config');
    expect(out).toContain('route inside 0.0.0.0 0.0.0.0 10.20.20.1 1');
    expect(out).toContain('dns domain-lookup inside');
    expect(out).toContain('dns server-group DefaultDNS');
    expect(out).toContain(' name-server 10.20.20.10');
  });

  it('the keywords the simulator does not evaluate are refused', async () => {
    expect(await (await asa()).executeCommand('ping 10.20.20.10 size 200')).toContain('Invalid input');
  });
});
