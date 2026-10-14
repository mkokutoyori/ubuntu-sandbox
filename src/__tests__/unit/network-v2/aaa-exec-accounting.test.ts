/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `aaa accounting exec
 * {default | list} {start-stop | stop-only | wait-start | none} group {radius | tacacs+ group}`,
 * `aaa accounting update [newinfo] [periodic N]`, `aaa accounting jitter maximum`,
 * `aaa accounting suppress null-username`, `aaa accounting send stop-record always|authentication
 * failure`, and the line command `accounting exec <list>`.
 *
 * Book (aaa accounting): exec accounting runs for the EXEC shell session; start-stop sends a start record
 * at the beginning and a stop record at the end, stop-only a stop record at the end, none nothing.
 * Book (send stop-record always): a stop record is sent even if the corresponding start was not sent,
 * which by default it is not. Book (update periodic): interim records every N minutes; jitter 0 turns
 * the jitter off.
 *
 * Lab: PC - switch - NAS router (local telnet logins) - server router holding the RADIUS and TACACS+
 * agents. The login is a real telnet session on port 23; the records are read where they arrive (the
 * server agents' journals fed by frames from the NAS), never from the NAS's objects.
 *
 * Measured with src stashed to HEAD: `aaa accounting exec` was accepted and rendered and no record left
 * the router (`accountExec` had no caller), so 13 of the 18 cases fall. Five pass either way: the
 * no-accounting witness, `none`, the vty pointed at a list that sends nothing, the failed login without
 * the stop-record option, and the refusals.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { connectTelnet, settle, type WireTelnet } from './_helpers/telnetWireClient';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  clock = installVirtualClock();
});

interface ExecLab {
  nas: CiscoRouter;
  server: CiscoRouter;
  pc: LinuxPC;
  login(user?: string, password?: string): Promise<WireTelnet>;
  records(): Array<{ status: string; user: string; sessionTime: number }>;
  tacacs(): ReturnType<ReturnType<CiscoRouter['getTacacsServer']>['getAccountingLog']>;
}

