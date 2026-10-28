/*
 * Probe - imptcp on a simulated Linux host, with real frames and a real UNIX socket.  A client machine sends syslog text over TCP
 * to the host's imptcp listener (the stream crosses the simulated cable), `nc -U` writes to the module's UNIX stream socket (mode,
 * owner and unlink come from the input), the listener appears in `ss -ltn`, and an address already held by another listener is
 * reported with the owner the way log_bind_failure of imptcp.c names it ("one visible listener is PID n (comm)").
 * Measured before the module existed (git stash push -- src/network): 4 of the 5 cases fail - imptcp.so was not in the module
 * directory and the module was unknown.  The one that passes either way is the WITNESS, the ordinary imtcp listener on the same
 * machine, which accepts the same frames.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function configure(host: LinuxServer, text: string): Promise<void> {
  await host.executeCommand(`printf '${text.replace(/'/g, "'\\''")}\\n' > /etc/rsyslog.d/40-test.conf`);
  await host.executeCommand('systemctl restart rsyslog');
}

async function lab(listener: string): Promise<{ server: LinuxServer; client: LinuxPC }> {
  const server = new LinuxServer('linux-server', 'server1', 0, 0);
  const client = new LinuxPC('linux-pc', 'client1', 0, 0);
  server.powerOn();
  client.powerOn();
  new Cable('wire').connect(server.getPort('eth0')!, client.getPort('eth0')!);
  await server.executeCommand('ip addr add 192.168.50.1/24 dev eth0');
  await server.executeCommand('ip link set eth0 up');
  await client.executeCommand('ip addr add 192.168.50.2/24 dev eth0');
  await client.executeCommand('ip link set eth0 up');
  await configure(server, `${listener}\n*.* /var/log/ptcp.log`);
  return { server, client };
}

describe('imptcp on a Linux host', () => {
  it('witness: an imtcp listener files what a client sends over the wire', async () => {
    const { server, client } = await lab('module(load="imtcp")\ninput(type="imtcp" port="5514")');
    await client.executeCommand('echo "<13>Oct 19 12:00:01 client1 probe: over the wire" | nc -N 192.168.50.1 5514');
    expect(await server.executeCommand('cat /var/log/ptcp.log')).toContain('over the wire');
  });

  it('files what a client sends over the wire to an imptcp listener', async () => {
    const { server, client } = await lab('module(load="imptcp")\ninput(type="imptcp" port="5514")');
    await client.executeCommand('echo "<13>Oct 19 12:00:01 client1 probe: over the wire" | nc -N 192.168.50.1 5514');
    expect(await server.executeCommand('cat /var/log/ptcp.log')).toContain('over the wire');
  });

  it('shows the listener in ss with the backlog of the input (64 by default)', async () => {
    const { server } = await lab('module(load="imptcp")\ninput(type="imptcp" port="5514")');
    expect(await server.executeCommand('ss -ltn')).toMatch(/LISTEN\s+0\s+64\s+(\[::\]|0\.0\.0\.0|\*):5514/);
  });

  it('files what nc -U writes to the UNIX stream socket, which carries the requested mode', async () => {
    const { server } = await lab('module(load="imptcp")\ninput(type="imptcp" path="/run/ptcp.sock" fileCreateMode="0660")');
    await server.executeCommand('echo "<13>Oct 19 12:00:01 server1 probe: local stream" | nc -N -U /run/ptcp.sock');
    expect(await server.executeCommand('cat /var/log/ptcp.log')).toContain('local stream');
    expect(await server.executeCommand('ls -l /run/ptcp.sock')).toMatch(/^srw-rw----/);
  });

  it('names the process that holds the port when the bind fails', async () => {
    const { server } = await lab('module(load="imptcp")\ninput(type="imptcp" port="22")');
    const log = await server.executeCommand('grep "imptcp: Error binding" /var/log/syslog');
    expect(log).toMatch(/imptcp: Error binding TCP port 22: one visible listener is PID \d+ \(sshd\)/);
  });
});
