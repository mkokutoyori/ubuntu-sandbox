/*
 * Probe: FortiOS 7.4.12 (firewall ssl-ssh-profile > config https, p.665-667) documents `min-allowed-ssl-version
 * [ssl-3.0|tls-1.0|tls-1.1|tls-1.2|tls-1.3]` (default tls-1.1) and notes that flow-based inspection does not support SSL version
 * control. The word did not exist (battery 08 test 358). The deep-inspection proxy now reads the ClientHello and closes a session
 * whose highest offered version is below the minimum, for a policy in proxy inspection mode only, as the reference says. The
 * proxy's own TLS stack already refuses TLS 1.0/1.1 clients (protocol_version) whatever the setting says, so the values below
 * tls-1.2 can only be as permissive as that stack: the setting never loosens the proxy, it can only tighten it.
 *
 * A PC fetches HTTPS from a server behind a FortiGate with deep inspection.
 * Discriminated with git stash on src/network: 2 of 5 fall before the change; the witnesses (default minimum serves a TLS 1.2
 * client, a TLS 1.3 client is served at tls-1.3) and the flow-mode case (the setting is ignored there, as documented) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function type(device: Cmd, commands: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const command of commands) out.push(await device.executeCommand(command));
  return out;
}

const SITE_HTTPS =
  'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n  index index.nginx-debian.html;\\n'
  + '  ssl_certificate /etc/ssl/certs/srv.crt;\\n  ssl_certificate_key /etc/ssl/private/srv.key;\\n}\\n';

async function lab(mode: 'proxy' | 'flow', minimum: string | null) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);
  await type(pc, ['ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 192.168.10.1']);
  await type(srv, ['ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 192.168.20.1']);
  await srv.executeCommand('systemctl start nginx');
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand('openssl req -x509 -newkey rsa:1024 -keyout /etc/ssl/private/srv.key -out /etc/ssl/certs/srv.crt -days 365 -nodes -subj "/CN=192.168.20.10"');
  await srv.executeCommand(`sh -c 'printf "${SITE_HTTPS}" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl restart nginx');
  const replies = await type(fgt, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall ssl-ssh-profile', 'edit "D"', 'config https', 'set ports 443', 'set status deep-inspection',
    ...(minimum === null ? [] : [`set min-allowed-ssl-version ${minimum}`]), 'end', 'next', 'end',
    'config firewall policy', 'edit 2', 'set srcintf "port2"', 'set dstintf "port3"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set schedule "always"', 'set action accept', 'set utm-status enable', `set inspection-mode ${mode}`,
    'set ssl-ssh-profile "D"', 'next', 'end',
  ]);
  return { fgt, pc, replies };
}

const hello = (pc: LinuxPC, flag: string) =>
  pc.executeCommand(`openssl s_client -connect 192.168.20.10:443 ${flag} </dev/null 2>&1`);
const served = (out: string) => /Certificate chain|BEGIN CERTIFICATE/.test(out) && !/alert|no peer certificate|errno/i.test(out);

describe('ssl-ssh-profile min-allowed-ssl-version', () => {
  it('witness: with the default minimum a TLS 1.2 client is served', async () => {
    const { pc } = await lab('proxy', null);
    expect(served(await hello(pc, '-tls1_2'))).toBe(true);
  });

  it('the setting is accepted and rendered', async () => {
    const { fgt, replies } = await lab('proxy', 'tls-1.3');
    expect(replies.join('\n')).not.toMatch(/Command fail|unknown/i);
    expect(await fgt.executeCommand('show firewall ssl-ssh-profile D')).toContain('set min-allowed-ssl-version tls-1.3');
  });

  it('witness: a TLS 1.3 client is served at tls-1.3', async () => {
    const { pc } = await lab('proxy', 'tls-1.3');
    expect(served(await hello(pc, '-tls1_3'))).toBe(true);
  });

  it('a client whose best version is TLS 1.2 is cut at tls-1.3 in proxy mode', async () => {
    const { pc } = await lab('proxy', 'tls-1.3');
    expect(served(await hello(pc, '-tls1_2'))).toBe(false);
  });

  it('in flow mode the setting is ignored, as the reference says', async () => {
    const { pc } = await lab('flow', 'tls-1.3');
    expect(served(await hello(pc, '-tls1_2'))).toBe(true);
  });
});
