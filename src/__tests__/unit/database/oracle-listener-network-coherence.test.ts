/**
 * TNS listener ⇄ OS coherence (socket table, process table, systemd).
 *
 * Before this suite, the listener was a pure in-memory flag: TCP 1521
 * was pre-bound at boot and survived `lsnrctl stop`, and no tnslsnr
 * process ever existed — netstat/ss/ps lied about the listener state.
 *
 * Now `oracle-listener-<SID>.service` declares its listener identity
 * (tnslsnr daemon + port 1521) and the existing ServicePortProjection
 * keeps everything coherent:
 *   lsnrctl stop  → service inactive → port released, tnslsnr killed
 *   lsnrctl start → service active   → port bound,   tnslsnr spawned
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { handleLsnrctl } from '@/terminal/commands/OracleCommands';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function bootOracleServer(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 0, 0);
  // First sqlplus initialises the Oracle stack (instance + listener up).
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

function lsnrctl(srv: LinuxServer, sub: string): string {
  const lines: string[] = [];
  handleLsnrctl(srv, [sub], (t) => lines.push(t));
  return lines.join('\n');
}

const netstat = (srv: LinuxServer) => srv.executeShellCommandSync('netstat -tlnp');
const ps = (srv: LinuxServer) => srv.executeShellCommandSync('ps aux');

describe('listener lifecycle drives the socket and process tables', () => {
  it('while running: port 1521 bound, tnslsnr in ps, unit active', () => {
    const srv = bootOracleServer('ora1');
    expect(netstat(srv)).toMatch(/:1521\b.*tnslsnr/);
    expect(ps(srv)).toMatch(/tnslsnr/);
    expect(srv.executeShellCommandSync('systemctl is-active oracle-listener-ORCL').trim())
      .toBe('active');
  });

  it('lsnrctl stop releases TCP 1521 and kills tnslsnr', () => {
    const srv = bootOracleServer('ora2');
    lsnrctl(srv, 'stop');
    expect(netstat(srv)).not.toMatch(/:1521\b/);
    expect(ps(srv)).not.toMatch(/tnslsnr/);
    expect(srv.executeShellCommandSync('systemctl is-active oracle-listener-ORCL').trim())
      .not.toBe('active');
    // And the listener really refuses TNS connects.
    expect(lsnrctl(srv, 'status')).toMatch(/TNS-12541/);
  });

  it('lsnrctl start re-binds 1521 with the new tnslsnr pid', () => {
    const srv = bootOracleServer('ora3');
    lsnrctl(srv, 'stop');
    expect(netstat(srv)).not.toMatch(/:1521\b/);

    lsnrctl(srv, 'start');
    const net = netstat(srv);
    expect(net).toMatch(/:1521\b.*tnslsnr/);
    expect(ps(srv)).toMatch(/tnslsnr LISTENER -inherit/);
    expect(srv.executeShellCommandSync('systemctl is-active oracle-listener-ORCL').trim())
      .toBe('active');

    // The pid shown by netstat is the live daemon, not the boot-time
    // placeholder (2001) that used to be frozen into the socket table.
    const pid = net.match(/(\d+)\/tnslsnr/)?.[1];
    expect(pid).toBeDefined();
    expect(ps(srv)).toMatch(new RegExp(`\\b${pid}\\b`));
  });

  it('ss agrees with netstat about the listener socket', () => {
    const srv = bootOracleServer('ora4');
    expect(srv.executeShellCommandSync('ss -tlnp')).toMatch(/1521/);
    lsnrctl(srv, 'stop');
    expect(srv.executeShellCommandSync('ss -tlnp')).not.toMatch(/1521/);
  });
});

describe('listener.ora drives the listening port', () => {
  it('a port edited in listener.ora is honoured at lsnrctl start', () => {
    const srv = bootOracleServer('oraport');
    const path = '/u01/app/oracle/product/19c/dbhome_1/network/admin/listener.ora';
    const conf = srv.readFileForEditor(path)!;
    srv.writeFileFromEditor(path, conf.replace('(PORT = 1521)', '(PORT = 1530)'));

    lsnrctl(srv, 'stop');
    expect(netstat(srv)).not.toMatch(/:1521\b/);
    lsnrctl(srv, 'start');

    const net = netstat(srv);
    expect(net).toMatch(/:1530\b.*tnslsnr/);
    expect(net).not.toMatch(/:1521\b/);
    expect(lsnrctl(srv, 'status')).toContain('PORT=1530');
  });
});
