/*
 * Probe: a `config user radius` object authenticated nobody. The directory stored the server, but the RADIUS client of
 * the firewall was never told its address or its secret, so every login that named it (captive portal, administrator
 * with `set remote-auth`) timed out and came back "bad-password" — even with the right password and a freeradius
 * server answering on the cable. The declared servers are now registered with the client, `secondary-server` and
 * `tertiary-server` (CLI Reference 7.4.12 p.2127 ff.) are tried in order when the one before stays SILENT (an
 * Access-Reject is authoritative and stops the walk, RFC 2865 section 2), and `auth-type` is evaluated: `pap`, `chap`,
 * `ms_chap_v2`, or `auto` = PAP, MSCHAP_v2, CHAP in that order; `ms_chap` is refused naming what the client lacks.
 *
 * Discriminated with git stash on src/network: 8 of 11 fall before the fix; three pass either way and are named: the witness
 * (the server answers a client that knows it), "a wrong password is rejected" and "an Access-Reject is final" (a failure to authenticate looks the
 * same as a rejection from outside, which is the defect, and nothing can fall over to a second server before the fix).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

const CLIENT = '192.168.1.10';

async function lab(radiusLines: string[]) {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const poste = new LinuxPC('linux-pc', 'POSTE', 0, 0);
  const first = new LinuxServer('linux-server', 'AAA1', 0, 0);
  const second = new LinuxServer('linux-server', 'AAA2', 0, 0);
  for (const device of [fw, sw, poste, first, second]) device.powerOn();
  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, sw.getPort('eth0')!);
  new Cable('c').connect(first.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('d').connect(second.getPort('eth0')!, sw.getPort('eth2')!);

  for (const line of ['config system interface', 'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end']) sh.execute(line);
  for (const [server, ip] of [[first, '203.0.113.5'], [second, '203.0.113.6']] as const) {
    for (const command of ['ip link set eth0 up', `ip addr add ${ip}/24 dev eth0`, 'ip route add default via 203.0.113.1']) {
      await server.executeCommand(command);
    }
  }
  for (const command of ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`, 'ip route add default via 192.168.1.1']) {
    await poste.executeCommand(command);
  }
  first.getRadiusServer().addUser('jdupont', 'Secret2026!');
  second.getRadiusServer().setSharedSecret('second-secret');
  second.getRadiusServer().addUser('jdupont', 'Secret2026!');
  second.getRadiusServer().addUser('onlysecond', 'Other2026!');

  for (const line of ['config user radius', 'edit "RADIUS_AD"', ...radiusLines, 'next', 'end',
    'config user local', 'edit "jdupont"', 'set type radius', 'set radius-server "RADIUS_AD"', 'next',
    'edit "onlysecond"', 'set type radius', 'set radius-server "RADIUS_AD"', 'next', 'end']) sh.execute(line);
  return { fw, sh, clock, first, second };
}

async function login(fw: FortiGate, clock: VirtualTimeScheduler, username: string, password: string) {
  const pending = fw.getAuthPortal().authenticate(CLIENT, { username, password });
  for (let i = 0; i < 40; i++) { clock.advance(1_000); await Promise.resolve(); }
  return pending;
}

const SERVER = (address: string) => `set server ${address}`;
const SECRET = 'set secret "testing123"';

describe('user radius is a working client', () => {
  it('witness: the freeradius server answers a client that knows it', async () => {
    const { first } = await lab([SERVER('203.0.113.5'), SECRET]);
    expect(first.getRadiusServer().getConfig().sharedSecret).toBe('testing123');
  });

  it('the right password is accepted by the declared server', async () => {
    const { fw, clock } = await lab([SERVER('203.0.113.5'), SECRET]);
    expect((await login(fw, clock, 'jdupont', 'Secret2026!')).ok).toBe(true);
  });

  it('a wrong password is rejected', async () => {
    const { fw, clock } = await lab([SERVER('203.0.113.5'), SECRET]);
    expect((await login(fw, clock, 'jdupont', 'nope')).ok).toBe(false);
  });

  it('a silent primary hands over to the secondary, with its own secret', async () => {
    const { fw, clock } = await lab([SERVER('203.0.113.4'), SECRET,
      'set secondary-server 203.0.113.6', 'set secondary-secret "second-secret"']);
    expect((await login(fw, clock, 'jdupont', 'Secret2026!')).ok).toBe(true);
  });

  it('an Access-Reject from the primary is final: the secondary is not asked', async () => {
    const { fw, clock } = await lab([SERVER('203.0.113.5'), SECRET,
      'set secondary-server 203.0.113.6', 'set secondary-secret "second-secret"']);
    expect((await login(fw, clock, 'onlysecond', 'Other2026!')).ok).toBe(false);
  });

  it('the tertiary is the last resort when the first two are silent', async () => {
    const { fw, clock } = await lab([SERVER('203.0.113.4'), SECRET,
      'set secondary-server 203.0.113.3', 'set secondary-secret "x"',
      'set tertiary-server 203.0.113.6', 'set tertiary-secret "second-secret"']);
    expect((await login(fw, clock, 'jdupont', 'Secret2026!')).ok).toBe(true);
  });

  it.each(['pap', 'chap', 'ms_chap_v2', 'auto'])('auth-type %s authenticates against the server', async (authType) => {
    const { fw, clock } = await lab([SERVER('203.0.113.5'), SECRET, `set auth-type ${authType}`]);
    expect((await login(fw, clock, 'jdupont', 'Secret2026!')).ok).toBe(true);
  });

  it('ms_chap (the original MS-CHAP) is refused, naming what the client lacks', async () => {
    const { sh } = await lab([SERVER('203.0.113.5'), SECRET]);
    sh.execute('config user radius');
    sh.execute('edit "RADIUS_AD"');
    expect(sh.execute('set auth-type ms_chap')).toMatch(/MS-CHAPv2.*RFC 2433/);
  });
});
