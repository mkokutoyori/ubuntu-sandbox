import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Bash shell constructs + network commands coexist', () => {
  let pc: LinuxPC;
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [pc, srv, sw].forEach((d) => d.powerOn());
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc.executeCommand('ifconfig eth0 192.168.1.1');
    await srv.executeCommand('ifconfig eth0 192.168.1.2');
  });

  it('for-loop with $var inside ping argument runs without parser error', async () => {
    const out = await pc.executeCommand('for i in 1 2 3; do ping -c 1 -W 1 192.168.1.$i >/dev/null; done');
    expect(out).not.toMatch(/syntax error/i);
    expect(out).not.toMatch(/do: command not found/);
    expect(out).not.toMatch(/done: command not found/);
  });

  it('brace expansion {1..5} works inside the for-loop', async () => {
    const out = await pc.executeCommand('for i in {1..5}; do ping -c 1 -W 1 192.168.1.$i >/dev/null; done');
    expect(out).not.toMatch(/syntax error/i);
  });

  it('$i is expanded inside a literal prefix.$i pattern', async () => {
    const out = await pc.executeCommand('i=2; ping -c 1 -W 1 192.168.1.$i');
    expect(out).not.toMatch(/unknown host 192\.168\.1\.\$i/);
  });

  it('the user-reported parallel ping sweep runs to completion', async () => {
    const script = `for i in {1..5}; do
  ping -c 1 -W 1 192.168.1.$i >/dev/null &
done
wait`;
    const out = await pc.executeCommand(script);
    expect(out).not.toMatch(/syntax error/i);
    expect(out).not.toMatch(/do: command not found/);
    expect(out).not.toMatch(/wait: command not found/);
  });

  it('the sweep actually populates the ARP cache with reachable hosts', async () => {
    const script = `for i in 1 2 3; do ping -c 1 -W 1 192.168.1.$i >/dev/null; done`;
    await pc.executeCommand(script);
    const arp = await pc.executeCommand('arp -n');
    expect(arp).toMatch(/^192\.168\.1\.2\b/m);
  });

  it('bash -c "<network cmd>" reaches the real machine network stack', async () => {
    await pc.executeCommand('bash -c "ping -c 1 -W 1 192.168.1.2 >/dev/null"');
    const arp = await pc.executeCommand('arp -n');
    expect(arp).toMatch(/^192\.168\.1\.2\b/m);
  });

  it('timeout wrapper around a network command reaches the real stack', async () => {
    await pc.executeCommand('timeout 5 ping -c 1 -W 1 192.168.1.2 >/dev/null');
    const arp = await pc.executeCommand('arp -n');
    expect(arp).toMatch(/^192\.168\.1\.2\b/m);
  });

  it('env VAR=v wrapper around a network command reaches the real stack', async () => {
    await pc.executeCommand('env FOO=bar ping -c 1 -W 1 192.168.1.2 >/dev/null');
    const arp = await pc.executeCommand('arp -n');
    expect(arp).toMatch(/^192\.168\.1\.2\b/m);
  });

  it('nohup wrapper around a network command reaches the real stack', async () => {
    await pc.executeCommand('nohup ping -c 1 -W 1 192.168.1.2 >/dev/null');
    const arp = await pc.executeCommand('arp -n');
    expect(arp).toMatch(/^192\.168\.1\.2\b/m);
  });
});
