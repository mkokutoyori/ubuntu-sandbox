/**
 * Probe: a local change to the Windows Firewall writes the Security events of the subcategory "MPSSVC Rule-Level Policy Change".
 *
 * Reference (rule 8): Microsoft's security auditing reference, events 4946, 4947, 4948 and 4950 (learn.microsoft.com, previous-versions
 * windows-10 security/threat-protection/auditing/event-49xx): Task 13571, Keywords 0x8020000000000000 (Audit Success), `<Security />` empty,
 * EventData ProfileChanged / RuleId / RuleName for the three rule events and ProfileChanged / SettingType / SettingValue for 4950. The
 * Event Viewer rendering is not on those pages: the message follows the headings of the field list ("Added Rule:", "Rule ID", "Rule Name",
 * "Changed Profile", "New Setting", "Type", "Value") in the layout of the neighbouring templates, which no capture contradicts or confirms.
 *
 * Measured before the change: New-NetFirewallRule, Set-NetFirewallRule, Remove-NetFirewallRule, Set-NetFirewallProfile and
 * `netsh advfirewall` changed the rule and profile stores and wrote nothing, with the audit subcategory enabled or not. The two writers
 * (the PowerShell adapter and WinNetsh) now announce the same bus topics, and the audit projection writes the events when, and only when,
 * the subcategory audits successes (the stock baseline leaves it off).
 *
 * Discrimination (git stash push -- src/network src/powershell): 6 of 8 cases fall on the base. Two pass either way: the WITNESS (with the
 * subcategory enabled a group change still reaches the log as 4732, which proves the lab audits at all) and the not-audited case (non-regression:
 * the stock baseline stays silent, as before). Not covered: Group Policy changes
 * (the reference says they do not generate these events) and rule-level `netsh advfirewall reset`, left in TODO.md.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

interface Lab { ps(line: string): Promise<string>; cmd(line: string): Promise<string> }

function lab(): Lab {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  return {
    ps: async (line) => (await shell.processLine(line)).output.join('\n'),
    cmd: (line) => pc.executeCommand(line),
  };
}

const FIREWALL_EVENTS = '(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4946,4947,4948,4950})';
let machine: Lab;

async function enabledLab(): Promise<Lab> {
  const created = lab();
  await created.cmd('auditpol /set /subcategory:"MPSSVC Rule-Level Policy Change" /success:enable');
  return created;
}

beforeEach(() => { machine = lab(); });

describe('Windows Firewall changes in the Security log', () => {
  it('WITNESS: with the subcategory enabled a group change reaches the log as 4732', async () => {
    machine = await enabledLab();
    await machine.ps('New-LocalUser -Name probe1 -NoPassword');
    await machine.ps('Add-LocalGroupMember -Group Administrators -Member probe1');
    const ids = await machine.ps('Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4732} | ForEach-Object { $_.Id } | Select-Object -Unique');
    expect(ids.trim()).toBe('4732');
  });

  it('New-NetFirewallRule writes 4946 with the profile, the rule id and the rule name', async () => {
    machine = await enabledLab();
    await machine.ps('New-NetFirewallRule -DisplayName Probe1 -Direction Inbound -Protocol TCP -LocalPort 4444 -Action Allow');
    const out = await machine.ps(`${FIREWALL_EVENTS}[0].ToXml()`);
    expect(out).toContain('<EventID>4946</EventID>');
    expect(out).toContain("<Data Name='ProfileChanged'>All</Data>");
    expect(out).toMatch(/<Data Name='RuleId'>\{[0-9A-Fa-f-]{36}\}<\/Data>/);
    expect(out).toContain("<Data Name='RuleName'>Probe1</Data>");
    expect(out).toContain('<Task>13571</Task>');
    expect(out).toContain('<Keywords>0x8020000000000000</Keywords>');
  });

  it('the message of 4946 names the rule it added', async () => {
    machine = await enabledLab();
    await machine.ps('New-NetFirewallRule -DisplayName Probe2 -Direction Inbound -Protocol TCP -LocalPort 4445 -Action Allow');
    const out = await machine.ps(`${FIREWALL_EVENTS}[0].Message`);
    expect(out).toContain('A change has been made to Windows Firewall exception list. A rule was added.');
    expect(out).toContain('Added Rule:');
    expect(out).toMatch(/Rule Name:\s+Probe2/);
  });

  it('Set-NetFirewallRule writes 4947', async () => {
    machine = await enabledLab();
    await machine.ps('New-NetFirewallRule -DisplayName Probe3 -Direction Inbound -Protocol TCP -LocalPort 4446 -Action Allow');
    await machine.ps('Set-NetFirewallRule -DisplayName Probe3 -Enabled False');
    const out = await machine.ps(`${FIREWALL_EVENTS}[0].Message`);
    expect(out).toContain('A rule was modified.');
    expect(out).toMatch(/Rule Name:\s+Probe3/);
  });

  it('Remove-NetFirewallRule writes 4948', async () => {
    machine = await enabledLab();
    await machine.ps('New-NetFirewallRule -DisplayName Probe4 -Direction Inbound -Protocol TCP -LocalPort 4447 -Action Allow');
    await machine.ps('Remove-NetFirewallRule -DisplayName Probe4');
    const out = await machine.ps(`${FIREWALL_EVENTS}[0].Message`);
    expect(out).toContain('A rule was deleted.');
    expect(out).toMatch(/Rule Name:\s+Probe4/);
  });

  it('netsh advfirewall add rule and delete rule write 4946 and 4948', async () => {
    machine = await enabledLab();
    await machine.cmd('netsh advfirewall firewall add rule name=Probe5 dir=in action=allow protocol=TCP localport=5555');
    const added = await machine.ps(`${FIREWALL_EVENTS}[0].Message`);
    expect(added).toContain('A rule was added.');
    expect(added).toMatch(/Rule Name:\s+Probe5/);
    await machine.cmd('netsh advfirewall firewall delete rule name=Probe5');
    const deleted = await machine.ps(`${FIREWALL_EVENTS}[0].Message`);
    expect(deleted).toContain('A rule was deleted.');
  });

  it('Set-NetFirewallProfile -DefaultInboundAction Block writes 4950', async () => {
    machine = await enabledLab();
    await machine.ps('Set-NetFirewallProfile -Name Domain -DefaultInboundAction Block');
    const out = await machine.ps(`${FIREWALL_EVENTS}[0].ToXml()`);
    expect(out).toContain('<EventID>4950</EventID>');
    expect(out).toContain("<Data Name='ProfileChanged'>Domain</Data>");
    expect(out).toContain("<Data Name='SettingType'>Default Inbound Action</Data>");
    expect(out).toContain("<Data Name='SettingValue'>Block</Data>");
    expect((await machine.ps(`${FIREWALL_EVENTS}.Count`)).trim()).toBe('1');
  });

  it('nothing is written while the subcategory does not audit successes', async () => {
    await machine.ps('New-NetFirewallRule -DisplayName Probe6 -Direction Inbound -Protocol TCP -LocalPort 4448 -Action Allow');
    await machine.ps('Remove-NetFirewallRule -DisplayName Probe6');
    expect(await machine.ps(`${FIREWALL_EVENTS}.Count`)).toContain('No events were found that match the specified selection criteria.');
  });
});
