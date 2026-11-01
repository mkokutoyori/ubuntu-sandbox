/*
 * Probe — in command mode PowerShell reads `-name=value` as ONE generic argument, the way its tokenizer does,
 * so `nslookup -type=MX host` reaches nslookup with the option it was given.
 *
 * Measured first (a Windows PC in PowerShell, the same lab in cmd): `nslookup -type=MX example.com` printed the
 * usage line and then "The term '=' is not recognized as the name of a cmdlet" — the parser cut the argument into
 * the parameter `-type`, the operator `=` and the word `MX`, and tried to run `= MX example.com` as a second
 * command. In cmd the same line answered with the MX record. `echo -type=MX` failed the same way, so the defect
 * is the parser's, not nslookup's.
 *
 * Authority: about_Parsing (Microsoft Learn) — in argument mode "everything else is treated as an expandable
 * string": a token that begins with a dash but continues past the parameter name with a character other than
 * `:` or a delimiter is a generic token, not a parameter; ForceStartNewToken ends a generic token at whitespace
 * and at ; , | & ( ) { }.
 *
 * Discrimination (the probe run on the tree before the change): 5 of the 9 cases fall. The four that pass either
 * way are the WITNESS (the same lookup without an option answers), two NON-REGRESSIONS (a real parameter still
 * binds its value; a comparison operator still compares) and the NEGATIVE CONTROL (a dash word followed by a
 * space is still a parameter, so `-type MX` is still not glued into one argument).
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function lab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  srv.dnsService.start();
  srv.dnsService.addRecord({ name: 'example.com', type: 'A', value: '93.184.216.34', ttl: 3600 });
  srv.dnsService.addRecord({ name: 'example.com', type: 'MX', value: 'mail.example.com', priority: 10, ttl: 3600 });
  srv.dnsService.addRecord({ name: 'mail.example.com', type: 'A', value: '10.0.0.25', ttl: 3600 });
  (pc as unknown as { dnsConfig: Map<string, { servers: string[]; mode: string }> })
    .dnsConfig = new Map([['eth0', { servers: ['10.0.0.2'], mode: 'static' }]]);
  const shell = PowerShellSubShell.create(pc as never).subShell;
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  const cmd = (line: string): Promise<string> => pc.executeCmdCommand(line);
  return { ps, cmd };
}

describe('a dash word glued to = and a value is one argument', () => {
  it('WITNESS: nslookup without an option answers an address', async () => {
    const { ps } = lab();
    expect(await ps('nslookup example.com')).toMatch(/93\.184\.216\.34/);
  });

  it('nslookup -type=MX reaches nslookup with its option, as in cmd', async () => {
    const { ps, cmd } = lab();
    const fromPowerShell = await ps('nslookup -type=MX example.com');
    expect(fromPowerShell).toContain('mail.example.com');
    expect(fromPowerShell).not.toMatch(/Usage: nslookup|is not recognized/);
    expect(fromPowerShell).toBe(await cmd('nslookup -type=MX example.com'));
  });

  it('the server argument after the option is still the server', async () => {
    const { ps } = lab();
    const out = await ps('nslookup -type=MX example.com 10.0.0.2');
    expect(out).toContain('mail.example.com');
    expect(out).not.toMatch(/is not recognized/);
  });

  it('echo prints the argument unsplit', async () => {
    const { ps } = lab();
    expect(await ps('echo -type=MX')).toBe('-type=MX');
  });

  it('a variable and a quoted value glue into the same argument', async () => {
    const { ps } = lab();
    expect(await ps("$t = 'MX'; echo -type=$t")).toBe('-type=MX');
    expect(await ps('echo -type="MX"')).toBe('-type=MX');
  });

  it('the argument is also taken on the right of an assignment', async () => {
    const { ps } = lab();
    expect(await ps('$x = echo -k=v; $x')).toBe('-k=v');
  });

  it('NEGATIVE CONTROL: a dash word followed by a space is still a parameter', async () => {
    const { ps } = lab();
    expect(await ps('Write-Output -InputObject abc')).toBe('abc');
  });

  it('NON-REGRESSION: a real parameter still binds its value', async () => {
    const { ps } = lab();
    await ps('Resolve-DnsName example.com');
    expect((await ps('(Get-DnsClientCache -Entry example.com).Entry')).trim()).toBe('example.com');
  });

  it('NON-REGRESSION: a comparison operator still compares', async () => {
    const { ps } = lab();
    expect(await ps('1 -eq 1')).toBe('True');
    expect(await ps("'a' -ne 'b'")).toBe('True');
  });
});
