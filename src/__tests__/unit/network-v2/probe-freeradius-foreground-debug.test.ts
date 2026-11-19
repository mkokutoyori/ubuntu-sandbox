/*
 * Probe: `freeradius -X` returned at once and printed nothing about the requests it served. A real -X process stays in the
 * foreground, logs every request until Ctrl-C and exits with "Exiting normally" (radiusd.c line 682). Source of truth: FreeRADIUS
 * v3.2.x src/main/process.c (debug_packet: "(%u) Received %s Id %u from %s:%i to %s:%i length %zu" then the attributes as
 * "(%u)   Attr = value"; "(%u) Sent ..." then the reply attributes; RDEBUG2("Finished request")) and radiusd.c. The section-by-section
 * trace between the two ("# Executing section authorize ...") is not reproduced, said in TODO.md. The stream runs in the terminal
 * session like journalctl -f; the machine-level hook (followRadiusDebug) is what the tests below read first.
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix; one passes either way and is named: with the unit running, the
 * bind failure is printed and nothing stays in the foreground (the command already returned that way).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

async function lab() {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const nas = new CiscoRouter('NAS');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); nas.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/3')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.0/24\n  secret = shared\n}\n');
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n\tReply-Message = "Hello, alice"\n');
  await target.executeCommand('systemctl reload freeradius');
  return { client, target, nas };
}

describe('the request debug of freeradius -X (machine hook)', () => {
  it('an Access-Request is traced Received, its attributes, Sent, its reply attributes, Finished', async () => {
    const { client, target } = await lab();
    const lines: string[] = [];
    target.followRadiusDebug((line) => lines.push(line));
    await client.executeCommand('radtest alice wonderland 10.0.0.2 0 shared');
    expect(lines[0]).toMatch(/^\(0\) Received Access-Request Id \d+ from 10\.0\.0\.1:49999 to 10\.0\.0\.2:1812 length \d+$/);
    expect(lines).toContain('(0)   User-Name = "alice"');
    expect(lines).toContain('(0)   User-Password = "wonderland"');
    expect(lines).toContain('(0)   NAS-IP-Address = 10.0.0.1');
    const sent = lines.findIndex((line) => /^\(0\) Sent Access-Accept Id \d+ from 10\.0\.0\.2:1812 to 10\.0\.0\.1:49999 length \d+$/.test(line));
    expect(sent).toBeGreaterThan(0);
    expect(lines[sent + 1]).toBe('(0)   Reply-Message = "Hello, alice"');
    expect(lines[lines.length - 1]).toBe('(0) Finished request');
  });

  it('request numbers count up, and a reject is traced too', async () => {
    const { client, target } = await lab();
    const lines: string[] = [];
    target.followRadiusDebug((line) => lines.push(line));
    await client.executeCommand('radtest alice wonderland 10.0.0.2 0 shared');
    await client.executeCommand('radtest alice nope 10.0.0.2 0 shared');
    expect(lines.some((line) => line.startsWith('(1) Received Access-Request'))).toBe(true);
    expect(lines.some((line) => line.startsWith('(1) Sent Access-Reject'))).toBe(true);
  });

  it('an Accounting-Request is traced on port 1813 and answered by an Accounting-Response of length 20', async () => {
    const { client, target } = await lab();
    const lines: string[] = [];
    target.followRadiusDebug((line) => lines.push(line));
    await client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s1"\\n' | radclient 10.0.0.2 acct shared`);
    expect(lines[0]).toMatch(/^\(0\) Received Accounting-Request Id \d+ from 10\.0\.0\.1:49998 to 10\.0\.0\.2:1813 length \d+$/);
    expect(lines).toContain('(0)   Acct-Status-Type = Start');
    expect(lines.some((line) => /^\(0\) Sent Accounting-Response Id \d+ from 10\.0\.0\.2:1813 to 10\.0\.0\.1:49998 length 20$/.test(line))).toBe(true);
  });

  it('stopping the follow stops the trace', async () => {
    const { client, target } = await lab();
    const lines: string[] = [];
    const stop = target.followRadiusDebug((line) => lines.push(line));
    stop();
    await client.executeCommand('radtest alice wonderland 10.0.0.2 0 shared');
    expect(lines).toEqual([]);
  });
});

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const texts = (session: LinuxTerminalSession) => session.lines.map((line) => line.text);
async function waitFor(session: LinuxTerminalSession, predicate: (lines: string[]) => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (predicate(texts(session))) return; await tick(); }
}

describe('freeradius -X in a terminal', () => {
  it('stays in the foreground, streams the requests, and exits with Exiting normally on Ctrl+C', async () => {
    const { client, target } = await lab();
    await target.executeCommand('systemctl stop freeradius');
    const session = new LinuxTerminalSession('term-1', target);
    session.setInput('freeradius -X');
    session.handleKey(key('Enter'));
    await waitFor(session, (lines) => lines.includes('Ready to process requests'));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(target.getRadiusd().isRunning()).toBe(true);

    await client.executeCommand('radtest alice wonderland 10.0.0.2 0 shared');
    await waitFor(session, (lines) => lines.some((line) => line.startsWith('(0) Finished request')));
    expect(texts(session).some((line) => /^\(0\) Received Access-Request/.test(line))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session)).toContain('Exiting normally');
    expect(target.getRadiusd().isRunning()).toBe(false);
  });

  it('with the unit running, the bind failure is printed and nothing stays in the foreground', async () => {
    const { target } = await lab();
    const session = new LinuxTerminalSession('term-1', target);
    session.setInput('freeradius -X');
    session.handleKey(key('Enter'));
    await waitFor(session, (lines) => lines.some((line) => line.includes('Address already in use')));
    expect(texts(session).some((line) => line.includes('Failed binding to auth address * port 1812'))).toBe(true);
    await tick();
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });
});
