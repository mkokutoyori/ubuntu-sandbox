/*
 * Probe: FortiOS 7.4.12 (dnsfilter profile, p.256-258) documents `block-action [block|redirect|block-sevrfail]` (default
 * redirect), `redirect-portal` / `redirect-portal6` and `block-botnet`. A blocked DNS query used to be dropped in silence: the
 * client waited for its timeout and nothing told it the name was refused. The firewall now answers the client itself, with the
 * address of the resolver it asked as source: NXDOMAIN for `block`, SERVFAIL for `block-sevrfail`, and for `redirect` an A record
 * (AAAA with redirect-portal6, otherwise an empty NOERROR) pointing at the portal. With `redirect` and no portal set the query is
 * still dropped, because the built-in FortiGuard portal address is not in the reference. `block-botnet` is refused: no
 * FortiGuard botnet C&C feed exists here, so accepting it would be a criterion never evaluated.
 *
 * A PC queries a resolver across a FortiGate whose policy carries a DNS filter profile blocking evil.test.
 * Discriminated with git stash on src/network: 6 of 8 fall before the change; the two witnesses (an allowed name is not
 * answered by the firewall, a redirect without portal stays silent) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function lab(profileLines: readonly string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 200, 0);
  const resolver = new LinuxPC('linux-pc', 'DNS', 400, 0);
  pc.powerOn(); resolver.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, pc.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, resolver.getPorts()[0]);
  const lines = [
    'config system interface', 'edit "port1"', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.0.1 255.255.255.0', 'next', 'end',
    'config dnsfilter domain-filter', 'edit 1', 'set name "bad"', 'config entries', 'edit 1',
    'set domain "evil.test"', 'set type simple', 'set action block', 'next', 'end', 'next', 'end',
    'config dnsfilter profile', 'edit "p"', 'config domain-filter', 'set domain-filter-table 1', 'end', ...profileLines, 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'set utm-status enable', 'set dnsfilter-profile "p"', 'next', 'end',
  ];
  const replies: string[] = [];
  for (const line of lines) replies.push(await fw.executeCommand(line));
  for (const line of ['ip link set eth0 up', 'ip addr add 10.1.0.10/24 dev eth0', 'ip route add default via 10.1.0.1']) await pc.executeCommand(line);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.2.0.10/24 dev eth0', 'ip route add default via 10.2.0.1']) await resolver.executeCommand(line);
  return { fw, pc, replies };
}

const ask = (pc: LinuxPC, name: string) => pc.executeCommand(`dig @10.2.0.10 ${name} +time=1 +tries=1`);

describe('dnsfilter block-action', () => {
  it('witness: an allowed name is not answered by the firewall', async () => {
    const { pc } = await lab(['set block-action block']);
    const out = await ask(pc, 'fine.test');
    expect(out).not.toMatch(/NXDOMAIN|SERVFAIL/);
  });

  it('block answers NXDOMAIN', async () => {
    const { pc } = await lab(['set block-action block']);
    expect(await ask(pc, 'evil.test')).toContain('status: NXDOMAIN');
  });

  it('block-sevrfail answers SERVFAIL', async () => {
    const { pc } = await lab(['set block-action block-sevrfail']);
    expect(await ask(pc, 'evil.test')).toContain('status: SERVFAIL');
  });

  it('redirect answers with the portal address', async () => {
    const { pc } = await lab(['set block-action redirect', 'set redirect-portal 203.0.113.250']);
    const out = await ask(pc, 'evil.test');
    expect(out).toContain('status: NOERROR');
    expect(out).toContain('203.0.113.250');
  });

  it('the redirect settings are rendered back', async () => {
    const { fw } = await lab(['set block-action redirect', 'set redirect-portal 203.0.113.250']);
    const shown = await fw.executeCommand('show dnsfilter profile p');
    expect(shown).toContain('set redirect-portal 203.0.113.250');
  });

  it('witness: redirect without a portal stays silent', async () => {
    const { pc } = await lab(['set block-action redirect']);
    const out = await ask(pc, 'evil.test');
    expect(out).not.toMatch(/status: (NXDOMAIN|SERVFAIL|NOERROR)/);
  });

  it('block-botnet is refused: there is no botnet feed to evaluate', async () => {
    const { replies } = await lab(['set block-botnet enable']);
    expect(replies.join('\n')).toMatch(/no FortiGuard botnet C&C domain feed/);
  });

  it('an invalid redirect-portal6 is refused at commit', async () => {
    const { replies } = await lab(['set redirect-portal6 not-an-address']);
    expect(replies.join('\n')).toMatch(/not-an-address is not an IPv6 address/);
  });
});
