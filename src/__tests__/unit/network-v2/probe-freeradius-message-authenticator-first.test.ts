/*
 * Probe: the server put the Message-Authenticator of its Access-Accept / Access-Reject last. Source of truth: FreeRADIUS v3.2.x
 * src/lib/radius.c rad_encode: for every code in code2ma (Access-Request, Access-Accept, Access-Reject, Access-Challenge,
 * Status-Server, Protocol-Error) and for any reply to such a request, "It must be the FIRST attribute in the packet" (the
 * Blast RADIUS mitigation, CVE-2024-3596: a forged reply cannot be crafted from an attribute the attacker controls before it). The
 * Message-Authenticator HMAC covers the packet in that order, so the order is part of what the client verifies.
 *
 * Discriminated with git stash on src: 2 of 4 fall before the fix (the accept and the reject, which both carry another attribute);
 * two pass either way and are named: the witness (the reply still verifies at the client) and the Status-Server (its reply holds
 * the Message-Authenticator and nothing else, so its position cannot differ).
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

async function lab(clientIp = '10.0.0.1', users = 'alice Cleartext-Password := "wonderland"\n') {
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
  write(target, USERS_FILE_PATH, users);
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function run(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const ALICE = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n'`;

function replyAttributes(output: string): string[] {
  const lines = output.split('\n');
  const at = lines.findIndex((line) => line.startsWith('Received '));
  return lines.slice(at + 1).filter((line) => line.startsWith('\t')).map((line) => line.trim().split(' ')[0]);
}

async function labFor(users: string) {
  return lab('10.0.0.1', users);
}

describe('Message-Authenticator first', () => {
  it('witness: the reply still verifies at the client', async () => {
    const { client } = await labFor('alice Cleartext-Password := "wonderland"\n\tReply-Message = "hello"\n');
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('an Access-Accept carrying reply attributes starts with the Message-Authenticator', async () => {
    const { client } = await labFor('alice Cleartext-Password := "wonderland"\n\tReply-Message = "hello",\n\tSession-Timeout = 600\n');
    expect(replyAttributes(await client.executeCommand(`${ALICE} | radclient -x 10.0.0.2 auth shared`))).toEqual(['Message-Authenticator', 'Reply-Message', 'Session-Timeout']);
  });

  it('an Access-Reject that carries a Reply-Message starts with the Message-Authenticator too', async () => {
    const { client } = await labFor('alice Cleartext-Password := "wonderland", Simultaneous-Use := 1\n');
    await client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s1"\\nNAS-Port = 1\\n' | radclient 10.0.0.2 acct shared`);
    const out = await client.executeCommand(`${ALICE} | radclient -x 10.0.0.2 auth shared`);
    expect(out).toContain('Received Access-Reject');
    expect(replyAttributes(out)).toEqual(['Message-Authenticator', 'Reply-Message']);
  });

  it('a Status-Server request is signed with the attribute first as well: the server accepts it and answers', async () => {
    const { client } = await labFor('alice Cleartext-Password := "wonderland"\n');
    const out = await client.executeCommand(`printf 'User-Name = "probe"\\n' | radclient -x 10.0.0.2 status shared`);
    expect(out).toContain('Received Access-Accept');
    expect(replyAttributes(out)).toEqual(['Message-Authenticator']);
  });
});
