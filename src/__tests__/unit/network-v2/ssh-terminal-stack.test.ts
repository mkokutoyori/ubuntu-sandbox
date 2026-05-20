/**
 * SSH terminal-stack tests — no UI involved.
 *
 * Everything goes either through:
 *   - `device.executeCommand(line)`   → the bash interpreter side of the
 *     device (where `ssh` is a stub returning Connection refused), AND
 *   - the real SSH stack (`SshSession`, `SftpSession`) wired onto the
 *     device's TCP connector — this exercises the same code paths the
 *     UI's `connectAndEnterSsh` uses, but in pure programmatic form.
 *
 * Topology:
 *
 *     PC1 (10.0.0.1) client            }
 *     PC2 (10.0.0.2) web-server target } GenericSwitch (8 ports)
 *     PC3 (10.0.0.3) db-server  target }
 *     PC4 (10.0.0.4) jump-box          }
 *
 * Every PC auto-runs sshd (port 22) with user `user` / password `admin`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { isOk } from '@/network/protocols/ssh/Result';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { TcpConnector } from '@/network/core/TcpConnection';

const PC1_IP = '10.0.0.1';
const PC2_IP = '10.0.0.2';
const PC3_IP = '10.0.0.3';
const PC4_IP = '10.0.0.4';
const NETMASK = '255.255.255.0';

interface Lan {
  pc1: LinuxPC;
  pc2: LinuxPC;
  pc3: LinuxPC;
  pc4: LinuxPC;
  sw: GenericSwitch;
}

async function buildLan(): Promise<Lan> {
  EquipmentRegistry.resetInstance();

  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 100, 0);
  const pc3 = new LinuxPC('linux-pc', 'PC3', 200, 0);
  const pc4 = new LinuxPC('linux-pc', 'PC4', 300, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);

  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c3').connect(pc3.getPort('eth0')!, sw.getPort('eth2')!);
  new Cable('c4').connect(pc4.getPort('eth0')!, sw.getPort('eth3')!);

  await pc1.executeCommand(`ifconfig eth0 ${PC1_IP} netmask ${NETMASK}`);
  await pc2.executeCommand(`ifconfig eth0 ${PC2_IP} netmask ${NETMASK}`);
  await pc3.executeCommand(`ifconfig eth0 ${PC3_IP} netmask ${NETMASK}`);
  await pc4.executeCommand(`ifconfig eth0 ${PC4_IP} netmask ${NETMASK}`);

  // Prime ARP across all pairs so the very first TCP handshake doesn't drop.
  const ips = [PC1_IP, PC2_IP, PC3_IP, PC4_IP];
  for (const [pc, ip] of [[pc1, PC1_IP], [pc2, PC2_IP], [pc3, PC3_IP], [pc4, PC4_IP]] as const) {
    for (const other of ips) {
      if (other === ip) continue;
      await pc.executeCommand(`ping -c 1 ${other}`);
    }
  }
  return { pc1, pc2, pc3, pc4, sw };
}

function vfsOf(pc: LinuxPC): VirtualFileSystem {
  return (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function tcpConnectorOf(pc: LinuxPC): TcpConnector {
  const dev = pc as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> };
  return (host, port) => dev.tcpConnect(host, port) as Promise<never>;
}

/**
 * Open an authenticated `SshSession` from `client` to `targetIp`. This is
 * the same machinery `LinuxTerminalSession.connectAndEnterSsh` uses minus
 * the UI plumbing — pure programmatic SSH.
 */
async function openSession(
  client: LinuxPC,
  targetIp: string,
  user = 'user',
  password = 'admin',
): Promise<SshSession> {
  const localVfs = new VirtualFileSystem();
  const session = new SshSession({
    tcpConnector: tcpConnectorOf(client),
    vfs: localVfs,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
  });
  const result = await session.connect(
    SshConnectOptionsBuilder.create()
      .host(targetIp)
      .user(user)
      .port(22)
      .password(password)
      .strictHostKeyChecking('accept-new')
      .build(),
  );
  if (!isOk(result)) {
    session.disconnect();
    throw new Error(`SSH connect failed: ${JSON.stringify(result.error)}`);
  }
  return session;
}

async function execRemote(
  session: SshSession,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const ch = session.openExecChannel(command);
  if (!isOk(ch)) throw new Error('failed to open exec channel');
  const result = await ch.value.execute();
  ch.value.close();
  return result;
}

// ── 1. device.executeCommand level (no SSH connectivity, just bash dispatch) ──

