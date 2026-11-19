/*
 * Probe: Status-Server (RFC 5997) did not exist anywhere; radclient refused its status command. Source of truth: FreeRADIUS
 * v3.2.x src/main/listen.c (auth_socket_recv / acct_socket_recv: unknown client discarded first, then "Ignoring Status-Server
 * request due to security configuration" when security.status_server is off; rad_status_server answers Access-Accept on the auth
 * port and Accounting-Response on the accounting port), src/lib/radius.c (Status-Server requires Message-Authenticator; code2ma adds
 * it, FIRST, to the request and to the reply of a Status-Server; "Received packet from %s with invalid Message-Authenticator!"),
 * src/main/mainconfig.c (status_server defaults to yes), raddb/radiusd.conf.in (security { status_server = yes }), src/main/radclient.c
 * (status uses the auth port, the expected reply follows the port, "Message-Authenticator = 0x" printed with -x when the input has
 * none, stats.passed counted for every reply matching the expected code).
 *
 * Discriminated with git stash on src: 12 of 13 fall before the fix (the wrong-secret and unknown-client cases too, since radclient
 * refused the status command outright). One passes either way and is named: the witness (an auth request in the same lab is accepted).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH, RADIUSD_CONF_PATH } from '@/network/devices/linux/freeradius/RadiusdService';
import { DEFAULT_RADIUSD_CONF } from '@/network/devices/linux/freeradius/DefaultRadiusdConf';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

async function lab(clientIp = '10.0.0.1') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, `client lab {\n  ipaddr = ${clientIp}\n  secret = shared\n}\n`);
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function run(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const PING = `printf 'Message-Authenticator = 0x00\\n'`;

describe('Status-Server', () => {
  it('witness: an auth request in the same lab is accepted', async () => {
    const { client } = await lab();
    expect((await run(client, `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient 10.0.0.2 auth shared`)).output)
      .toContain('Received Access-Accept');
  });

  it('radclient status goes to the auth port and the server answers Access-Accept carrying only Message-Authenticator', async () => {
    const { client } = await lab();
    const result = await run(client, `${PING} | radclient 10.0.0.2 status shared`);
    expect(result.output).toMatch(/^Sent Status-Server Id \d+ from 0\.0\.0\.0:\d+ to 10\.0\.0\.2:1812 length 38\nReceived Access-Accept Id \d+ from 10\.0\.0\.2:1812 to 10\.0\.0\.1:\d+ length 38$/);
    expect(result.code).toBe('0');
  });

  it('on the accounting port the answer is an Accounting-Response', async () => {
    const { client } = await lab();
    const result = await run(client, `${PING} | radclient 10.0.0.2:1813 status shared`);
    expect(result.output).toMatch(/Received Accounting-Response Id \d+ from 10\.0\.0\.2:1813 to 10\.0\.0\.1:\d+ length 38/);
    expect(result.code).toBe('0');
  });

  it('-x prints the Message-Authenticator radclient adds, then the input, then the reply attributes', async () => {
    const { client } = await lab();
    const out = (await run(client, `printf 'User-Name = "probe"\\n' | radclient -x 10.0.0.2 status shared`)).output;
    expect(out).toMatch(/^Sent Status-Server Id \d+ .* length 45\n\tMessage-Authenticator = 0x\n\tUser-Name = "probe"\nReceived Access-Accept/);
    expect(out).toMatch(/\n\tMessage-Authenticator = 0x[0-9a-f]{32}$/);
  });

  it('-s counts the reply as accepted and as passing the filter', async () => {
    const { client } = await lab();
    expect((await run(client, `${PING} | radclient -s 10.0.0.2 status shared`)).output)
      .toContain('Packet summary:\n\tAccepted      : 1\n\tRejected      : 0\n\tLost          : 0\n\tPassed filter : 1\n\tFailed filter : 0');
  });

  it('-s on auth counts a matching reply as passing the filter, as radclient.c does', async () => {
    const { client } = await lab();
    expect((await run(client, `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -s 10.0.0.2 auth shared`)).output)
      .toContain('\tPassed filter : 1\n\tFailed filter : 0');
  });

  it('the shipped radiusd.conf carries security { status_server = yes }', () => {
    expect(DEFAULT_RADIUSD_CONF).toContain('security {\n\tstatus_server = yes\n}');
  });

  it('status_server = no: the request is ignored, radius.log says why, radclient loses the packet', async () => {
    const { client, target } = await lab();
    write(target, RADIUSD_CONF_PATH, DEFAULT_RADIUSD_CONF.replace('status_server = yes', 'status_server = no'));
    await target.executeCommand('systemctl reload freeradius');
    const result = await run(client, `${PING} | radclient -t 1 -r 1 10.0.0.2 status shared`);
    expect(result.output).toMatch(/\(0\) No reply from server for ID \d+ socket 3/);
    expect(result.code).toBe('1');
    expect(vfsOf(target).readFile('/var/log/freeradius/radius.log') ?? '')
      .toMatch(/ : Warning: Ignoring Status-Server request due to security configuration\n/);
  });

  it('status_server takes a boolean: anything else fails the configuration in conffile.c words', async () => {
    const { target } = await lab();
    write(target, RADIUSD_CONF_PATH, DEFAULT_RADIUSD_CONF.replace('status_server = yes', 'status_server = maybe'));
    expect(target.getRadiusd().checkConfig())
      .toEqual({ ok: false, error: `${RADIUSD_CONF_PATH}[16]: Invalid value 'maybe' for boolean variable status_server` });
  });

  it('a wrong secret fails the Message-Authenticator: no reply', async () => {
    const { client } = await lab();
    const result = await run(client, `${PING} | radclient -t 1 -r 1 10.0.0.2 status wrong`);
    expect(result.output).toMatch(/No reply from server/);
    expect(result.code).toBe('1');
  });

  it('a Status-Server without Message-Authenticator is discarded as insecure', async () => {
    const { client, target } = await lab();
    const port = client.getPort('eth0')!;
    let replies = 0;
    target.getRadiusServer().setPacketTrace((event) => { if (event.direction === 'sent') replies++; });
    target.getRadiusServer().handleUdp('eth0', port.getIPAddress()!, {
      sourcePort: 40000, destinationPort: 1812, length: 28, checksum: 0,
      payload: { type: 'radius', code: 'status-server', identifier: 7, authenticator: '11'.repeat(16), attributes: [] },
    } as never);
    expect(replies).toBe(0);
    expect(Logger.getLogs().some((entry) => entry.message.includes('Insecure packet from host 10.0.0.1'))).toBe(true);
  });

  it('a client absent from clients.conf gets no answer', async () => {
    const { client } = await lab('10.0.0.9');
    expect((await run(client, `${PING} | radclient -t 1 -r 1 10.0.0.2 status shared`)).output).toMatch(/No reply from server/);
  });

  it('freeradius -X traces the Status-Server and its answer', async () => {
    const { client, target } = await lab();
    const lines: string[] = [];
    const stop = target.followRadiusDebug((line) => lines.push(line));
    await client.executeCommand(`${PING} | radclient 10.0.0.2 status shared`);
    stop();
    expect(lines.join('\n')).toMatch(/\(0\) Received Status-Server Id \d+ from 10\.0\.0\.1:\d+ to 10\.0\.0\.2:1812 length 38\n\(0\)   Message-Authenticator = 0x[0-9a-f]{32}\n\(0\) Sent Access-Accept Id \d+ from 10\.0\.0\.2:1812 to 10\.0\.0\.1:\d+ length 38/);
  });
});
