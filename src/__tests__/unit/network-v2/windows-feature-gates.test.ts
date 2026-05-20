/**
 * Unit tests — Windows feature gates (Phase F).
 *
 * Every Windows command that depends on a service being Running must
 * refuse when the service is Stopped, with the cmd.exe-style refusal
 * line. The original simulator had zero such checks; this commit
 * threads them through the existing command surface.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { IPAddress, SubnetMask } from '@/network/core/types';

describe('Windows feature gating', () => {
  let pc: WindowsPC;

  beforeEach(() => {
    pc = new WindowsPC('windows-pc', 'win-pc', 0, 0);
    pc.setCurrentUser('Administrator');  // net stop requires admin
    pc.getPorts()[0].configureIP(new IPAddress('192.168.1.50'), new SubnetMask('255.255.255.0'));
  });

  // ─── ipconfig ↔ Dhcp ────────────────────────────────────────────────

  it('ipconfig /renew refuses when Dhcp is stopped', async () => {
    await pc.executeCommand('net stop Dhcp');
    const out = await pc.executeCommand('ipconfig /renew');
    expect(out).toMatch(/DHCP Client Service is not running/i);
  });

  it('ipconfig /release refuses when Dhcp is stopped', async () => {
    await pc.executeCommand('net stop Dhcp');
    const out = await pc.executeCommand('ipconfig /release');
    expect(out).toMatch(/DHCP Client Service is not running/i);
  });

  it('ipconfig (no args) still works regardless of Dhcp state', async () => {
    await pc.executeCommand('net stop Dhcp');
    const out = await pc.executeCommand('ipconfig');
    expect(out).toContain('Windows IP Configuration');
    expect(out).not.toMatch(/DHCP Client Service is not running/i);
  });

  // ─── ping hostname ↔ Dnscache ───────────────────────────────────────

  it('ping <hostname> refuses when Dnscache is stopped', async () => {
    await pc.executeCommand('net stop Dnscache');
    const out = await pc.executeCommand('ping mywebsite.example');
    expect(out).toMatch(/Ping request could not find host|DNS servers/i);
  });

  it('ping <ip> works even when Dnscache is stopped', async () => {
    await pc.executeCommand('net stop Dnscache');
    const out = await pc.executeCommand('ping 127.0.0.1');
    expect(out).not.toMatch(/DNS servers/i);
  });

  // ─── nslookup ↔ Dnscache ────────────────────────────────────────────

  it('nslookup refuses when Dnscache is stopped', async () => {
    await pc.executeCommand('net stop Dnscache');
    const out = await pc.executeCommand('nslookup example.com');
    expect(out).toMatch(/No DNS servers available|service is not running/i);
  });

  // ─── netsh advfirewall ↔ mpssvc ─────────────────────────────────────

  it('netsh advfirewall show rule refuses when mpssvc is stopped', async () => {
    await pc.executeCommand('net stop mpssvc');
    const out = await pc.executeCommand('netsh advfirewall firewall show rule all');
    expect(out).toMatch(/Windows Firewall service is not running/i);
  });

  it('netsh advfirewall add rule refuses when mpssvc is stopped', async () => {
    await pc.executeCommand('net stop mpssvc');
    const out = await pc.executeCommand('netsh advfirewall firewall add rule name=test dir=in action=allow protocol=TCP localport=80');
    expect(out).toMatch(/Windows Firewall service is not running/i);
  });

  // ─── wevtutil ↔ EventLog ────────────────────────────────────────────

  it('wevtutil refuses when EventLog is stopped', async () => {
    await pc.executeCommand('net stop EventLog');
    const out = await pc.executeCommand('wevtutil qe System /c:5');
    expect(out).toMatch(/Event Log service is not running/i);
  });
});