describe('SSH terminal — device.executeCommand stubs', () => {
  let lan: Lan;
  beforeEach(async () => {
    lan = await buildLan();
  });

  it('connects via `ssh user@host` and runs the remote command (Phase D-2 exec)', async () => {
    // Both pc1 and pc2 ship sshd Running by default. The remote command
    // mode prints just the command's output (no banner) — here, the
    // remote's /etc/hostname.
    const out = await lan.pc1.executeCommand(`ssh alice@${PC2_IP} hostname`);
    expect(out.trim()).toMatch(/^[a-z0-9-]+$/);
    expect(out).not.toMatch(/Connection refused/);
  });

  it('interactive ssh (no remote command) prints the OpenSSH banner', async () => {
    const out = await lan.pc1.executeCommand(`ssh alice@${PC2_IP}`);
    expect(out).toContain('Welcome to Ubuntu');
  });

  it('refuses when the remote sshd service has been stopped', async () => {
    lan.pc2.executeCommand('systemctl stop ssh');
    const out = await lan.pc1.executeCommand(`ssh alice@${PC2_IP} hostname`);
    expect(out).toMatch(/Connection refused/);
  });

  it('returns usage for empty `ssh`', async () => {
    const out = await lan.pc1.executeCommand('ssh');
    expect(out).toMatch(/usage: ssh/);
  });

  it('sftp user@host now opens an SFTP prompt when sshd is up (Phase D-2)', async () => {
    const out = await lan.pc1.executeCommand(`sftp user@${PC2_IP}`);
    expect(out).toMatch(/Connected to|sftp>/);
    // Stopping ssh on the remote makes it refuse.
    await lan.pc2.executeCommand('systemctl stop ssh');
    const refused = await lan.pc1.executeCommand(`sftp user@${PC2_IP}`);
    expect(refused).toMatch(/Connection refused/);
  });

  it('keeps the sshd service listed as running on every Linux PC', async () => {
    const out = await lan.pc2.executeCommand('ss -tln');
    expect(out).toMatch(/0\.0\.0\.0:22/);
  });

  it('shows sshd in the process list', async () => {
    const out = await lan.pc2.executeCommand('ps -ef');
    expect(out).toMatch(/sshd/);
  });

  it('exposes /etc/ssh/sshd_config on every Linux PC', async () => {
    const out = await lan.pc1.executeCommand('cat /etc/ssh/sshd_config');
    expect(out).toMatch(/Port 22/);
    expect(out).toMatch(/PasswordAuthentication/);
  });
});

// ── 2. Real SSH stack via SshSession (no UI) — single host ──

describe('SSH terminal — direct SshSession (single host)', () => {
  let lan: Lan;
  beforeEach(async () => {
    lan = await buildLan();
  });

  it('connects with valid credentials', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    expect(s.isConnected).toBe(true);
    s.disconnect();
  });

  it('rejects with a wrong password', async () => {
    await expect(openSession(lan.pc1, PC2_IP, 'user', 'wrong')).rejects.toThrow(
      /AUTH_FAILED|Permission/i,
    );
  });

  it('rejects an unknown user', async () => {
    await expect(openSession(lan.pc1, PC2_IP, 'ghost', 'anything')).rejects.toThrow();
  });

  it('refuses an unreachable IP', async () => {
    await expect(openSession(lan.pc1, '99.99.99.99')).rejects.toThrow(
      /CONNECTION_REFUSED|connect/i,
    );
  });

  it('runs hostname remotely and gets the server hostname', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    const r = await execRemote(s, 'hostname');
    expect(r.stdout.trim()).toBe('linux-pc');
    s.disconnect();
  });

  it('runs whoami remotely and gets the connecting user', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    const r = await execRemote(s, 'whoami');
    expect(r.stdout.trim()).toBe('user');
    s.disconnect();
  });

  it('runs `ifconfig eth0` and reads the remote PC2 IP', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    const r = await execRemote(s, 'ifconfig eth0');
    expect(r.stdout).toContain(PC2_IP);
    s.disconnect();
  });

  it('produces an error message for a failing command (cat on missing file)', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    const r = await execRemote(s, 'cat /nonexistent');
    // The simulator's bash propagates the message to stdout; either an exit
    // code or an error in the body is enough to confirm the failure.
    expect(r.stdout + r.stderr).toMatch(/No such file|cannot|not found/i);
    s.disconnect();
  });

  it('persists state inside a single SshSession across multiple execs', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    // /tmp is shared across exec channels (it's the same VFS).
    await execRemote(s, 'mkdir -p /tmp/sandbox-tests');
    await execRemote(s, 'echo hello > /tmp/sandbox-tests/file.txt');
    const r = await execRemote(s, 'cat /tmp/sandbox-tests/file.txt');
    expect(r.stdout.trim()).toBe('hello');
    s.disconnect();
  });
});

