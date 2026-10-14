/**
 * config ips custom / config ips sensor / policy ips-sensor: a custom
 * signature (F-SBID subset: --name --protocol --service --flow --pattern
 * --context --no_case --severity --default_action --dst_port --src_port)
 * is parsed at the CLI, an unsupported keyword is refused naming it, a sensor
 * entry selects signatures by rule id or by severity / location / protocol /
 * os / application / default action / default status, and the policy's
 * ips-sensor scans the flow and blocks, passes, or lets a signature log.
 *
 * Measured on a git worktree of HEAD before the change: 4 of 9 fall (the two
 * grammar cases cannot even load, IpsEngine does not exist; the sensor that
 * must block; the signature that must be refused). The 5 others pass either
 * way, and for the opposite reason: before, no sensor could ever block, so
 * every "the request is served" case passed. They prove the lab serves the
 * page; only the blocking case proves the engine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { parseIpsSignature } from '@/network/devices/firewall/inspection/IpsEngine';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cli { executeCommand(command: string): Promise<string> }

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function type(device: Cli, lines: readonly string[]): Promise<string> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out.join('\n');
}

const EVIL = `set signature 'F-SBID( --name "Evil.Probe"; --protocol tcp; --service HTTP; --flow from_client; --pattern "/etc/passwd"; --context uri; --severity high; )'`;

async function lab(custom: string[], sensor: string[], onPolicy: boolean) {
  const lan = new LinuxServer('linux-server', 'LAN-Web', 0, 0);
  const wan = new LinuxServer('linux-server', 'WAN-Host', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli & { getPort(name: string): unknown };
  lan.powerOn();
  wan.powerOn();
  new Cable('lan').connect(lan.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, wan.getPort('eth0') as never);
  const typed = await type(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    ...custom, ...sensor,
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept',
    'set nat enable', 'set utm-status enable', 'set inspection-mode flow',
    ...(onPolicy ? ['set ips-sensor "protect"'] : []), 'next', 'end',
  ]);
  await type(wan, ['ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0',
    'ip route add default via 203.0.113.1', 'systemctl start nginx']);
  await type(lan, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  return {
    typed,
    attack: () => lan.executeCommand('curl -sS --connect-timeout 2 "http://203.0.113.9/etc/passwd"'),
    benign: () => lan.executeCommand('curl -sS --connect-timeout 2 http://203.0.113.9/'),
  };
}

const CUSTOM = ['config ips custom', 'edit "Evil.Probe"', EVIL, 'set action block', 'next', 'end'];
const SENSOR = ['config ips sensor', 'edit "protect"', 'config entries', 'edit 1', 'set severity high', 'next', 'end', 'next', 'end'];

describe('IPS signature grammar', () => {
  it('reads the supported F-SBID subset', () => {
    const parsed = parseIpsSignature('F-SBID( --name "X"; --protocol tcp; --pattern "a"; --context uri; --no_case; --severity low; )');
    expect(parsed.ok).toBe(true);
  });

  it('refuses a keyword it does not evaluate, naming it', () => {
    const parsed = parseIpsSignature('F-SBID( --name "X"; --pattern "a"; --byte_test 1,>,2,0; )');
    expect(parsed).toEqual({ ok: false, error: '--byte_test is not evaluated by this engine' });
  });
});

describe('IPS sensor on a policy', () => {
  it('witness: with no sensor on the policy the request is served', async () => {
    const l = await lab(CUSTOM, SENSOR, false);
    expect(await l.attack()).toMatch(/nginx|404|Not Found/i);
  });

  it('a sensor with a blocking entry stops the matching request', async () => {
    const l = await lab(CUSTOM, SENSOR, true);
    const out = await l.attack();
    expect(out).toMatch(/curl: \(\d+\)/);
    expect(out).not.toMatch(/nginx|Not Found/i);
  });

  it('witness: an unrelated request passes through the same sensor', async () => {
    const l = await lab(CUSTOM, SENSOR, true);
    expect(await l.benign()).toMatch(/nginx/i);
  });

  it('an entry action pass lets the matching request through', async () => {
    const sensor = ['config ips sensor', 'edit "protect"', 'config entries', 'edit 1', 'set severity high', 'set action pass', 'next', 'end', 'next', 'end'];
    const l = await lab(CUSTOM, sensor, true);
    expect(await l.attack()).toMatch(/nginx|404|Not Found/i);
  });

  it('an entry selecting another severity does not match', async () => {
    const sensor = ['config ips sensor', 'edit "protect"', 'config entries', 'edit 1', 'set severity low', 'next', 'end', 'next', 'end'];
    const l = await lab(CUSTOM, sensor, true);
    expect(await l.attack()).toMatch(/nginx|404|Not Found/i);
  });

  it('a disabled signature does not match', async () => {
    const custom = ['config ips custom', 'edit "Evil.Probe"', EVIL, 'set action block', 'set status disable', 'next', 'end'];
    const l = await lab(custom, SENSOR, true);
    expect(await l.attack()).toMatch(/nginx|404|Not Found/i);
  });

  it('a signature the engine cannot evaluate is refused, not stored', async () => {
    const custom = ['config ips custom', 'edit "Bad"', `set signature 'F-SBID( --name "Bad"; --pattern "a"; --byte_test 1,>,2,0; )'`, 'next', 'end'];
    const l = await lab(custom, SENSOR, false);
    expect(l.typed).toMatch(/--byte_test is not evaluated/);
  });
});
