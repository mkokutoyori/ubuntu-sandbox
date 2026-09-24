/*
 * Probe — an interface without an address installs no connected route.
 *
 * Before: committing any `edit` of an unaddressed interface (`set role
 * lan`, `set vdom "root"`, `set mode static`) wrote the schema's unset value
 * `0.0.0.0 0.0.0.0` onto the port as a real address, and the routing table
 * gained "C 0.0.0.0/0 is directly connected, port3" — a distance-0 default
 * that outranks any static default route. The user's lab
 * (lan_with_firewall_fortigate.topology) was exported in that state, and
 * the importer re-applied 0.0.0.0/0.0.0.0 to six ports.
 *
 * Authority: FortiOS renders an interface without an address as
 * `set ip 0.0.0.0 0.0.0.0` in `show full-configuration`; that value is the
 * attribute's unset default, and `get router info routing-table all` on a
 * factory box lists no connected route for such a port.
 *
 * Measured before the change (git stash of src/network/devices/firewall and
 * src/store): 5 of the 7 cases fail.
 * Passing either way:
 *   - "an addressed interface keeps its connected route" is the WITNESS.
 *   - "the unset address is still rendered" is non-regression.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { loadUserLab } from '../../new_firewall/userLab';

async function editedFirewall(lines: readonly string[]): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  for (const line of ['config system interface', ...lines, 'end']) await fgt.executeCommand(line);
  return fgt;
}

const routingTable = (fgt: { executeCommand(c: string): Promise<string> }) =>
  fgt.executeCommand('get router info routing-table all');

describe('an interface without an address installs no connected route', () => {
  it('an addressed interface keeps its connected route', async () => {
    const fgt = await editedFirewall(['edit port3', 'set ip 10.3.3.1 255.255.255.0', 'next']);
    expect(await routingTable(fgt)).toMatch(/^C\s+10\.3\.3\.0\/24 is directly connected, port3$/m);
  });

  it('`set role` on an unaddressed port', async () => {
    const fgt = await editedFirewall(['edit port3', 'set role lan', 'next']);
    expect(await routingTable(fgt)).not.toMatch(/0\.0\.0\.0\/0/);
    expect(fgt.getPort('port3')!.getIPAddress()).toBeNull();
  });

  it('`set mode static` on an unaddressed port', async () => {
    const fgt = await editedFirewall(['edit wan1', 'set mode static', 'next']);
    expect(await routingTable(fgt)).not.toMatch(/0\.0\.0\.0\/0/);
  });

  it('`set ip 0.0.0.0 0.0.0.0` clears an address', async () => {
    const fgt = await editedFirewall([
      'edit port3', 'set ip 10.3.3.1 255.255.255.0', 'next',
      'edit port3', 'set ip 0.0.0.0 0.0.0.0', 'next',
    ]);
    expect(await routingTable(fgt)).not.toMatch(/10\.3\.3\.0|0\.0\.0\.0\/0/);
    expect(fgt.getPort('port3')!.getIPAddress()).toBeNull();
  });

  it('the unset address is still rendered', async () => {
    const fgt = await editedFirewall(['edit port3', 'set role lan', 'next']);
    const shown = await fgt.executeCommand('show full-configuration system interface port3');
    expect(shown).toContain('set ip 0.0.0.0 0.0.0.0');
  });

  it('a static default route is not shadowed by an unaddressed port', async () => {
    const fgt = await editedFirewall([
      'edit port2', 'set ip 192.168.20.2 255.255.255.252', 'next',
      'edit port3', 'set role lan', 'next',
    ]);
    for (const line of ['config router static', 'edit 1', 'set gateway 192.168.20.1', 'set device "port2"', 'next', 'end']) {
      await fgt.executeCommand(line);
    }
    const table = await routingTable(fgt);
    expect(table).toMatch(/^S\*\s+0\.0\.0\.0\/0 .*via 192\.168\.20\.1, port2/m);
    expect(table).not.toMatch(/^C\s+0\.0\.0\.0\/0/m);
  });

  it('the user lab imports without a connected default route', async () => {
    const lab = await loadUserLab();
    const table = await routingTable(lab.FW1);
    expect(table).toMatch(/^C\s+192\.168\.1\.0\/24 is directly connected, port1$/m);
    expect(table).not.toMatch(/0\.0\.0\.0\/0/);
  });
});