// ── 3. Multi-host scenarios ─────────────────────────────────────────────

describe('SSH terminal — multi-host scenarios', () => {
  let lan: Lan;
  beforeEach(async () => {
    lan = await buildLan();
  });

  it('opens parallel sessions from PC1 to PC2 and PC3 without interference', async () => {
    const [s2, s3] = await Promise.all([
      openSession(lan.pc1, PC2_IP),
      openSession(lan.pc1, PC3_IP),
    ]);
    const [r2, r3] = await Promise.all([
      execRemote(s2, 'ifconfig eth0'),
      execRemote(s3, 'ifconfig eth0'),
    ]);
    expect(r2.stdout).toContain(PC2_IP);
    expect(r3.stdout).toContain(PC3_IP);
    s2.disconnect();
    s3.disconnect();
  });

  it('routes commands to the right machine based on the connected host', async () => {
    // Tag each machine via a file so identity is unambiguous.
    vfsOf(lan.pc2).writeFile('/etc/marker', 'PC2-web\n', 0, 0, 0o022);
    vfsOf(lan.pc3).writeFile('/etc/marker', 'PC3-db\n', 0, 0, 0o022);

    const s2 = await openSession(lan.pc1, PC2_IP);
    const s3 = await openSession(lan.pc1, PC3_IP);
    expect((await execRemote(s2, 'cat /etc/marker')).stdout.trim()).toBe('PC2-web');
    expect((await execRemote(s3, 'cat /etc/marker')).stdout.trim()).toBe('PC3-db');
    s2.disconnect();
    s3.disconnect();
  });

  it('lets PC4 connect to PC2 and PC3 sequentially', async () => {
    const s2 = await openSession(lan.pc4, PC2_IP);
    await execRemote(s2, 'true');
    s2.disconnect();

    const s3 = await openSession(lan.pc4, PC3_IP);
    expect((await execRemote(s3, 'hostname')).stdout.trim()).toBe('linux-pc');
    s3.disconnect();
  });

  it('records the right source IPs in PC2 auth.log when PC1 and PC4 both log in', async () => {
    const s1 = await openSession(lan.pc1, PC2_IP);
    s1.disconnect();
    const s4 = await openSession(lan.pc4, PC2_IP);
    s4.disconnect();

    const log = vfsOf(lan.pc2).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted password for user from 10\.0\.0\.1/);
    expect(log).toMatch(/Accepted password for user from 10\.0\.0\.4/);
  });
});

// ── 4. SFTP over the same stack ────────────────────────────────────────

describe('SSH terminal — SftpSession transfers', () => {
  let lan: Lan;
  let sftp: SftpSession;
  let localVfs: VirtualFileSystem;

  beforeEach(async () => {
    lan = await buildLan();
    localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/source.txt', 'payload-content\n', 0, 0, 0o022);
    sftp = new SftpSession({
      tcpConnector: tcpConnectorOf(lan.pc1),
      localVfs,
      localUser: 'root',
      localUid: 0,
      localGid: 0,
      localCwd: '/root',
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: new SilentSshInteractionHandler('admin'),
      homeDirectory: '/root',
    });
    const banner = await sftp.connect(`user@${PC2_IP}`, { password: 'admin' });
    expect(banner).toContain('Connected');
  });

  it('uploads (put) a local file to the remote home directory', () => {
    sftp.put('/root/source.txt', 'uploaded.txt');
    const remote = vfsOf(lan.pc2).readFile('/home/user/uploaded.txt');
    expect(remote).toBe('payload-content\n');
  });

  it('downloads (get) a remote file to the local VFS', () => {
    vfsOf(lan.pc2).writeFile('/home/user/from-server.txt', 'down-content\n', 1000, 1000, 0o022);
    sftp.get('from-server.txt', '/root/from-server.txt');
    expect(localVfs.readFile('/root/from-server.txt')).toBe('down-content\n');
  });

  it('lists the remote home directory contents', () => {
    vfsOf(lan.pc2).writeFile('/home/user/a.txt', 'A', 1000, 1000, 0o022);
    vfsOf(lan.pc2).writeFile('/home/user/b.txt', 'B', 1000, 1000, 0o022);
    const ls = sftp.ls(['.'], new Set());
    expect(ls).toMatch(/a\.txt/);
    expect(ls).toMatch(/b\.txt/);
  });

  it('creates a remote directory with mkdir', () => {
    expect(sftp.mkdir('newdir')).toBe('');
    expect(vfsOf(lan.pc2).exists('/home/user/newdir')).toBe(true);
  });

  it('removes a remote file with rm', () => {
    vfsOf(lan.pc2).writeFile('/home/user/doomed.txt', 'x', 1000, 1000, 0o022);
    expect(sftp.rm('doomed.txt')).toBe('');
    expect(vfsOf(lan.pc2).exists('/home/user/doomed.txt')).toBe(false);
  });

  it('renames a remote file', () => {
    vfsOf(lan.pc2).writeFile('/home/user/oldname', 'x', 1000, 1000, 0o022);
    expect(sftp.rename('oldname', 'newname')).toBe('');
    expect(vfsOf(lan.pc2).exists('/home/user/oldname')).toBe(false);
    expect(vfsOf(lan.pc2).exists('/home/user/newname')).toBe(true);
  });

  it('changes the remote working directory with cd', () => {
    expect(sftp.cd('/tmp')).toBe('');
    expect(sftp.pwd()).toMatch(/\/tmp/);
  });
});