async function lab(config: string[], options: { serverUp?: boolean } = {}): Promise<ExecLab> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const nas = new CiscoRouter('cisco1', 0, 0);
  const server = new CiscoRouter('cisco2', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(nas.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(server.getPorts()[0], sw.getPorts()[2]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  for (const [device, address] of [[nas, '10.0.0.6'], [server, '10.0.0.3']] as const) {
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', `ip address ${address} 255.255.255.0`, 'no shutdown', 'end']) {
      await device.executeCommand(c);
    }
  }
  const radius = server.getRadiusServer();
  radius.start();
  radius.setSharedSecret('secret');
  radius.authorizeClient('10.0.0.6');
  radius.setEnabled(options.serverUp !== false);
  const tacacs = server.getTacacsServer();
  tacacs.setEnabled(true);
  tacacs.setSharedSecret('secret');
  for (const c of [
    'enable', 'configure terminal', 'aaa new-model',
    'username admin privilege 15 secret Admin@2025',
    'radius-server host 10.0.0.3 auth-port 1812 acct-port 1813 key secret', 'radius-server timeout 1', 'radius-server retransmit 0',
    'aaa group server radius RAD', 'server name 10.0.0.3', 'exit',
    'tacacs server TAC', 'address ipv4 10.0.0.3', 'key secret', 'exit',
    'aaa group server tacacs+ TACG', 'server name TAC', 'exit',
    'line vty 0 4', 'login local', 'exit',
    ...config, 'end',
  ]) await nas.executeCommand(c);
  await pc.executeCommand('ping -c 1 10.0.0.6');
  return {
    nas, server, pc,
    async login(user = 'admin', password = 'Admin@2025') {
      const telnet = await connectTelnet(pc, '10.0.0.6');
      telnet.send(user); await settle();
      telnet.send(password); await settle();
      return telnet;
    },
    records: () => server.getRadiusServer().listAccountingSessions().map((r) => ({
      status: r.status, user: r.username, sessionTime: r.sessionTimeSec,
    })),
    tacacs: () => server.getTacacsServer().getAccountingLog(),
  };
}

describe('exec accounting to RADIUS', () => {
  it('witness (passes either way): without accounting no record reaches the server', async () => {
    const l = await lab([]);
    const telnet = await l.login();
    expect(telnet.received).toContain('#');
    telnet.close(); await settle();
    expect(l.records()).toEqual([]);
  });

  it('start-stop: a start record arrives when the session opens and a stop record when it closes', async () => {
    const l = await lab(['aaa accounting exec default start-stop group RAD']);
    const telnet = await l.login();
    expect(l.records()).toEqual([expect.objectContaining({ status: 'start', user: 'admin' })]);
    clock.advance(42_000);
    telnet.send('exit'); await settle();
    const [record] = l.records();
    expect(record.status).toBe('stop');
    expect(record.sessionTime).toBeGreaterThanOrEqual(42);
  });

  it('stop-only: nothing at the start, one stop record at the end', async () => {
    const l = await lab(['aaa accounting exec default stop-only group RAD']);
    const telnet = await l.login();
    expect(l.records()).toEqual([]);
    telnet.send('exit'); await settle();
    expect(l.records()).toEqual([expect.objectContaining({ status: 'stop', user: 'admin' })]);
  });

  it('witness (passes either way): none sends nothing', async () => {
    const l = await lab(['aaa accounting exec default none']);
    const telnet = await l.login();
    telnet.send('exit'); await settle();
    expect(l.records()).toEqual([]);
  });

  it('show accounting counts the records that were acknowledged', async () => {
    const l = await lab(['aaa accounting exec default start-stop group RAD']);
    const telnet = await l.login();
    telnet.send('exit'); await settle();
    expect(await l.nas.executeCommand('show accounting')).toMatch(/exec\s+1\s+1\s+0/);
  });

  it('the list named by the line is the one used: a vty on a list that sends nothing sends nothing', async () => {
    const l = await lab([
      'aaa accounting exec default start-stop group RAD', 'aaa accounting exec QUIET none',
      'line vty 0 4', 'accounting exec QUIET', 'exit',
    ]);
    const telnet = await l.login();
    telnet.send('exit'); await settle();
    expect(l.records()).toEqual([]);
  });

  it('the list named by the line is the one used: a line pointing at a sending list sends while default is none', async () => {
    const l = await lab([
      'aaa accounting exec default none', 'aaa accounting exec LOUD start-stop group RAD',
      'line vty 0 4', 'accounting exec LOUD', 'exit',
    ]);
    await l.login();
    expect(l.records()).toEqual([expect.objectContaining({ status: 'start', user: 'admin' })]);
  });

  it('authorization and accounting lines of one vty range are all kept in the running-config', async () => {
    const l = await lab([
      'aaa accounting exec LOUD start-stop group RAD', 'line vty 0 4', 'accounting exec LOUD', 'accounting commands 15 CMDS', 'authorization exec AX', 'authorization commands 15 AC', 'exit',
    ]);
    const running = await l.nas.executeCommand('show running-config');
    for (const line of [' accounting exec LOUD', ' accounting commands 15 CMDS', ' authorization exec AX', ' authorization commands 15 AC']) {
      expect(running).toContain(line);
    }
  });

  it('periodic update: an interim record every N minutes while the session stays open', async () => {
    const l = await lab(['aaa accounting exec default start-stop group RAD', 'aaa accounting update periodic 1', 'aaa accounting jitter maximum 0']);
    await l.login();
    const interim = (): number => l.server.getRadiusServer().listAccountingSessions().filter((r) => r.status === 'interim-update').length;
    expect(interim()).toBe(0);
    await clock.advance(61_000);
    await settle();
    expect(l.records()[0].status).toBe('interim-update');
    expect(l.records()[0].sessionTime).toBeGreaterThanOrEqual(60);
    expect(await l.nas.executeCommand('show running-config')).toContain('aaa accounting update periodic 1');
  });

  it('suppress null-username: a session without a user name sends nothing; without the command it sends', async () => {
    const withoutUser = ['line vty 0 4', 'password s3cr3t', 'login', 'exit', 'aaa accounting exec default start-stop group RAD'];
    const sends = await lab(withoutUser);
    const first = await connectTelnet(sends.pc, '10.0.0.6');
    first.send('s3cr3t'); await settle();
    expect(sends.records().length).toBe(1);
    EquipmentRegistry.resetInstance();
    const mute = await lab([...withoutUser, 'aaa accounting suppress null-username']);
    const second = await connectTelnet(mute.pc, '10.0.0.6');
    second.send('s3cr3t'); await settle();
    expect(mute.records()).toEqual([]);
  });

  it('a stop record is not sent when the start was never acknowledged, unless send stop-record always', async () => {
    const down = await lab(['aaa accounting exec default start-stop group RAD'], { serverUp: false });
    const telnet = await down.login();
    down.server.getRadiusServer().setEnabled(true);
    telnet.send('exit'); await settle();
    expect(down.records()).toEqual([]);
    EquipmentRegistry.resetInstance();
    const always = await lab(['aaa accounting exec default start-stop group RAD', 'aaa accounting send stop-record always'], { serverUp: false });
    const second = await always.login();
    always.server.getRadiusServer().setEnabled(true);
    second.send('exit'); await settle();
    expect(always.records()).toEqual([expect.objectContaining({ status: 'stop', user: 'admin' })]);
  });

  it('send stop-record authentication failure: a failed login sends a stop record for the name tried', async () => {
    const l = await lab(['aaa accounting exec default start-stop group RAD', 'aaa accounting send stop-record authentication failure']);
    await l.login('admin', 'wrong');
    expect(l.records()).toEqual([expect.objectContaining({ status: 'stop', user: 'admin' })]);
  });

  it('witness (passes either way): without send stop-record authentication failure a failed login sends nothing', async () => {
    const l = await lab(['aaa accounting exec default start-stop group RAD']);
    await l.login('admin', 'wrong');
    expect(l.records()).toEqual([]);
  });
});

describe('exec accounting to TACACS+', () => {
  it('start-stop: start and stop reach the TACACS+ server with the task and the elapsed time', async () => {
    const l = await lab(['aaa accounting exec default start-stop group TACG']);
    const telnet = await l.login();
    expect(l.tacacs().map((r) => r.flags)).toEqual([['start']]);
    expect(l.tacacs()[0].args.some((a) => /^start_time=\d+$/.test(a))).toBe(true);
    expect(l.tacacs()[0].args).toContain('service=shell');
    expect(l.tacacs()[0].port).toMatch(/^vty\d+$/);
    expect(l.tacacs()[0].remoteAddress).toBe('10.0.0.1');
    clock.advance(30_000);
    telnet.send('exit'); await settle();
    expect(l.tacacs().map((r) => r.flags)).toEqual([['start'], ['stop']]);
    expect(l.tacacs()[1].args.some((a) => /^elapsed_time=\d+$/.test(a))).toBe(true);
    expect(l.tacacs()[1].args.find((a) => a.startsWith('task_id='))).toBe(l.tacacs()[0].args.find((a) => a.startsWith('task_id=')));
  });

  it('stop-only: one stop record', async () => {
    const l = await lab(['aaa accounting exec default stop-only group TACG']);
    const telnet = await l.login();
    expect(l.tacacs()).toEqual([]);
    telnet.send('exit'); await settle();
    expect(l.tacacs().map((r) => r.flags)).toEqual([['stop']]);
  });

  it('periodic update sends a watchdog record', async () => {
    const l = await lab(['aaa accounting exec default start-stop group TACG', 'aaa accounting update periodic 1', 'aaa accounting jitter maximum 0']);
    await l.login();
    await clock.advance(61_000);
    await settle();
    expect(l.tacacs().map((r) => r.flags)).toEqual([['start'], ['watchdog']]);
  });
});

describe('accounting options: configuration', () => {
  it('every option is rendered in the running-config and cleared by its no form', async () => {
    const l = await lab([
      'aaa accounting update newinfo periodic 5', 'aaa accounting jitter maximum 20', 'aaa accounting suppress null-username',
      'aaa accounting send stop-record always', 'aaa accounting send stop-record authentication failure',
    ]);
    const running = await l.nas.executeCommand('show running-config');
    for (const line of ['aaa accounting update newinfo periodic 5', 'aaa accounting jitter maximum 20', 'aaa accounting suppress null-username',
      'aaa accounting send stop-record always', 'aaa accounting send stop-record authentication failure']) expect(running).toContain(line);
    await l.nas.executeCommand('configure terminal');
    for (const line of ['aaa accounting update', 'aaa accounting jitter', 'aaa accounting suppress null-username',
      'aaa accounting send stop-record always', 'aaa accounting send stop-record authentication failure']) await l.nas.executeCommand(`no ${line}`);
    await l.nas.executeCommand('end');
    expect(await l.nas.executeCommand('show running-config')).not.toMatch(/aaa accounting (update|jitter|suppress|send)/);
  });

  it('refuses a jitter outside 0-2147483 and an unknown stop-record keyword', async () => {
    const l = await lab([]);
    await l.nas.executeCommand('configure terminal');
    expect(await l.nas.executeCommand('aaa accounting jitter maximum 2147484')).toContain('% Invalid input');
    expect(await l.nas.executeCommand('aaa accounting send stop-record zorglub')).toContain('% Invalid input');
  });
});
