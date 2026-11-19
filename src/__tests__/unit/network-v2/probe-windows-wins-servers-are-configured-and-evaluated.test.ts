/**
 * Probe: WINS servers can be configured per interface, are shown, and feed the firewall WINS keyword.
 *
 * Reference (rule 8): the windows-commands documentation in official_docs (netsh interface ipv4): add winsservers [name=]<string> [address=]<IP address> [index=]<integer>;
 * delete winsservers [name=]<string> [address=]<IP address>|all; set winsservers [name=]<string> [source=]dhcp|static [address=]<IP address>|none; show winsservers [name=]string.
 * The ipconfig /all wording ("Primary WINS Server", "Secondary WINS Server") and the layout of `show winsservers` follow the DNS equivalents already in the simulator and captured
 * output; the success word ("Ok.") is the one the DNS handlers print. A WINS address delivered by DHCP (option 44) is not modelled: `source=dhcp` only clears the static list.
 *
 * Measured before the change: `show wins` was listed by the help and answered nothing, there was no way to give an interface a WINS server, so the firewall WINS keyword was always
 * an empty set and every rule using it was reported by 4957.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 7 cases fall on the base. Two pass either way and are named: the unknown-interface case (the base answers "not found" for
 * any interface) and the WITNESS that with no server configured the WINS rule is reported by 4957.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'win1', 0, 0);
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  return pc;
}

async function interfaceName(pc: WindowsPC): Promise<string> {
  return /Configuration for interface "([^"]+)"/.exec(await pc.executeCommand('netsh interface ip show addresses'))?.[1] ?? '';
}

describe('WINS servers', () => {
  it('add winsservers shows in show winsservers', async () => {
    const pc = lab();
    const name = await interfaceName(pc);
    expect(await pc.executeCommand(`netsh interface ipv4 add winsservers name="${name}" address=10.0.0.9`)).toContain('Ok.');
    expect(await pc.executeCommand(`netsh interface ipv4 show winsservers name="${name}"`)).toContain('Statically Configured WINS Servers:   10.0.0.9');
  });

  it('ipconfig /all names the primary and secondary servers', async () => {
    const pc = lab();
    const name = await interfaceName(pc);
    await pc.executeCommand(`netsh interface ip set address "${name}" static 10.0.0.1 255.255.255.0`);
    await pc.executeCommand(`netsh interface ipv4 add winsservers name="${name}" address=10.0.0.9`);
    await pc.executeCommand(`netsh interface ipv4 add winsservers name="${name}" address=10.0.0.10`);
    const out = await pc.executeCommand('ipconfig /all');
    expect(out).toContain('Primary WINS Server . . . . . . . : 10.0.0.9');
    expect(out).toContain('Secondary WINS Server . . . . . . : 10.0.0.10');
  });

  it('index puts a server first', async () => {
    const pc = lab();
    const name = await interfaceName(pc);
    await pc.executeCommand(`netsh interface ip set address "${name}" static 10.0.0.1 255.255.255.0`);
    await pc.executeCommand(`netsh interface ipv4 add winsservers name="${name}" address=10.0.0.9`);
    await pc.executeCommand(`netsh interface ipv4 add winsservers name="${name}" address=10.0.0.10 index=1`);
    expect(await pc.executeCommand('ipconfig /all')).toContain('Primary WINS Server . . . . . . . : 10.0.0.10');
  });

  it('delete winsservers all and set ... none empty the list', async () => {
    const pc = lab();
    const name = await interfaceName(pc);
    await pc.executeCommand(`netsh interface ipv4 set winsservers name="${name}" source=static address=10.0.0.9`);
    await pc.executeCommand(`netsh interface ipv4 delete winsservers name="${name}" address=all`);
    expect(await pc.executeCommand(`netsh interface ipv4 show winsservers name="${name}"`)).toContain('None');
  });

  it('an unknown interface is refused', async () => {
    expect(await lab().executeCommand('netsh interface ipv4 add winsservers name="Nowhere" address=10.0.0.9')).toContain('was not found');
  });
});

describe('the firewall WINS keyword', () => {
  async function fourNineFiveSeven(configure: boolean): Promise<string> {
    const pc = lab();
    if (configure) await pc.executeCommand(`netsh interface ipv4 add winsservers name="${await interfaceName(pc)}" address=10.0.0.9`);
    await pc.executeCommand('auditpol /set /subcategory:"MPSSVC Rule-Level Policy Change" /failure:enable');
    await pc.executeCommand('powershell -Command "New-NetFirewallRule -DisplayName W -Direction Outbound -Action Block -RemoteAddress WINS | Out-Null"');
    return pc.executeCommand(`powershell -Command "Get-WinEvent -FilterHashtable @{LogName='Security';Id=4957} -ErrorAction SilentlyContinue | Measure-Object | ForEach-Object { $_.Count }"`);
  }

  it('with a WINS server configured the set is not empty: no 4957', async () => {
    expect((await fourNineFiveSeven(true)).trim()).toBe('0');
  });

  it('WITNESS: with none configured the set is empty and 4957 is written', async () => {
    expect((await fourNineFiveSeven(false)).trim()).toBe('1');
  });
});
