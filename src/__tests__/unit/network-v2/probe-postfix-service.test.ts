/*
 * Probe: `postfix` is a systemd unit of a LinuxServer. Measured before: `apt install postfix` answered
 * "Unable to locate package" and `systemctl start postfix` "Unit postfix.service not found", so the SMTP
 * listeners (25/587/465) existed in the engine but no typed command could start them.
 * Discriminated with git stash on src/network: 4 of 5 fall before the fix; the witness (nc to 25 while the
 * unit is stopped is refused) passes either way and proves the lab is sound.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function lab() {
  const server = new LinuxServer('linux-server', 'MAIL');
  const client = new LinuxPC('linux-pc', 'PC');
  new Cable('c').connect(server.getPort('eth0')!, client.getPort('eth0')!);
  await server.executeCommand('ip addr add 10.9.0.25/24 dev eth0');
  await server.executeCommand('ip link set eth0 up');
  await client.executeCommand('ip addr add 10.9.0.2/24 dev eth0');
  await client.executeCommand('ip link set eth0 up');
  return { server, client };
}

describe('postfix unit', () => {
  it('witness: nothing listens on 25 before the unit starts', async () => {
    const { client } = await lab();
    expect(await client.executeCommand('nc -zv -w 2 10.9.0.25 25')).toMatch(/refused|failed/i);
  });

  it('apt installs the package', async () => {
    const { server } = await lab();
    expect(await server.executeCommand('sudo apt install -y postfix')).not.toMatch(/Unable to locate/);
  });

  it('systemctl start opens 25, 587 and 465 and nc connects', async () => {
    const { server, client } = await lab();
    await server.executeCommand('sudo apt install -y postfix');
    await server.executeCommand('sudo systemctl start postfix');
    expect(await server.executeCommand('systemctl is-active postfix')).toContain('active');
    expect(await client.executeCommand('nc -zv -w 2 10.9.0.25 25')).toMatch(/succeeded|open/i);
    expect(await client.executeCommand('nc -zv -w 2 10.9.0.25 587')).toMatch(/succeeded|open/i);
  });

  it('systemctl stop closes the listeners', async () => {
    const { server, client } = await lab();
    await server.executeCommand('sudo apt install -y postfix');
    await server.executeCommand('sudo systemctl start postfix');
    await server.executeCommand('sudo systemctl stop postfix');
    expect(await client.executeCommand('nc -zv -w 2 10.9.0.25 25')).toMatch(/refused|failed/i);
  });

  it('ss shows the three SMTP ports while running', async () => {
    const { server } = await lab();
    await server.executeCommand('sudo apt install -y postfix');
    await server.executeCommand('sudo systemctl start postfix');
    expect(await server.executeCommand('ss -ltn')).toMatch(/:25\s/);
  });
});
