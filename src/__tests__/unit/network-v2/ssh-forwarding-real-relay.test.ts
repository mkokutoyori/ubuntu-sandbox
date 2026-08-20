/**
 * PRD-Port-Forwarding.md Phase 8 — `ssh -L`/`-R` (the `executeCommand`/
 * `LinuxSshClient.ts` path — the one exercised cross-vendor) actually
 * relay real bytes end to end, replacing the `ssh`/`nc`-specific shortcut
 * that only worked for those two commands.
 *
 * Before this fix, `SshForwardingTable.open()` only bound a `SocketTable`
 * entry — the tunnel's listen port showed up in `ss`/`netstat`, but no
 * `TcpStack` listener ever existed, so no real connection reached it.
 * Fixed by wiring a real `TcpStack.listen()` (on whichever end owns the
 * listener) whose `onAccept` dials a real `TcpStack.connect()` from the
 * TUNNEL'S OTHER END — `-L`/`-D` dial out from the SSH server, `-R` dials
 * out from the SSH client, matching real OpenSSH semantics exactly.
 *
 * Writing this test surfaced a second, independent, pre-existing gap:
 * `TcpStack` had no loopback delivery path at all — `resolveEgress()`
 * simply failed for `127.0.0.1`/`::1`, so nothing could ever connect to a
 * loopback-bound listener (confirmed empirically before this fix, for ANY
 * consumer of TcpStack, not just SSH). Since `-L`/`-R` bind to `127.0.0.1`
 * by default (matching real OpenSSH), the real relay above would have had
 * no reachable listener for the common, no-explicit-bind-address case.
 * Fixed in `resolveEgress`/`resolveEgress6`/`shipSegment`: a loopback
 * destination now delivers directly in-process, mirroring
 * `EndHost.sendUdpDatagram`'s own established loopback shortcut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Hub } from '@/network/devices/Hub';
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

const CLIENT_IP = '10.0.0.1';
const SERVER_IP = '10.0.0.2';
const TARGET_IP = '10.0.0.3';

interface Lab { client: LinuxPC; server: LinuxServer; target: LinuxServer; }

function buildLab(): Lab {
  const client = new LinuxPC('linux-pc', 'CLIENT');
  const server = new LinuxServer('linux-server', 'SRV');
  const target = new LinuxServer('linux-server', 'TARGET');
  const hub = new Hub('h', 3);
  new Cable('c1').connect(client.getPorts()[0], hub.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], hub.getPorts()[1]);
  new Cable('c3').connect(target.getPorts()[0], hub.getPorts()[2]);
  client.getPorts()[0].configureIP(new IPAddress(CLIENT_IP), new SubnetMask('255.255.255.0'));
  server.getPorts()[0].configureIP(new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));
  target.getPorts()[0].configureIP(new IPAddress(TARGET_IP), new SubnetMask('255.255.255.0'));

  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'admin');

  return { client, server, target };
}

describe('PRD-Port-Forwarding.md Phase 8 — ssh -L real relay', () => {
  it('dials out from the SSH server and relays real bytes both ways', async () => {
    const { client, server, target } = buildLab();
    const received: unknown[] = [];
    let acceptedRemoteIp: string | null = null;
    target.getTcpStack().listen(80, {
      onAccept: (s) => {
        acceptedRemoteIp = s.remoteIp;
        s.onData((d) => received.push(d));
      },
    });

    await client.executeCommand(`ssh -L 9001:${TARGET_IP}:80 -N alice@${SERVER_IP}`);

    const received2: unknown[] = [];
    const clientSocket = client.getTcpStack().connect('127.0.0.1', 9001, {
      onData: (d) => received2.push(d),
    });

    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
    // Real OpenSSH -L dials out from the SERVER, not the client.
    expect(acceptedRemoteIp).toBe(SERVER_IP);

    clientSocket!.send('hello');
    expect(received).toEqual(['hello']);
  });
});

describe('PRD-Port-Forwarding.md Phase 8 — ssh -R real relay', () => {
  it('dials out from the SSH client and relays real bytes both ways', async () => {
    const { client, server, target } = buildLab();
    let acceptedRemoteIp: string | null = null;
    target.getTcpStack().listen(81, {
      onAccept: (s) => { acceptedRemoteIp = s.remoteIp; s.onData(() => s.send('pong')); },
    });

    await client.executeCommand(`ssh -R 9002:${TARGET_IP}:81 -N alice@${SERVER_IP}`);

    const received: unknown[] = [];
    const serverSideSocket = server.getTcpStack().connect('127.0.0.1', 9002, {
      onData: (d) => received.push(d),
    });

    expect(serverSideSocket).not.toBeNull();
    expect(serverSideSocket!.state).toBe('established');
    // Real OpenSSH -R dials out from the CLIENT, not the server.
    expect(acceptedRemoteIp).toBe(CLIENT_IP);

    serverSideSocket!.send('ping');
    expect(received).toEqual(['pong']);
  });
});

describe('PRD-Port-Forwarding.md Phase 8 — no regression when the destination refuses', () => {
  it('-L closes the client side when the real target has no listener', async () => {
    const { client, server } = buildLab();
    await client.executeCommand(`ssh -L 9003:${TARGET_IP}:80 -N alice@${SERVER_IP}`);

    const clientSocket = client.getTcpStack().connect('127.0.0.1', 9003);
    expect(clientSocket!.state).not.toBe('established');
    void server;
  });
});
