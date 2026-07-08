/**
 * bind9 reachability from inside a bash script.
 *
 * `named-checkconf`/`named-checkzone` were already reachable when typed
 * directly at the prompt (see bind9-named-checkconf.test.ts) — they're
 * registered in the LinuxCommandRegistry, which LinuxMachine.executeCommand
 * consults directly. But a bash *script* (`bash foo.sh`) dispatches each
 * internal line through LinuxCommandExecutor's own switch-based
 * dispatch(), which has no visibility into that registry at all, so the
 * exact same commands used to fail with "command not found" the moment
 * they appeared inside a script (e.g. `named-checkconf || fail "..."`).
 *
 * Also covers: `systemctl <verb> bind9` resolving to the `named` unit
 * (matching real Debian/Ubuntu, where the bind9 package ships
 * named.service and bind9.service is a compatibility alias for it), and
 * `apt install bind9` laying down the default /etc/bind/named.conf
 * skeleton the real package ships.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}
function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}
function readFile(server: LinuxServer, path: string): string | null {
  return vfsOf(server).readFile(path);
}
async function runScript(server: LinuxServer, body: string): Promise<string> {
  writeRoot(server, '/tmp/__t.sh', body);
  const inode = vfsOf(server).resolveInode('/tmp/__t.sh');
  if (inode) inode.permissions = 0o755;
  return server.executeCommand('bash /tmp/__t.sh');
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('named-checkconf/named-checkzone reachable from inside a bash script', () => {
  it('a valid config lets `named-checkconf || fail` continue past the check', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    writeRoot(srv, '/etc/bind/named.conf', 'options { recursion no; };');

    const out = await runScript(srv, `
      set -e
      named-checkconf || { echo FAILED; exit 1; }
      echo PASSED
    `);
    expect(out).toContain('PASSED');
    expect(out).not.toContain('FAILED');
    expect(out).not.toContain('command not found');
  });

  it('a broken config trips the `|| fail` branch instead of "command not found"', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    // Missing named.conf entirely.
    const out = await runScript(srv, `
      named-checkconf || { echo FAILED; exit 1; }
      echo PASSED
    `);
    expect(out).toContain('FAILED');
    expect(out).not.toContain('PASSED');
    expect(out).not.toContain('command not found');
  });

  it('named-checkzone validates a real zone file from inside a script', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    writeRoot(srv, '/etc/bind/db.lab.local',
      '$TTL 604800\n@ IN SOA ns1.lab.local. admin.lab.local. ( 2 604800 86400 2419200 604800 )\n@ IN NS ns1.lab.local.\nns1 IN A 192.168.10.10\n');

    const out = await runScript(srv, `
      set -e
      named-checkzone lab.local /etc/bind/db.lab.local || { echo FAILED; exit 1; }
      echo PASSED
    `);
    expect(out).toContain('loaded serial 2');
    expect(out).toContain('PASSED');
  });
});

describe('systemctl bind9 <-> named unit alias', () => {
  it('systemctl restart bind9 resolves to the named unit', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    writeRoot(srv, '/etc/bind/named.conf', 'options { recursion no; };');
    const out = await srv.executeCommand('systemctl restart bind9');
    expect(out).not.toContain('bind9.service not found');
  });

  it('systemctl status bind9 reports the named service by its real unit name', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    writeRoot(srv, '/etc/bind/named.conf', 'options { recursion no; };');
    await srv.executeCommand('systemctl restart bind9');
    const out = await srv.executeCommand('systemctl status bind9');
    expect(out).toContain('named.service');
    expect(out).toContain('active (running)');
  });

  it('systemctl enable bind9 creates the named.service symlink', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    const out = await srv.executeCommand('systemctl enable bind9');
    expect(out).toContain('named.service');
  });
});

describe('apt install bind9 provisions the default named.conf skeleton', () => {
  it('writes /etc/bind/named.conf with the standard includes when absent', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    expect(readFile(srv, '/etc/bind/named.conf')).toBeNull();

    await srv.executeCommand('apt install -y bind9');

    const conf = readFile(srv, '/etc/bind/named.conf') ?? '';
    expect(conf).toContain('include "/etc/bind/named.conf.options";');
    expect(conf).toContain('include "/etc/bind/named.conf.local";');
  });

  it('does not clobber an already-customized named.conf', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    writeRoot(srv, '/etc/bind/named.conf', 'options { recursion no; };');

    await srv.executeCommand('apt install -y bind9');

    expect(readFile(srv, '/etc/bind/named.conf')).toBe('options { recursion no; };');
  });
});

describe('end to end: root-check + colors + config + validation + service start', () => {
  it('the full setup-bind9.sh shaped script succeeds without any manual intervention', async () => {
    const srv = new LinuxServer('linux-server', 'NS1');
    const script = `#!/bin/bash
set -e
GREEN='\\033[0;32m'
NC='\\033[0m'
log() { echo -e "\${GREEN}[OK]\${NC} $1"; }
fail() { echo "FAILED: $1"; exit 1; }

if [[ $EUID -ne 0 ]]; then
  fail "must be root"
fi
log "root confirmed"

apt install -y bind9 > /dev/null 2>&1
log "bind9 installed"

cat > /etc/bind/named.conf.options << EOF
options { directory "/var/cache/bind"; recursion yes; };
EOF
cat > /etc/bind/named.conf.local << EOF
zone "lab.local" { type master; file "/etc/bind/db.lab.local"; };
EOF
cat > /etc/bind/db.lab.local << EOF
\\$TTL 604800
@ IN SOA ns1.lab.local. admin.lab.local. ( 2 604800 86400 2419200 604800 )
@ IN NS ns1.lab.local.
ns1 IN A 192.168.10.10
EOF

named-checkconf || fail "named.conf error"
log "named.conf valid"
named-checkzone lab.local /etc/bind/db.lab.local || fail "zone error"
log "zone valid"

systemctl restart bind9 || fail "bind9 restart failed"
log "bind9 restarted"
echo "SETUP COMPLETE"
`;
    const out = await runScript(srv, script);

    expect(out).toContain('root confirmed');
    expect(out).toContain('named.conf valid');
    expect(out).toContain('zone valid');
    expect(out).toContain('bind9 restarted');
    expect(out).toContain('SETUP COMPLETE');
    expect(out).not.toContain('FAILED');
    expect(out).not.toContain('command not found');

    // The colored log lines actually carry real ANSI escapes, not the
    // literal backslash-033 text a doubling bug would have produced.
    expect(out).toContain('\x1b[0;32m[OK]\x1b[0m');

    const status = await srv.executeCommand('systemctl status bind9');
    expect(status).toContain('active (running)');
  });
});
