/*
 * Probe: Login-Time was accepted by the users file and never evaluated. Source of truth: FreeRADIUS v3.2.x
 * src/modules/rlm_logintime/rlm_logintime.c (mod_authorize: Login-Time in the control list, timestr_match against the request time;
 * negative -> RLM_MODULE_USERLOCK -> Access-Reject whatever the password; zero -> unlimited; seconds left below minimum_timeout
 * (default 60, mods-available/logintime) -> reject; otherwise Session-Timeout in the reply, lowered to the time left if one was
 * already there), src/modules/rlm_logintime/timestr.c (the grammar: Su Mo Tu We Th Fr Sa, Wk = Mo-Fr, Any/Al = the whole week, a
 * day alone = the whole day, HHMM-HHMM inclusive to the minute, terms joined by , or |; seconds left count whole minutes, from the
 * current minute). The machine clock and zone decide (localtime_r), not the simulation clock: the cases set them with date -s and
 * timedatectl. One quirk is faithful to the source and named in its case: day_fill gives strcode the literal "Al" with a capital A,
 * which never matches the lowercase table, so a bare "0900-1700" (no day) allows nothing.
 *
 * Discriminated with git stash on src: 8 of 11 fall before the fix; three pass either way and are named: the witness (a user with no
 * Login-Time), the comma case (its answer is an accept, which ignoring the item also gives) and the unlimited case (Login-Time "Al"
 * allows every minute, matching the old behaviour of ignoring the item).
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
const WEDNESDAY = '2030-01-02';

async function loginAt(spec: string, clock: string, extra = '', zone?: string) {
  const { client, target } = await lab('10.0.0.1', `alice Cleartext-Password := "wonderland", Login-Time := "${spec}"${extra}\n`);
  if (zone !== undefined) await target.executeCommand(`timedatectl set-timezone ${zone}`);
  await target.executeCommand(`date -s "${clock}" >/dev/null`);
  return (await client.executeCommand(`${ALICE} | radclient -x 10.0.0.2 auth shared`)).trim();
}

describe('Login-Time', () => {
  it('witness: a user without Login-Time is accepted on a Saturday night', async () => {
    const { client, target } = await lab();
    await target.executeCommand('date -s "2030-01-05 23:30:00" >/dev/null');
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('inside Wk0900-1700 the reply carries the time left as Session-Timeout', async () => {
    const out = await loginAt('Wk0900-1700', `${WEDNESDAY} 10:00:00`);
    expect(out).toContain('Received Access-Accept');
    expect(out).toContain('\tSession-Timeout = 25260');
  });

  it('outside the hours the right password is rejected', async () => {
    expect(await loginAt('Wk0900-1700', `${WEDNESDAY} 20:00:00`)).toContain('Received Access-Reject');
  });

  it('Wk is Monday to Friday: a Saturday is rejected', async () => {
    expect(await loginAt('Wk0900-1700', '2030-01-05 10:00:00')).toContain('Received Access-Reject');
  });

  it('a day alone is the whole day, counted to its end', async () => {
    const out = await loginAt('Sa', '2030-01-05 10:00:00');
    expect(out).toContain('Received Access-Accept');
    expect(out).toContain('\tSession-Timeout = 50400');
  });

  it('the end of the range is inclusive to the minute, and a lockout below minimum_timeout (60 s) applies after it', async () => {
    expect(await loginAt('Wk0900-1700', `${WEDNESDAY} 16:59:30`)).toContain('\tSession-Timeout = 120');
    expect(await loginAt('Wk0900-1700', `${WEDNESDAY} 17:00:10`)).toContain('\tSession-Timeout = 60');
    expect(await loginAt('Wk0900-1700', `${WEDNESDAY} 17:01:00`)).toContain('Received Access-Reject');
  });

  it('terms joined by a comma are alternatives', async () => {
    expect(await loginAt('Mo0800-0900,We2000-2100', `${WEDNESDAY} 20:30:00`)).toContain('Received Access-Accept');
  });

  it('Al allows every minute of the week: unlimited, no Session-Timeout is added', async () => {
    const out = await loginAt('Al', `${WEDNESDAY} 03:00:00`);
    expect(out).toContain('Received Access-Accept');
    expect(out).not.toContain('Session-Timeout');
  });

  it('an existing Session-Timeout is lowered to the time left, never raised', async () => {
    expect(await loginAt('Wk0900-1700', `${WEDNESDAY} 10:00:00`, '\n\tSession-Timeout = 99999')).toContain('\tSession-Timeout = 25260');
    expect(await loginAt('Wk0900-1700', `${WEDNESDAY} 10:00:00`, '\n\tSession-Timeout = 600')).toContain('\tSession-Timeout = 600');
  });

  it('the machine zone decides: 10:30 in Paris is inside 1000-1100 though it is 09:30 UTC', async () => {
    expect(await loginAt('Wk1000-1100', `${WEDNESDAY} 09:30:00 UTC`, '', 'Europe/Paris')).toContain('Received Access-Accept');
    expect(await loginAt('Wk1000-1100', `${WEDNESDAY} 09:30:00 UTC`)).toContain('Received Access-Reject');
  });

  it('faithful to timestr.c: hours with no day allow nothing (the literal "Al" never matches the lowercase table)', async () => {
    expect(await loginAt('0900-1700', `${WEDNESDAY} 10:00:00`)).toContain('Received Access-Reject');
  });
});
