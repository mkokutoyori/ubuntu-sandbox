/*
 * Probe: Simultaneous-Use was accepted by the users file and never evaluated. Source of truth: FreeRADIUS v3.2.x src/main/auth.c
 * (rad_check_password caller: after a good password, Simultaneous-Use in the control list runs process_checksimul; too many
 * sessions -> Access-Reject, every reply attribute removed, Reply-Message = msg_denied, plus " (N)" when the maximum is above 1; the
 * auth log gets "Multiple logins (max N) " before the usual "Login incorrect"), src/main/modules.c process_checksimul (the count
 * must reach the maximum to deny), src/modules/rlm_radutmp/rlm_radutmp.c (mod_accounting: Start and Alive add a session, Stop and
 * Accounting-On/Off close them, On/Off for every session of the NAS; mod_checksimul: counts the sessions of the user, case
 * sensitive, then with check_with_nas asks rad_check_ts) and src/main/session.c rad_check_ts (an unknown NAS or nas_type "other" is
 * trusted, which is what the shipped clients.conf has; any other type would run checkrad, which the simulator cannot, and a failed
 * check lets the login through; mod_accounting records a session only when the packet carries a NAS-Port and the user is not "!root"),
 * raddb/radiusd.conf.in (msg_denied). The sessions come from real Accounting-Requests on the wire.
 *
 * Discriminated with git stash on src: 5 of 11 fall before the fix (every denial, the maximum of 2, Accounting-On, the log and message
 * case). Six pass either way and are named: the witness (no Simultaneous-Use), no session open, the session without NAS-Port (which the
 * old code also ignored, by ignoring everything), Stop frees the session, the sessions of another user and another case do not count,
 * and the nas_type case (a failed NAS check allows the login, which ignoring the item also does); these keep the accepting side of the
 * lab honest.
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
import { CLIENTS_CONF_PATH, USERS_FILE_PATH, RADIUSD_CONF_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

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

import { DEFAULT_RADIUSD_CONF } from '@/network/devices/linux/freeradius/DefaultRadiusdConf';

const ALICE = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n'`;
const LOG = '/var/log/freeradius/radius.log';
const acct = (status: string, session: string, user = 'alice', port: number | null = 1) =>
  `printf 'User-Name = "${user}"\\nAcct-Status-Type = ${status}\\nAcct-Session-Id = "${session}"\\nNAS-IP-Address = 10.0.0.1\\n${port === null ? '' : `NAS-Port = ${port}\\n`}' | radclient 10.0.0.2 acct shared`;

async function labWith(max: number | null, clients?: string) {
  const simultaneous = max === null ? '' : `, Simultaneous-Use := ${max}`;
  const made = await lab('10.0.0.1', `alice Cleartext-Password := "wonderland"${simultaneous}\n\tReply-Message = "hello"\nbob Cleartext-Password := "builder", Simultaneous-Use := 1\n`);
  if (clients !== undefined) {
    write(made.target, CLIENTS_CONF_PATH, clients);
    await made.target.executeCommand('systemctl reload freeradius');
  }
  return made;
}

describe('Simultaneous-Use', () => {
  it('witness: without Simultaneous-Use an open session does not matter', async () => {
    const { client } = await labWith(null);
    await client.executeCommand(acct('Start', 's1'));
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('no session open: accepted', async () => {
    const { client } = await labWith(1);
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('one session open and a maximum of 1: Access-Reject, every reply attribute removed, only the denial message', async () => {
    const { client } = await labWith(1);
    await client.executeCommand(acct('Start', 's1'));
    const out = await client.executeCommand(`${ALICE} | radclient -x 10.0.0.2 auth shared`);
    expect(out).toContain('Received Access-Reject');
    expect(out).toContain('\tReply-Message = "You are already logged in - access denied"');
    expect(out).not.toContain('hello');
  });

  it('the denial applies to CHAP as well', async () => {
    const { client } = await labWith(1);
    await client.executeCommand(acct('Start', 's1'));
    expect(await client.executeCommand(`printf 'User-Name = "alice"\\nCHAP-Password = "wonderland"\\n' | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Reject');
  });

  it('a session the NAS reported without NAS-Port is not in the radutmp table: rlm_radutmp ignores it, so it does not count', async () => {
    const { client } = await labWith(1);
    await client.executeCommand(acct('Start', 's1', 'alice', null));
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('a Stop frees the session', async () => {
    const { client } = await labWith(1);
    await client.executeCommand(acct('Start', 's1'));
    await client.executeCommand(acct('Stop', 's1'));
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('a maximum of 2 lets a second login in and denies the third, the message carrying the maximum', async () => {
    const { client } = await labWith(2);
    await client.executeCommand(acct('Start', 's1'));
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
    await client.executeCommand(acct('Start', 's2'));
    const out = await client.executeCommand(`${ALICE} | radclient -x 10.0.0.2 auth shared`);
    expect(out).toContain('Received Access-Reject');
    expect(out).toContain('\tReply-Message = "You are already logged in - access denied (2)"');
  });

  it('only the sessions of that user count, and the name is case sensitive', async () => {
    const { client } = await labWith(1);
    await client.executeCommand(acct('Start', 's1', 'bob'));
    await client.executeCommand(acct('Start', 's2', 'Alice'));
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('Accounting-On from the NAS closes every session it held, and gets its Accounting-Response', async () => {
    const { client } = await labWith(1);
    await client.executeCommand(acct('Start', 's1'));
    const on = await client.executeCommand(`printf 'Acct-Status-Type = Accounting-On\\nNAS-IP-Address = 10.0.0.1\\n' | radclient 10.0.0.2 acct shared`);
    expect(on).toContain('Received Accounting-Response');
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('a NAS whose nas_type is not "other" cannot be asked (checkrad): the login is allowed', async () => {
    const { client } = await labWith(1, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n  nas_type = cisco\n}\n');
    await client.executeCommand(acct('Start', 's1'));
    expect(await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('msg_denied of radiusd.conf is the message, and the auth log gets "Multiple logins" before "Login incorrect"', async () => {
    const { client, target } = await labWith(1);
    write(target, RADIUSD_CONF_PATH, DEFAULT_RADIUSD_CONF.replace('auth = no', 'auth = yes').replace('You are already logged in - access denied', 'Busy, go away'));
    await target.executeCommand('systemctl reload freeradius');
    await client.executeCommand(acct('Start', 's1'));
    const out = await client.executeCommand(`${ALICE} | radclient -x 10.0.0.2 auth shared`);
    expect(out).toContain('\tReply-Message = "Busy, go away"');
    const lines = (vfsOf(target).readFile(LOG) ?? '').split('\n').filter((line) => line.includes(': Auth: ')).map((line) => line.replace(/^.*? : /, ''));
    expect(lines.slice(-2)).toEqual([
      expect.stringMatching(/^Auth: \(\d+\) Multiple logins \(max 1\) : \[alice\] \(from client lab port 0\)$/),
      expect.stringMatching(/^Auth: \(\d+\) Login incorrect: \[alice\] \(from client lab port 0\)$/),
    ]);
  });
});
