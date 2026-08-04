/**
 * PRD-Port-Forwarding.md Phase 7 — `netsh interface portproxy` is a real
 * application-level relay, not just `netstat` decor.
 *
 * Before this fix, `PortProxySocketProjection.onAdded()` only bound a
 * `SocketTable` entry — the listen port showed up in `netstat`, but no
 * `TcpStack` listener ever existed, so nothing a real client sent could
 * ever reach a real server at `connectaddress:connectport`, and no PRD or
 * BRD in this repo distinguished that from a genuine relay. Fixed by
 * opening a real `TcpStack.listen()` on the rule's listen endpoint whose
 * `onAccept` dials a real `TcpStack.connect()` to the rule's connect
 * endpoint and pipes bytes both ways — an application bridge (like
 * `socat`), matching real `iphlpsvc`, which needs no IP-level forwarding
 * either. Unlike Phase 5/6's NAT rewrites, this is two independent,
 * ordinary TCP connections either side of the relay, so — unlike a NAT
 * redirect — there is no reply-path address/port mismatch: both legs
 * reach `established` and carry data in both directions for real.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const CLIENT_IP = '10.0.0.1';
const GW_CLIENT_SIDE_IP = '10.0.0.2';
const GW_SERVER_SIDE_IP = '10.0.1.1';
const SERVER_IP = '10.0.1.2';
const LISTEN_PORT = 8080;
const CONNECT_PORT = 80;

interface Lab { client: LinuxPC; gw: WindowsPC; server: LinuxServer; }

async function buildLab(): Promise<Lab> {
  const client = new LinuxPC('linux-pc', 'CLIENT');
  const gw = new WindowsPC('windows-pc', 'GW');
  const server = new LinuxServer('linux-server', 'SRV');

  client.configureInterface('eth0', new IPAddress(CLIENT_IP), new SubnetMask('255.255.255.0'));
  gw.getPort('eth0')!.configureIP(new IPAddress(GW_CLIENT_SIDE_IP), new SubnetMask('255.255.255.0'));
  gw.getPort('eth1')!.configureIP(new IPAddress(GW_SERVER_SIDE_IP), new SubnetMask('255.255.255.0'));
  server.configureInterface('eth0', new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));

  client.setDefaultGateway(new IPAddress(GW_CLIENT_SIDE_IP));
  server.setDefaultGateway(new IPAddress(GW_SERVER_SIDE_IP));

  new Cable('c1').connect(client.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('c2').connect(gw.getPort('eth1')!, server.getPort('eth0')!);

  await gw.executeCommand(
    `netsh interface portproxy add v4tov4 listenaddress=${GW_CLIENT_SIDE_IP} listenport=${LISTEN_PORT} ` +
    `connectaddress=${SERVER_IP} connectport=${CONNECT_PORT}`,
  );

  return { client, gw, server };
}

describe('PRD-Port-Forwarding.md Phase 7 — portproxy relays real TCP data', () => {
  it('a real client connection reaches the real server through the relay', async () => {
    const { client, server } = await buildLab();
    const receivedAtServer: unknown[] = [];
    let acceptedRemoteIp: string | null = null;
    server.getTcpStack().listen(CONNECT_PORT, {
      onAccept: (s) => {
        acceptedRemoteIp = s.remoteIp;
        s.onData((d) => receivedAtServer.push(d));
      },
    });

    const clientSocket = client.getTcpStack().connect(GW_CLIENT_SIDE_IP, LISTEN_PORT);

    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
    // The server sees the connection as coming from the gateway's
    // server-side address — a real application relay, not NAT: the
    // gateway dialed the server itself, as a genuinely separate socket.
    expect(acceptedRemoteIp).toBe(GW_SERVER_SIDE_IP);

    clientSocket!.send('hello');
    expect(receivedAtServer).toEqual(['hello']);
  });

  it('the server can reply and the client receives it through the relay', async () => {
    const { client, server } = await buildLab();
    server.getTcpStack().listen(CONNECT_PORT, {
      onAccept: (s) => {
        s.onData(() => s.send('world'));
      },
    });

    const receivedAtClient: unknown[] = [];
    const clientSocket = client.getTcpStack().connect(GW_CLIENT_SIDE_IP, LISTEN_PORT, {
      onData: (d) => receivedAtClient.push(d),
    });

    clientSocket!.send('hello');
    expect(receivedAtClient).toEqual(['world']);
  });

  it('closing the client side closes the relay leg to the server', async () => {
    const { client, server } = await buildLab();
    let serverSideClosed = false;
    server.getTcpStack().listen(CONNECT_PORT, {
      onAccept: (s) => { s.onClose(() => { serverSideClosed = true; }); },
    });

    const clientSocket = client.getTcpStack().connect(GW_CLIENT_SIDE_IP, LISTEN_PORT);
    clientSocket!.close();

    expect(serverSideClosed).toBe(true);
  });

  it('a connect side with no real listener refuses the accepted client connection (no regression on a dangling rule)', async () => {
    const { client } = await buildLab();
    // No listener registered on CONNECT_PORT at the server: the relay's
    // own connect() attempt is refused, so the client side must not hang
    // in a half-open state either.
    const clientSocket = client.getTcpStack().connect(GW_CLIENT_SIDE_IP, LISTEN_PORT);
    expect(clientSocket!.state).not.toBe('established');
  });

  it('netstat visibility still works (no regression on prior phases)', async () => {
    // netstat's own address rendering for a LISTEN entry is a pre-existing,
    // unrelated quirk (already covered by windows-port-forwarding.test.ts's
    // PP-02) — this only re-confirms the port itself still surfaces once a
    // real TcpStack listener is also opened alongside the SocketTable bind.
    const { gw } = await buildLab();
    const out = await gw.executeCommand('netstat -an');
    expect(out).toMatch(new RegExp(`0\\.0\\.0\\.0:${LISTEN_PORT}\\s+0\\.0\\.0\\.0:0\\s+LISTENING`));
  });
});
