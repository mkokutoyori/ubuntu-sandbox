import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function buildPair() {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { pc, srv };
}

describe('nc / ncat — real TCP probe', () => {
  it('-z on a listening port (22 sshd) exits 0 with no output', async () => {
    const { pc } = await buildPair();
    const out = await pc.executeCommand('nc -z 10.0.0.2 22');
    expect(out).toBe('');
  });

  it('-zv on a listening port emits the OpenBSD "succeeded" line', async () => {
    const { pc } = await buildPair();
    const out = await pc.executeCommand('nc -zv 10.0.0.2 22');
    expect(out).toMatch(/Connection to 10\.0\.0\.2 22 port \[tcp\/ssh\] succeeded!/);
  });

  it('-zv on a closed port emits "Connection refused"', async () => {
    const { pc } = await buildPair();
    const out = await pc.executeCommand('nc -zv 10.0.0.2 9999');
    expect(out).toMatch(/connect to 10\.0\.0\.2 port 9999 \(tcp\) failed: Connection refused/);
  });

  it('-z on a closed port is silent (exit nonzero only)', async () => {
    const { pc } = await buildPair();
    const out = await pc.executeCommand('nc -z 10.0.0.2 9999');
    expect(out).toBe('');
  });

  it('ncat is an alias for nc', async () => {
    const { pc } = await buildPair();
    const out = await pc.executeCommand('ncat -zv 10.0.0.2 22');
    expect(out).toMatch(/succeeded/);
  });

  it('-l binds a real listening socket, visible to ss', async () => {
    const { pc } = await buildPair();
    await pc.executeCommand('nc -l -p 8080 &');
    const out = await pc.executeCommand('ss -tlnp');
    expect(out).toMatch(/LISTEN/);
    expect(out).toContain(':8080');
  });

  it('-u sends a real UDP datagram on the wire (no output, connectionless)', async () => {
    const { pc } = await buildPair();
    const out = await pc.executeCommand('nc -u 10.0.0.2 53');
    expect(out).toBe('');
  });

  it('-zuv reports success once the probes draw no port unreachable', async () => {
    const { pc, srv } = await buildPair();
    await srv.executeCommand('nc -lu -p 9000 &');
    expect(await pc.executeCommand('nc -zuv 10.0.0.2 9000')).toBe('Connection to 10.0.0.2 9000 port [udp/*] succeeded!');
  });

  it('-uv without -z and without a terminal on stdin tests nothing and reports nothing', async () => {
    const { pc } = await buildPair();
    expect(await pc.executeCommand('nc -uv 10.0.0.2 53')).toBe('');
  });

  it('prints usage when called with too few positional args', async () => {
    const { pc } = await buildPair();
    const out = await pc.executeCommand('nc');
    expect(out).toMatch(/^usage: nc/);
  });

  it('reports "No route to host" when the remote interface is down', async () => {
    const { pc, srv } = await buildPair();
    srv.getPorts()[0].setUp(false);
    const out = await pc.executeCommand('nc -zv 10.0.0.2 22');
    expect(out).toMatch(/No route to host|Connection refused/);
  });
});
