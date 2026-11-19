/*
 * Probe: only radtest existed, with its own copy of the request/response printing. Source of truth: FreeRADIUS v3.2.x
 * src/main/radclient.c (usage text and getopt string "46bc:d:D:f:Fhi:n:p:P:qr:sS:t:vx", the packet header lines printed by default,
 * the attribute lists and "Message-Authenticator = 0x" only with -x, "Expected Access-Accept got ..." and exit 1 when the expected
 * code does not come back, "No reply from server for ID %d socket %d", -c/-r/-t/-q/-s/-S/-f, the summary block, the version string)
 * and radtest.sh (which pipes its arguments to `radclient -x`). radtest now builds that input and runs the same engine, so the two
 * print one notation. The auth and acct commands are implemented (acct through the accounting client's new generic send);
 * auto is refused naming the missing brick, as are -6, -b, -F, -D, -n, -p, -P (status, coa and disconnect have their own probes).
 *
 * Discriminated with git stash on src: 16 of 17 fall before the fix; one passes either way and is named: the witness (radtest, now a
 * wrapper, still accepts a right login).
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
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

async function lab() {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(target, USERS_FILE_PATH, [
    'alice Cleartext-Password := "wonderland"',
    '\tReply-Message = "Hello, alice"',
    'DEFAULT Framed-Protocol == PPP, Cleartext-Password := "pppsecret"',
    '\tReply-Message = "ppp default"',
    '',
  ].join('\n'));
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function status(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const ALICE = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n'`;

describe('radclient', () => {
  it('witness: radtest, now a wrapper, still accepts a right login', async () => {
    const { client } = await lab();
    expect(await client.executeCommand('radtest alice wonderland 10.0.0.2 0 shared')).toContain('Received Access-Accept');
  });

  it('sends the packet read on stdin and prints the header lines of radclient.c, exit 0', async () => {
    const { client } = await lab();
    const result = await status(client, `${ALICE} | radclient 10.0.0.2 auth shared`);
    expect(result.output).toMatch(/^Sent Access-Request Id \d+ from 0\.0\.0\.0:\d+ to 10\.0\.0\.2:1812 length \d+\nReceived Access-Accept Id \d+ from 10\.0\.0\.2:1812 to 10\.0\.0\.1:\d+ length \d+$/);
    expect(result.code).toBe('0');
  });

  it('prints attributes only with -x', async () => {
    const { client } = await lab();
    expect((await status(client, `${ALICE} | radclient 10.0.0.2 auth shared`)).output).not.toContain('\tUser-Name');
    const debug = (await status(client, `${ALICE} | radclient -x 10.0.0.2 auth shared`)).output;
    expect(debug).toContain('\tUser-Name = "alice"');
    expect(debug).toContain('\tReply-Message = "Hello, alice"');
    expect(debug).toContain('\tMessage-Authenticator = 0x');
  });

  it('a wrong password is rejected, radclient says what it expected, exit 1', async () => {
    const { client } = await lab();
    const result = await status(client, `printf 'User-Name = "alice"\\nUser-Password = "nope"\\n' | radclient 10.0.0.2 auth shared`);
    expect(result.output).toContain('Received Access-Reject');
    expect(result.output).toContain('(0) -: Expected Access-Accept got Access-Reject');
    expect(result.code).toBe('1');
  });

  it('a wrong secret gets no reply: the request is repeated and the loss reported, exit 1', async () => {
    const { client } = await lab();
    const result = await status(client, `${ALICE} | radclient -t 1 -r 2 10.0.0.2 auth wrong`);
    expect(result.output.match(/^Sent Access-Request/gm)).toHaveLength(3);
    expect(result.output).toMatch(/\(0\) No reply from server for ID \d+ socket 3/);
    expect(result.code).toBe('1');
  });

  it('-q prints nothing', async () => {
    const { client } = await lab();
    expect(await status(client, `${ALICE} | radclient -q 10.0.0.2 auth shared`)).toEqual({ output: '', code: '0' });
  });

  it('-c sends each packet that many times', async () => {
    const { client } = await lab();
    const out = (await status(client, `${ALICE} | radclient -c 2 10.0.0.2 auth shared`)).output;
    expect(out.match(/^Sent Access-Request/gm)).toHaveLength(2);
    expect(out.match(/^Received Access-Accept/gm)).toHaveLength(2);
  });

  it('-s ends with the summary block', async () => {
    const { client } = await lab();
    const out = (await status(client, `${ALICE} | radclient -s 10.0.0.2 auth shared`)).output;
    expect(out).toContain('Packet summary:\n\tAccepted      : 1\n\tRejected      : 0\n\tLost          : 0');
  });

  it('-f reads the packets from a file and -S reads the secret from a file', async () => {
    const { client } = await lab();
    write(client, '/tmp/in.txt', 'User-Name = "alice"\nUser-Password = "wonderland"\n');
    write(client, '/tmp/secret', 'shared\n');
    expect((await status(client, 'radclient -f /tmp/in.txt -S /tmp/secret 10.0.0.2 auth')).output).toContain('Received Access-Accept');
  });

  it('extra attributes of the packet reach the server: Framed-Protocol = PPP selects the DEFAULT entry', async () => {
    const { client } = await lab();
    const out = (await status(client, `printf 'User-Name = "zed"\\nUser-Password = "pppsecret"\\nFramed-Protocol = PPP\\n' | radclient -x 10.0.0.2 auth shared`)).output;
    expect(out).toContain('Received Access-Accept');
    expect(out).toContain('\tReply-Message = "ppp default"');
  });

  it('prints the usage of radclient.c on a short call and exits 1', async () => {
    const result = await status((await lab()).client, 'radclient');
    expect(result.output.split('\n')[0]).toBe('Usage: radclient [options] server[:port] <command> [<secret>]');
    expect(result.code).toBe('1');
  });

  it('-v prints the version', async () => {
    expect((await status((await lab()).client, 'radclient -v')).output).toBe('radclient version 3.2.11');
  });

  it('acct sends the packet as an Accounting-Request to port 1813 and prints the Accounting-Response', async () => {
    const { client, target } = await lab();
    const result = await status(client, `printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "abc123"\\nCalling-Station-Id = "aa-bb"\\n' | radclient -x 10.0.0.2 acct shared`);
    expect(result.output).toMatch(/^Sent Accounting-Request Id \d+ from 0\.0\.0\.0:\d+ to 10\.0\.0\.2:1813 length \d+/);
    expect(result.output).toContain('\tAcct-Status-Type = Start');
    expect(result.output).toMatch(/Received Accounting-Response Id \d+ from 10\.0\.0\.2:1813 to 10\.0\.0\.1:\d+ length 20/);
    expect(result.code).toBe('0');
    expect(target.getRadiusServer().listAccountingSessions().map((session) => session.sessionId)).toContain('abc123');
  });

  it('every attribute of the acct packet is on the wire: the detail file of the server carries them', async () => {
    const { client, target } = await lab();
    await client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "abc123"\\nCalling-Station-Id = "aa-bb"\\n' | radclient 10.0.0.2 acct shared`);
    const dir = '/var/log/freeradius/radacct/10.0.0.1';
    const name = (await target.executeCommand(`ls ${dir}`)).trim().split(/\s+/).find((entry) => entry.startsWith('detail-')) ?? '';
    expect(vfsOf(target).readFile(`${dir}/${name}`) ?? '').toContain('\tCalling-Station-Id = "aa-bb"');
  });

  it('acct with a wrong secret gets no reply: the loss is reported, exit 1', async () => {
    const { client } = await lab();
    const result = await status(client, `printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "x"\\n' | radclient -t 1 -r 1 10.0.0.2 acct wrong`);
    expect(result.output).toMatch(/\(0\) No reply from server for ID \d+ socket 3/);
    expect(result.code).toBe('1');
  });

  it('the auto command is refused naming what is missing', async () => {
    const { client } = await lab();
    expect((await status(client, `${ALICE} | radclient 10.0.0.2 auto shared`)).output)
      .toContain('the auto command is not implemented in this simulator');
  });

  it('a packet without User-Name is refused rather than sent', async () => {
    const { client } = await lab();
    expect((await status(client, `printf 'User-Password = "x"\\n' | radclient 10.0.0.2 auth shared`)).output)
      .toContain('Packet is missing User-Name');
  });
});
