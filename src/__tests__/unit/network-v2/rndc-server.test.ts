/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §3.1/§6 / P8 — RndcServer.ts: the real TCP
 * control channel `Bind9Service` opens according to `controls{}`. Drives a
 * raw TCP conversation exactly the way `RndcClient.ts` (P9) will, since that
 * module doesn't exist yet — this proves the server half end-to-end on its
 * own wire protocol (real TCP, real HMAC, real ACL), mirroring
 * `ssh-sftp-wire-migration.test.ts`'s "captured raw bytes" testing style.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import {
  signRndcEnvelope, encodeRndcEnvelope, decodeRndcEnvelope,
} from '@/network/devices/linux/bind9/RndcWireCodec';
import type { RndcRequest, RndcWireEnvelope } from '@/network/devices/linux/bind9/RndcWireCodec';

const NS1_IP = '10.0.5.10';
const PC1_IP = '10.0.5.2';
const OUTSIDER_IP = '10.0.5.3';
const SECRET_B64 = 'c2VjcmV0'; // base64("secret")

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@   IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '    IN NS  ns1.example.com.',
  'ns1 IN A   10.0.5.10',
  '',
].join('\n');

function namedConf(): string {
  return [
    'key "rndc-key" { algorithm hmac-sha256; secret "c2VjcmV0"; };',
    'controls {',
    `  inet ${NS1_IP} port 953 allow { ${PC1_IP}; } keys { "rndc-key"; };`,
    '};',
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
    '};',
    'zone "example.com" {',
    '  type primary;',
    '  file "/etc/bind/db.example.com";',
    '};',
    '',
  ].join('\n');
}

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

async function buildLab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const outsider = new LinuxPC('linux-pc', 'OUTSIDER');
  const srv = new LinuxServer('NS1');
  const sw = new GenericSwitch('switch-generic', 'SW');

  pc.configureInterface('eth0', new IPAddress(PC1_IP), new SubnetMask('255.255.255.0'));
  outsider.configureInterface('eth0', new IPAddress(OUTSIDER_IP), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));

  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(outsider.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c3').connect(srv.getPort('eth0')!, sw.getPorts()[2]);

  writeRoot(srv, '/etc/bind/named.conf', namedConf());
  writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
  await srv.executeCommand('systemctl start named');

  return { pc, outsider, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

async function connect(client: LinuxPC, port: number): Promise<TcpSocket | null> {
  return (client as unknown as { tcpConnect(h: string, p: number): Promise<TcpSocket | null> })
    .tcpConnect(NS1_IP, port);
}

function waitForEnvelope(socket: TcpSocket, timeoutMs = 1000): Promise<RndcWireEnvelope | null> {
  return new Promise((resolve) => {
    let buffer = new Uint8Array(0);
    let settled = false;
    const finish = (value: RndcWireEnvelope | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      const merged = new Uint8Array(buffer.length + data.length);
      merged.set(buffer, 0);
      merged.set(data, buffer.length);
      buffer = merged;
      const decoded = decodeRndcEnvelope(buffer);
      if (decoded) finish(decoded.envelope);
    });
    socket.onClose(() => finish(null));
    setTimeout(() => finish(null), timeoutMs);
  });
}

describe('RndcServer — real TCP control channel (PRD-Nslookup-Dig-Rndc-Runas.md P8)', () => {
  it('a correctly signed status request gets a correctly signed, real response over TCP', async () => {
    const { pc } = await buildLab();
    const socket = await connect(pc, 953);
    expect(socket).not.toBeNull();

    const request: RndcRequest = { nonce: 1, command: 'status' };
    const envelope = signRndcEnvelope(request, 'hmac-sha256', SECRET_B64);
    const pending = waitForEnvelope(socket!);
    socket!.send(encodeRndcEnvelope(envelope));

    const response = await pending;
    expect(response).not.toBeNull();
    expect(response!.payload).toMatchObject({ nonce: 1, result: 0 });
    expect((response!.payload as { text: string }).text).toContain('server is up and running');
  });

  it('a client outside the allow{} ACL never gets a response, even with the right key', async () => {
    const { outsider } = await buildLab();
    const socket = await connect(outsider, 953);

    if (socket) {
      const request: RndcRequest = { nonce: 1, command: 'status' };
      const envelope = signRndcEnvelope(request, 'hmac-sha256', SECRET_B64);
      const pending = waitForEnvelope(socket, 300);
      socket.send(encodeRndcEnvelope(envelope));
      const response = await pending;
      expect(response).toBeNull();
    }
  });

  it('rejects a request signed with the wrong key: not authenticated, unsigned reply, connection closed', async () => {
    const { pc } = await buildLab();
    const socket = await connect(pc, 953);
    expect(socket).not.toBeNull();

    const request: RndcRequest = { nonce: 7, command: 'status' };
    const envelope = signRndcEnvelope(request, 'hmac-sha256', 'd3JvbmdrZXk=');
    const pending = waitForEnvelope(socket!);
    socket!.send(encodeRndcEnvelope(envelope));

    const response = await pending;
    expect(response).not.toBeNull();
    expect(response!.hmac).toBe('');
    expect(response!.payload).toMatchObject({ nonce: 7, result: 1, text: 'not authenticated' });
  });

  it('executes a real rndc command through the unchanged RndcChannel (reload)', async () => {
    const { pc } = await buildLab();
    const socket = await connect(pc, 953);

    const request: RndcRequest = { nonce: 2, command: 'reload' };
    const envelope = signRndcEnvelope(request, 'hmac-sha256', SECRET_B64);
    const pending = waitForEnvelope(socket!);
    socket!.send(encodeRndcEnvelope(envelope));

    const response = await pending;
    expect((response!.payload as { text: string }).text).toContain('server reload successful');
  });

  it('does not open a control channel when no controls{} clause is configured', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('NS1');
    pc.configureInterface('eth0', new IPAddress(PC1_IP), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

    writeRoot(srv, '/etc/bind/named.conf', [
      'options { directory "/var/cache/bind"; recursion no; };',
      'zone "example.com" { type primary; file "/etc/bind/db.example.com"; };',
      '',
    ].join('\n'));
    writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
    await srv.executeCommand('systemctl start named');

    const socket = await connect(pc, 953);
    expect(socket).toBeNull();
  });
});
