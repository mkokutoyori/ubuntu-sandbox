/*
 * Probe: `config firewall vip` of type server-load-balance with `set server-type https` carried `ssl-mode` and
 * `ssl-certificate` nowhere (CLI Reference 7.4.12 p.693/701/705: ssl-mode half = "Client to FortiGate SSL",
 * full = "Client to FortiGate and FortiGate to Server SSL"). The VIP load-balanced the raw TCP stream, so a TLS
 * client reached a plain-HTTP nginx and the handshake died. The FortiGate now terminates the client's TLS with the
 * VIP's local certificate and relays the decrypted HTTP to the real server picked by the pool, in clear (half)
 * or re-encrypted over its own TLS session (full). Reuses the TLS stack of SSL deep inspection through a shared
 * TcpInterceptor and TlsUpstream, not a second TLS implementation.
 *
 * Also closed on the way: `extport` was silently ignored on a server-load-balance VIP (it was only available to
 * port-forwarding static NAT), so every load-balancing VIP balanced every port; the offload cannot arm without it.
 *
 * Discriminated with git stash on src/network: 2 of 4 fall before the fix; the witness (no ssl-certificate: the
 * TLS client gets no page from the plain-HTTP server) and the "HTTP VIP still balances in clear" case pass either
 * way — the first because nothing terminates TLS, the second because it never touched the offload path. The
 * presented certificate is asserted so that a raw pass-through to a TLS backend cannot pass as offloading.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function run(device: Cmd, ...lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

const HTTPS_SITE = 'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
  + '  index index.nginx-debian.html;\\n  ssl_certificate /etc/ssl/certs/srv.crt;\\n'
  + '  ssl_certificate_key /etc/ssl/private/srv.key;\\n}\\n';

async function lab(vipLines: string[], backendTls = false) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const web = new LinuxServer('linux-server', 'WEB', 0, 0);
  for (const device of [fgt, client, web]) device.powerOn();
  new Cable('wan').connect(client.getPort('eth0')!, fgt.getPort('wan1')!);
  new Cable('dmz').connect(fgt.getPort('dmz')!, web.getPort('eth0')!);

  await run(fgt,
    'config system interface',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit dmz', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');
  await run(client, 'ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1');
  await run(web, 'ip link set eth0 up', 'ip addr add 10.0.0.5/24 dev eth0', 'ip route add default via 10.0.0.1');

  if (backendTls) {
    await run(web, 'mkdir -p /etc/ssl/certs /etc/ssl/private',
      'openssl genrsa -out /etc/ssl/private/srv.key 1024',
      'openssl req -x509 -new -key /etc/ssl/private/srv.key -out /etc/ssl/certs/srv.crt -days 90 -subj "/CN=web"',
      `sh -c 'printf "${HTTPS_SITE}" > /etc/nginx/sites-available/default'`, );
  }
  await run(web, 'systemctl restart nginx');

  await run(fgt, ...vipLines,
    'config firewall policy', 'edit 1', 'set srcintf "wan1"', 'set dstintf "dmz"', 'set srcaddr "all"',
    'set dstaddr "WEB-VIP"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end');
  return { fgt, client };
}

const vip = (serverType: string, backendPort: number, extra: string[] = []): string[] => [
  'config firewall vip', 'edit "WEB-VIP"', 'set type server-load-balance', `set server-type ${serverType}`,
  'set extip 203.0.113.100', 'set extintf "wan1"', 'set extport 443', ...extra,
  'config realservers', 'edit 1', 'set ip 10.0.0.5', `set port ${backendPort}`, 'next', 'end', 'next', 'end',
];

const PAGE = /Welcome to nginx/i;

const presentedCertificate = (client: Cmd): Promise<string> =>
  client.executeCommand('curl -k -v -s -m 5 -o /dev/null https://203.0.113.100/ 2>&1');

describe('firewall vip ssl-mode', () => {
  it('witness: with no ssl-certificate the TLS client gets no page from the plain-HTTP server', async () => {
    const { client } = await lab(vip('https', 80));
    expect(await client.executeCommand('curl -k -s -m 5 https://203.0.113.100/')).not.toMatch(PAGE);
  });

  it('half: the FortiGate terminates TLS and reaches the plain-HTTP server', async () => {
    const { client } = await lab(vip('https', 80, ['set ssl-certificate "Fortinet_Factory"', 'set ssl-mode half']));
    expect(await client.executeCommand('curl -k -s -m 5 https://203.0.113.100/')).toMatch(PAGE);
    expect(await presentedCertificate(client)).toMatch(/Fortinet|FortiGate/);
  });

  it('full: the FortiGate also speaks TLS to the real server', async () => {
    const { client } = await lab(
      vip('https', 443, ['set ssl-certificate "Fortinet_Factory"', 'set ssl-mode full']), true);
    expect(await client.executeCommand('curl -k -s -m 5 https://203.0.113.100/')).toMatch(PAGE);
    expect(await presentedCertificate(client)).toMatch(/Fortinet|FortiGate/);
  });

  it('an http VIP still balances in clear and is untouched by the offload path', async () => {
    const { client } = await lab(vip('http', 80).map(l => l.replace('set extport 443', 'set extport 80')));
    expect(await client.executeCommand('curl -s -m 5 http://203.0.113.100/')).toMatch(PAGE);
  });
});
