/*
 * Probe: `curl -x`/`--proxy` was refused ("not implemented in this simulator") and the FortiGate had no explicit web proxy. FortiOS
 * 7.4.12 documents `config web-proxy explicit` (status, http-incoming-port default 8080, sec-default-action deny|accept, p.2409),
 * `config firewall proxy-policy` (proxy explicit-web, srcintf, dstintf, srcaddr, dstaddr, schedule, action accept|deny, p.602) and
 * `set explicit-web-proxy enable` on a system interface. curl now sends a plain-HTTP request to the proxy in absolute form
 * (`GET http://host/path HTTP/1.1`), and the unit listens on the proxy port of the interfaces that enable it, picks the first
 * matching proxy policy (disabled and out-of-schedule ones skipped; the default action when none matches), answers 403 on deny,
 * and otherwise relays the request to the origin over a real connection and returns its answer. HTTPS is relayed as a tunnel (curl sends CONNECT host:port, the proxy applies the same policy, answers 200 and relays the TLS bytes, or
 * refuses with its status and curl says `(56) CONNECT tunnel failed, response 403`); `redirect` plus the non-explicit proxy types
 * are refused in the schema.
 * The 403 body text is the simulator's own: the replacement page of FortiOS is not in any source here.
 *
 * PC -- port2 [FGT] port3 -- server; NO ordinary firewall policy exists, so only the proxy path can carry the request.
 * Discriminated with git stash on src/network: 7 of 10 fall before the proxy existed (the last two only before CONNECT); the witness (the origin answers its own network),
 * the direct-curl case (no firewall policy: no answer) and the disabled-proxy case (nothing is served either way) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function type(device: Cmd, lines: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
}

const policy = (id: number, action: string, extra: readonly string[] = []) => [
  'config firewall proxy-policy', `edit ${id}`, 'set proxy explicit-web', 'set srcintf "port2"', 'set dstintf "port3"',
  'set srcaddr "all"', 'set dstaddr "all"', `set action ${action}`, ...extra, 'next', 'end',
];

async function lab(proxyLines: readonly string[], interfaceFlag = true) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);
  await type(pc, ['ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 192.168.10.1']);
  await type(srv, ['ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 192.168.20.1']);
  await srv.executeCommand('systemctl start nginx');
  const replies = await type(fgt, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping',
    ...(interfaceFlag ? ['set explicit-web-proxy enable'] : []), 'next',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    ...proxyLines,
  ]);
  return { fgt, pc, srv, replies };
}

const SITE_HTTPS =
  'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n  index index.nginx-debian.html;\\n'
  + '  ssl_certificate /etc/ssl/certs/srv.crt;\\n  ssl_certificate_key /etc/ssl/private/srv.key;\\n}\\n';

async function serveHttps(srv: LinuxServer): Promise<void> {
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand('openssl req -x509 -newkey rsa:1024 -keyout /etc/ssl/private/srv.key -out /etc/ssl/certs/srv.crt -days 365 -nodes -subj "/CN=192.168.20.10"');
  await srv.executeCommand(`sh -c 'printf "${SITE_HTTPS}" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl restart nginx');
}

const ENABLE = ['config web-proxy explicit', 'set status enable', 'set http-incoming-port 8080', 'end'];
const viaProxy = (pc: LinuxPC, url = 'http://192.168.20.10/') =>
  pc.executeCommand(`curl -s -m 5 -i -x http://192.168.10.1:8080 ${url}`);

describe('explicit web proxy', () => {
  it('witness: the origin answers a client on its own network', async () => {
    const { srv } = await lab([]);
    expect(await srv.executeCommand('curl -s http://127.0.0.1/')).toMatch(/nginx/i);
  });

  it('direct curl, with no firewall policy, gets no answer', async () => {
    const { pc } = await lab([...ENABLE, ...policy(1, 'accept')]);
    expect(await pc.executeCommand('curl -s -m 3 http://192.168.20.10/')).not.toMatch(/nginx/i);
  });

  it('an accepting proxy-policy relays the page', async () => {
    const { pc } = await lab([...ENABLE, ...policy(1, 'accept')]);
    const out = await viaProxy(pc);
    expect(out).toMatch(/HTTP\/1\.1 200/);
    expect(out).toMatch(/nginx/i);
  });

  it('with no policy the default action deny answers 403', async () => {
    const { pc } = await lab(ENABLE);
    expect(await viaProxy(pc)).toMatch(/HTTP\/1\.1 403 Forbidden/);
  });

  it('sec-default-action accept serves without any policy', async () => {
    const { pc } = await lab(['config web-proxy explicit', 'set status enable', 'set sec-default-action accept', 'end']);
    expect(await viaProxy(pc)).toMatch(/HTTP\/1\.1 200/);
  });

  it('the first matching policy wins: a deny before an accept refuses', async () => {
    const { pc } = await lab([...ENABLE, ...policy(1, 'deny'), ...policy(2, 'accept')]);
    expect(await viaProxy(pc)).toMatch(/HTTP\/1\.1 403/);
  });

  it('a disabled proxy, or an interface that does not enable it, serves nothing', async () => {
    const off = await lab(['config web-proxy explicit', 'set status disable', 'end']);
    expect(await viaProxy(off.pc)).not.toMatch(/HTTP\/1\.1 (200|403)/);
    const bare = await lab([...ENABLE, ...policy(1, 'accept')], false);
    expect(await viaProxy(bare.pc)).not.toMatch(/HTTP\/1\.1 (200|403)/);
  });

  it('https goes through a CONNECT tunnel the proxy opens and relays', async () => {
    const { pc, srv } = await lab([...ENABLE, ...policy(1, 'accept')]);
    await serveHttps(srv);
    expect(await pc.executeCommand('curl -sS -k -m 8 -x http://192.168.10.1:8080 https://192.168.20.10/')).toMatch(/nginx/i);
  });

  it('a CONNECT the policy refuses fails the tunnel with the proxy status', async () => {
    const { pc, srv } = await lab(ENABLE);
    await serveHttps(srv);
    expect(await pc.executeCommand('curl -sS -k -m 8 -x http://192.168.10.1:8080 https://192.168.20.10/')).toContain('curl: (56) CONNECT tunnel failed, response 403');
  });

  it('redirect and the other proxy types are refused in the schema', async () => {
    const { replies } = await lab([...ENABLE, 'config firewall proxy-policy', 'edit 9', 'set action redirect', 'set proxy ftp']);
    expect(replies.join('\n')).toMatch(/replacement-page machinery/);
    expect(replies.join('\n')).toMatch(/only the explicit web proxy exists here/);
  });
});