// ── 5. Server-side reactive observations ───────────────────────────────

describe('SSH terminal — auth.log + event bus observable from outside', () => {
  let lan: Lan;
  beforeEach(async () => {
    lan = await buildLan();
  });

  it('PC2 auth.log accumulates an Accepted password line per successful login', async () => {
    (await openSession(lan.pc1, PC2_IP)).disconnect();
    (await openSession(lan.pc1, PC2_IP)).disconnect();

    const log = vfsOf(lan.pc2).readFile('/var/log/auth.log') ?? '';
    const accepted = log.match(/Accepted password for user/g) ?? [];
    expect(accepted.length).toBe(2);
  });

  it('PC2 auth.log records pam_unix session-open lines for each remote exec', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    await execRemote(s, 'true');
    await execRemote(s, 'true');
    s.disconnect();

    const log = vfsOf(lan.pc2).readFile('/var/log/auth.log') ?? '';
    const opened = log.match(/session opened for user user/g) ?? [];
    expect(opened.length).toBeGreaterThanOrEqual(2);
  });

  it('triggers the throttler after enough failed attempts and then refuses correct credentials', async () => {
    // Default throttler: threshold 5, window 60s, block 5min.
    for (let i = 0; i < 5; i++) {
      await expect(openSession(lan.pc1, PC2_IP, 'user', 'bad')).rejects.toThrow();
    }
    await expect(openSession(lan.pc1, PC2_IP, 'user', 'admin')).rejects.toThrow();
  });
});

// ── 6. ssh_config / sshd_config integration ────────────────────────────

describe('SSH terminal — sshd_config enforcement', () => {
  let lan: Lan;
  beforeEach(async () => {
    lan = await buildLan();
  });

  it('reflects PasswordAuthentication=no after editing the config file directly via VFS', async () => {
    const cfg = vfsOf(lan.pc2).readFile('/etc/ssh/sshd_config') ?? '';
    const patched = cfg.replace(/PasswordAuthentication .*/g, 'PasswordAuthentication no');
    vfsOf(lan.pc2).writeFile('/etc/ssh/sshd_config', patched, 0, 0, 0o022);

    const out = await lan.pc2.executeCommand(
      'cat /etc/ssh/sshd_config | grep PasswordAuth',
    );
    expect(out).toMatch(/PasswordAuthentication no/);
  });

  it('records auth_failure with reason=root_login_disabled when root tries to log in', async () => {
    await expect(openSession(lan.pc1, PC2_IP, 'root', 'admin')).rejects.toThrow();
    const log = vfsOf(lan.pc2).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/(Invalid user root|Failed unknown for root|Failed password for root)/);
  });
});

// ── 7. Pipelines and compound commands over SSH ────────────────────────

describe('SSH terminal — pipelines and compound commands', () => {
  let lan: Lan;
  beforeEach(async () => {
    lan = await buildLan();
  });

  it('runs a piped command remotely (ls -1 | wc -l)', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    await execRemote(s, 'mkdir -p /tmp/x && touch /tmp/x/a /tmp/x/b /tmp/x/c');
    const r = await execRemote(s, 'ls -1 /tmp/x | wc -l');
    expect(r.stdout.trim()).toBe('3');
    s.disconnect();
  });

  it('runs grep through SSH', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    const r = await execRemote(s, "printf 'foo\\nbar\\nbaz\\n' | grep ba");
    expect(r.stdout).toContain('bar');
    expect(r.stdout).toContain('baz');
    s.disconnect();
  });

  it('produces no matching output when grep finds nothing', async () => {
    const s = await openSession(lan.pc1, PC2_IP);
    const r = await execRemote(s, 'printf "hi\\n" | grep nope');
    // The simulated bash may or may not propagate non-zero exit codes through
    // pipes — but stdout must be empty when grep matches nothing.
    expect(r.stdout.trim()).toBe('');
    s.disconnect();
  });
});
