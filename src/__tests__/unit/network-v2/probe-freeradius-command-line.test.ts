/*
 * Probe: there was no `freeradius` command, only `systemctl` over the service wrapper, and the unit's ExecReload ran
 * `freeradius -c` (no such option). Source of truth: FreeRADIUS v3.2.x src/main/radiusd.c (getopt string "Cd:D:fhi:l:mMn:p:PstvxX",
 * usage() text, `-C` => "Configuration appears to be OK" as a DEBUG line, so silent below -x; the server name is the basename of argv[0];
 * `-X` = +2 debug and log to stdout; `-v` prints "<name>: FreeRADIUS Version ..., for host ..." then version_print), src/main/log.c
 * (vradlog: nothing is written while the destination is still L_DST_NULL, which is the case until radiusd.conf's log{} is read;
 * timestamps and ": Error: " only outside debug levels 1 and 2), src/main/mainconfig.c ("Errors reading or parsing %s"), src/main/listen.c
 * ("Failed binding to %s: %s", "Error binding to port for %s port %d", the " address * port 1812 bound to server default" form) and
 * src/main/process.c ("Ready to process requests", "Listening on %s"). The version number is the branch's VERSION file (3.2.11);
 * the host triple is the simulator's own build identity, reproducible builds print no build date.
 *
 * Discriminated with git stash on src: 17 of 18 fall before the fix; one passes either way and is named: the witness
 * (the unit answers active, so a second daemon has something to collide with).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const LOG = '/var/log/freeradius/radius.log';
const MAIN = '/etc/freeradius/3.0/radiusd.conf';

async function status(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

describe('the freeradius command', () => {
  it('witness: the unit answers active', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    expect(await server.executeCommand('systemctl status freeradius')).toContain('active (running)');
  });

  it('-h prints the usage of radiusd.c and exits 0', async () => {
    const result = await status(new LinuxServer('linux-server', 'AAA'), 'freeradius -h');
    expect(result.output.split('\n')[0]).toBe('Usage: freeradius [options]');
    expect(result.output).toContain('  -C            Check configuration and exit.');
    expect(result.code).toBe('0');
  });

  it('an unknown option names it and prints the usage, exit 1', async () => {
    const result = await status(new LinuxServer('linux-server', 'AAA'), 'freeradius -Z');
    expect(result.output).toContain("freeradius: invalid option -- 'Z'");
    expect(result.output).toContain('Usage: freeradius [options]');
    expect(result.code).toBe('1');
  });

  it('-v prints the version line then the banner of version_print', async () => {
    const out = (await status(new LinuxServer('linux-server', 'AAA'), 'freeradius -v')).output;
    expect(out.split('\n')[0]).toBe('freeradius: FreeRADIUS Version 3.2.11, for host x86_64-pc-linux-gnu');
    expect(out).toContain('Copyright (C) 1999-2026 The FreeRADIUS server project and contributors');
    expect(out).toContain('https://inkbridgenetworks.com/');
  });

  it('-C on a good configuration is silent and exits 0', async () => {
    const result = await status(new LinuxServer('linux-server', 'AAA'), 'freeradius -C');
    expect(result).toEqual({ output: '', code: '0' });
  });

  it('-C on a broken clients.conf is silent on the terminal, exits 1 and writes the error to radius.log', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    write(server, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n');
    const result = await status(server, 'freeradius -C');
    expect(result).toEqual({ output: '', code: '1' });
    expect(vfsOf(server).readFile(LOG) ?? '').toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} : Error: \/etc\/freeradius\/3\.0\/clients\.conf\[\d+\]: /m);
  });

  it('-C -l stdout puts the timestamped error on the terminal', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    write(server, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n');
    const result = await status(server, 'freeradius -C -l stdout');
    expect(result.output).toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} : Error: \/etc\/freeradius\/3\.0\/clients\.conf\[\d+\]: /);
    expect(result.code).toBe('1');
  });

  it('-C on a broken radiusd.conf is silent: the log destination is not known yet', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    write(server, MAIN, 'log {\n  auth = maybe\n}\n');
    expect(await status(server, 'freeradius -C')).toEqual({ output: '', code: '1' });
    expect(vfsOf(server).readFile(LOG) ?? '').toBe('');
  });

  it('-CX prints the banner, the configuration file and the DEBUG verdict, without timestamps', async () => {
    const out = (await status(new LinuxServer('linux-server', 'AAA'), 'freeradius -CX')).output.split('\n');
    expect(out[0]).toBe('FreeRADIUS Version 3.2.11');
    expect(out).toContain('including configuration file /etc/freeradius/3.0/radiusd.conf');
    expect(out[out.length - 1]).toBe('Configuration appears to be OK');
  });

  it('-CX on a broken radiusd.conf prints the plain errors on the terminal', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    write(server, MAIN, 'log {\n  auth = maybe\n}\n');
    const result = await status(server, 'freeradius -CX');
    expect(result.output).toContain("/etc/freeradius/3.0/radiusd.conf[2]: Invalid value 'maybe' for boolean variable auth");
    expect(result.output).toContain('Errors reading or parsing /etc/freeradius/3.0/radiusd.conf');
    expect(result.code).toBe('1');
  });

  it('-d and -n point at another configuration file', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    write(server, '/etc/other/test.conf', 'log {\n  auth = no\n}\n');
    write(server, '/etc/other/clients.conf', 'client lab {\n  ipaddr = 10.0.0.1\n  secret = s\n}\n');
    write(server, '/etc/other/users', '');
    expect(await status(server, 'freeradius -C -d /etc/other -n test')).toEqual({ output: '', code: '0' });
    expect((await status(server, 'freeradius -CX -d /etc/other -n absent')).output)
      .toContain("Unable to open file '/etc/other/absent.conf': No such file or directory");
  });

  it('a second daemon collides with the running one on UDP 1812, with the listen.c wording', async () => {
    const result = await status(new LinuxServer('linux-server', 'AAA'), 'freeradius -X');
    expect(result.output).toContain('Failed binding to auth address * port 1812 bound to server default: Address already in use');
    expect(result.output).toContain('Error binding to port for 0.0.0.0 port 1812');
    expect(result.code).toBe('1');
  });

  it('with the unit stopped, -X starts the daemon and says so', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    await server.executeCommand('systemctl stop freeradius');
    const result = await status(server, 'freeradius -X');
    expect(result.output).toContain('Listening on auth address * port 1812 bound to server default');
    expect(result.output.split('\n').pop()).toBe('Ready to process requests');
    expect(result.code).toBe('0');
    expect(server.getRadiusd().isRunning()).toBe(true);
  });

  it('-p without -i (and -i without -p) is refused as in radiusd.c', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    expect((await status(server, 'freeradius -C -p 1645')).output).toBe('freeradius: The options -i and -p cannot be used individually.');
    expect((await status(server, 'freeradius -C -i 10.0.0.2')).output).toBe('freeradius: The options -i and -p cannot be used individually.');
  });

  it('an invalid port or address is named as radiusd.c names it', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    expect((await status(server, 'freeradius -p 0 -i 10.0.0.2')).output).toBe('freeradius: Invalid port number "0"');
    expect((await status(server, 'freeradius -p 1645 -i 999.1.1.1')).output).toBe('freeradius: Invalid IP Address or hostname "999.1.1.1"');
  });

  it('-i and -p with the unit stopped listen on that port and the next one only', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    await server.executeCommand('systemctl stop freeradius');
    const result = await status(server, 'freeradius -X -i 127.0.0.1 -p 1645');
    expect(result.output).toContain('Listening on auth address 127.0.0.1 port 1645 bound to server default');
    expect(result.output).toContain('Listening on acct address 127.0.0.1 port 1646 bound to server default');
    const sockets = await server.executeCommand('ss -ulnp');
    expect(sockets).toContain(':1645');
    expect(sockets).toContain(':1646');
    expect(sockets).not.toContain(':1812');
    expect(result.code).toBe('0');
  });

  it('-i and -p on the port the running daemon holds name that port, as listen.c does', async () => {
    const result = await status(new LinuxServer('linux-server', 'AAA'), 'freeradius -X -i 127.0.0.1 -p 1812');
    expect(result.output).toContain('There appears to be another RADIUS server running on the authentication port 1812');
    expect(result.code).toBe('1');
  });

  it('the unit reloads with the check, not with the non-existent -c', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    expect(await server.executeCommand('systemctl cat freeradius')).toContain('ExecReload=/usr/sbin/freeradius -Cm -lstdout');
  });
});
