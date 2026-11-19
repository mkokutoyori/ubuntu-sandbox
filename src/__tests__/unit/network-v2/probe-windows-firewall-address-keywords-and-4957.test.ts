/**
 * Probe: firewall address keywords are evaluated, and a rule whose set is empty is reported by 4957.
 *
 * References (rule 8): New-NetFirewallRule documentation (PowerShell 7.6 / Microsoft Learn): -LocalAddress and -RemoteAddress accept, besides addresses, the keywords
 * LocalSubnet, DNS, DHCP, WINS and DefaultGateway (and Internet, Intranet, IntranetRemoteAccess, Ply2Renderers, not modelled: they stay refused, as an invalid value).
 * Microsoft "event-4957" page and the Microsoft-Windows-Security-Auditing manifest dump: "Windows Firewall did not apply the following rule: ... Reason: {RuleAttr} resolved to
 * an empty set.", Audit Failure keyword, subcategory "MPSSVC Rule-Level Policy Change". The attribute label ("Remote Address") follows the page's "Local Port" example.
 *
 * Measured before the change: a keyword was refused as an invalid address (so DefaultGateway/DNS rules, which real policies use, could not be written), and 4957 never existed.
 *
 * Definitions (rule 8): Microsoft [MS-FASP] 2.2.21 FW_ADDRESS_KEYWORD: Intranet = the addresses currently within the local intranet of the computer; Internet = the addresses currently not within the
 * local intranet or the remote intranet; the remote intranet keyword (IntranetRemoteAccess), the PlayTo renderers (the DLNA Digital Media Renderer devices, PlayToDevice) and the captive portal
 * (CaptivePortal) are sets of addresses of those things. The simulator has no DirectAccess, no DLNA renderer and no captive portal, so those three are empty sets, as WINS was before it was
 * modelled. What the "local intranet" contains is not specified by MS-FASP; a third-party Active Directory firewall guide says the keyword is based on the Subnet definitions of Active Directory
 * Sites and Services, and a community test on Windows 8.1 and 10 found it behaving like the local subnet. The simulator takes the union of the subnets the machine is attached to and, on a domain
 * controller, the subnets of its AD sites: a reading of those two accounts, neither of them Microsoft documentation, stated in TODO.md.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 8 cases fall on the base (three of the four cases of the last block, ranges, masks and the 4/6 suffix, fall on the commit before them). Three pass either way and are named: the WITNESS that a plain address still matches, the
 * case that expects nothing while failure auditing is off (vacuous on a base that never wrote 4957), and the fail-closed case (the base cannot match a keyword either); the creation-time case falls on the previous commit, the plain-address creation case is vacuous there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress } from '@/network/core/types';
import { parseAddressSpec, addressSpecMatches, addressSetIsEmpty, type FirewallAddressSets } from '@/network/devices/windows/netFirewallRule';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const sets: FirewallAddressSets = {
  dns: () => ['10.0.0.53'], dhcp: () => [], wins: () => [], defaultGateway: () => ['10.0.0.254'], localSubnets: () => ['10.0.0.0/24'], intranet: () => ['10.0.0.0/24', '192.168.50.0/24'],
};

async function lab(failureAudit: boolean): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'win1', 0, 0);
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  if (failureAudit) await pc.executeCommand('auditpol /set /subcategory:"MPSSVC Rule-Level Policy Change" /failure:enable');
  await pc.executeCommand('powershell -Command "New-NetFirewallRule -DisplayName NoWins -Direction Outbound -Action Block -RemoteAddress WINS | Out-Null; Restart-Service mpssvc"');
  return pc;
}

const events = (pc: WindowsPC, extra = ''): Promise<string> =>
  pc.executeCommand(`powershell -Command "Get-WinEvent -FilterHashtable @{LogName='Security';Id=4957} -ErrorAction SilentlyContinue ${extra}"`);

describe('address keywords', () => {
  it('are accepted', () => {
    expect(parseAddressSpec('DefaultGateway')).toBe('DefaultGateway');
    expect(parseAddressSpec(['dns', '10.0.0.9'])).toBe('DNS,10.0.0.9');
  });

  it('DefaultGateway matches the gateway only', () => {
    expect(addressSpecMatches('DefaultGateway', new IPAddress('10.0.0.254'), sets)).toBe(true);
    expect(addressSpecMatches('DefaultGateway', new IPAddress('10.0.0.9'), sets)).toBe(false);
  });

  it('LocalSubnet matches inside the subnet and not outside', () => {
    expect(addressSpecMatches('LocalSubnet', new IPAddress('10.0.0.77'), sets)).toBe(true);
    expect(addressSpecMatches('LocalSubnet', new IPAddress('10.0.1.77'), sets)).toBe(false);
  });

  it('fails closed when the sets are not known', () => {
    expect(addressSpecMatches('DNS', new IPAddress('10.0.0.53'))).toBe(false);
  });

  it('WITNESS: a plain address still matches', () => {
    expect(addressSpecMatches('10.0.0.9,10.0.1.0/24', new IPAddress('10.0.1.5'), sets)).toBe(true);
  });
});

describe('4957', () => {
  it('an empty set is detected, a plain address and a non-empty set are not', () => {
    expect(addressSetIsEmpty('WINS', sets)).toBe(true);
    expect(addressSetIsEmpty('DHCP,10.0.0.1', sets)).toBe(false);
    expect(addressSetIsEmpty('DNS', sets)).toBe(false);
  });

  it('the service start writes 4957 for a rule whose set is empty, as an audit failure', async () => {
    const out = await events(await lab(true), '| ForEach-Object { "$($_.Id) $($_.Message)" }');
    expect(out).toContain('Windows Firewall did not apply the following rule:');
    expect(out).toContain('Remote Address resolved to an empty set.');
    expect(out).toMatch(/Name:\tNoWins/);
  });

  it('writes nothing while failure auditing is off', async () => {
    expect((await events(await lab(false))).trim()).toBe('');
  });

  it('creating a rule whose set is empty writes 4957 at once, without a service restart', async () => {
    const pc = new WindowsPC('windows-pc', 'win2', 0, 0);
    pc.powerOn();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('auditpol /set /subcategory:"MPSSVC Rule-Level Policy Change" /failure:enable');
    await pc.executeCommand('powershell -Command "New-NetFirewallRule -DisplayName AtOnce -Direction Outbound -Action Block -RemoteAddress WINS | Out-Null"');
    expect(await events(pc, '| ForEach-Object { $_.Message }')).toContain('Remote Address resolved to an empty set.');
  });

  it('a rule with a plain address writes no 4957 when created', async () => {
    const pc = new WindowsPC('windows-pc', 'win3', 0, 0);
    pc.powerOn();
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('auditpol /set /subcategory:"MPSSVC Rule-Level Policy Change" /failure:enable');
    await pc.executeCommand('powershell -Command "New-NetFirewallRule -DisplayName Plain -Direction Outbound -Action Block -RemoteAddress 10.0.0.9 | Out-Null"');
    expect((await events(pc)).trim()).toBe('');
  });
});

describe('other documented address forms', () => {
  it('an IPv4 range is accepted and matches its bounds, not beyond', () => {
    expect(parseAddressSpec('10.0.0.5-10.0.0.9')).toBe('10.0.0.5-10.0.0.9');
    expect(addressSpecMatches('10.0.0.5-10.0.0.9', new IPAddress('10.0.0.9'))).toBe(true);
    expect(addressSpecMatches('10.0.0.5-10.0.0.9', new IPAddress('10.0.0.10'))).toBe(false);
  });

  it('a reversed range is refused', () => {
    expect(parseAddressSpec('10.0.0.9-10.0.0.5')).toBeNull();
  });

  it('a subnet by mask is read as its bit count, and a non-contiguous mask is refused', () => {
    expect(parseAddressSpec('10.0.1.0/255.255.255.0')).toBe('10.0.1.0/24');
    expect(addressSpecMatches(parseAddressSpec('10.0.1.0/255.255.255.0') ?? '', new IPAddress('10.0.1.200'))).toBe(true);
    expect(parseAddressSpec('10.0.1.0/255.0.255.0')).toBeNull();
  });

  it('a keyword restricted to IPv4 resolves like the keyword, one restricted to IPv6 is empty', () => {
    expect(parseAddressSpec('LocalSubnet4')).toBe('LocalSubnet4');
    expect(addressSpecMatches('LocalSubnet4', new IPAddress('10.0.0.77'), sets)).toBe(true);
    expect(addressSetIsEmpty('LocalSubnet6', sets)).toBe(true);
  });
});

describe('Internet, Intranet and the keywords the simulator has no source for', () => {
  it('Intranet matches the subnets the machine is attached to and the AD site subnets, not an address outside them', () => {
    for (const address of ['10.0.0.77', '192.168.50.9']) expect(addressSpecMatches('Intranet', new IPAddress(address), sets)).toBe(true);
    for (const address of ['10.0.1.77', '8.8.8.8']) expect(addressSpecMatches('Intranet', new IPAddress(address), sets)).toBe(false);
  });

  it('Internet is what is not the local intranet or the remote intranet (MS-FASP): the complement of Intranet, and fail closed without sets', () => {
    expect(addressSpecMatches('Internet', new IPAddress('8.8.8.8'), sets)).toBe(true);
    expect(addressSpecMatches('Internet', new IPAddress('10.0.0.77'), sets)).toBe(false);
    expect(addressSpecMatches('Internet', new IPAddress('8.8.8.8'))).toBe(false);
  });

  it('are accepted by the parser, with their canonical names and the 4/6 suffix', () => {
    expect(parseAddressSpec(['internet', 'INTRANET4', 'captiveportal'])).toBe('Internet,Intranet4,CaptivePortal');
    expect(addressSetIsEmpty('Internet6', sets)).toBe(true);
    expect(addressSetIsEmpty('Internet', sets)).toBe(false);
    expect(addressSetIsEmpty('Intranet', { ...sets, intranet: () => [] })).toBe(true);
  });

  it('IntranetRemoteAccess, PlayToDevice and CaptivePortal are empty sets: the machine has no DirectAccess, Play To renderer or captive portal', () => {
    for (const keyword of ['IntranetRemoteAccess', 'PlayToDevice', 'CaptivePortal']) {
      expect(addressSetIsEmpty(keyword, sets)).toBe(true);
      expect(addressSpecMatches(keyword, new IPAddress('10.0.0.1'), sets)).toBe(false);
    }
  });
});
