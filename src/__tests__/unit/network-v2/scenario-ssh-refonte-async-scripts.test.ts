/**
 * SSH wire-fidelity refactor — Phase 2 (fondation) : `bash script.sh` /
 * `./script.sh` / `run-parts DIR` genuinely await a network command hiding
 * inside the invoked file, instead of silently resolving to a synchronous
 * "command not found" while the async operation's side effects keep
 * running detached in the background.
 *
 * Root cause (see docs/audit + the plan for this refactor):
 * `LinuxMachine.containsNetworkCommand()` only scans the literal tokens of
 * the typed line for a known network-command name — for `bash script.sh`
 * the network command, if any, is inside the file's content and invisible
 * to that scan, so the line always took the synchronous `executor.execute()`
 * path regardless of what the script contained. `ping`/`traceroute` are
 * used here as neutral, already-100%-async probes (SSH itself isn't
 * migrated yet — that's Phase 3).
 *
 * Also locks in a safety property found while implementing the fix: the
 * new fast path in `LinuxCommandExecutor.dispatchMaybeNetwork()` must NOT
 * strip a leading `sudo` before routing to the async script twins — the
 * real sudoers authorization/audit/user-switch logic lives in the
 * synchronous `dispatch()` and must still run for `sudo bash script.sh`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  buildLan,
  assignIps,
  type SshLan,
  PC2_IP,
} from './ssh-lan-fixtures';

describe('Phase 2 — async foundation for bash/sh/./script/run-parts', () => {
  let lan: SshLan;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    lan = buildLan();
    await assignIps(lan);
  });

  async function writeExec(pc: LinuxPC, path: string, content: string): Promise<void> {
    await pc.executeCommand(`cat << 'EOF' > ${path}\n${content}\nEOF`);
    await pc.executeCommand(`chmod +x ${path}`);
  }

  describe('a network command inside the script file is genuinely awaited', () => {
    it('`bash script.sh` awaits an embedded `ping`', async () => {
      await writeExec(lan.pc1, '/tmp/probe1.sh', `ping -c 1 ${PC2_IP}`);
      const out = await lan.pc1.executeCommand('bash /tmp/probe1.sh');
      expect(out).toContain(`64 bytes from ${PC2_IP}`);
      expect(out).not.toMatch(/not found/);
    });

    it('`./script.sh` (direct execution) awaits an embedded `ping`', async () => {
      await writeExec(lan.pc1, '/tmp/probe2.sh', `ping -c 1 ${PC2_IP}`);
      await lan.pc1.executeCommand('cd /tmp');
      const out = await lan.pc1.executeCommand('./probe2.sh');
      expect(out).toContain(`64 bytes from ${PC2_IP}`);
      expect(out).not.toMatch(/not found/);
    });

    it('an absolute path invocation (`/tmp/script.sh`) awaits an embedded `ping`', async () => {
      await writeExec(lan.pc1, '/tmp/probe3.sh', `ping -c 1 ${PC2_IP}`);
      const out = await lan.pc1.executeCommand('/tmp/probe3.sh');
      expect(out).toContain(`64 bytes from ${PC2_IP}`);
      expect(out).not.toMatch(/not found/);
    });

    it('`run-parts DIR` awaits an embedded `ping` in one of the directory scripts', async () => {
      await lan.pc1.executeCommand('mkdir -p /tmp/parts');
      await writeExec(lan.pc1, '/tmp/parts/job1', `ping -c 1 ${PC2_IP}`);
      const out = await lan.pc1.executeCommand('run-parts /tmp/parts');
      expect(out).toContain(`64 bytes from ${PC2_IP}`);
      expect(out).not.toMatch(/not found/);
    });

    it('a script invoked from within another script (nested) still awaits the embedded `ping`', async () => {
      await writeExec(lan.pc1, '/tmp/inner.sh', `ping -c 1 ${PC2_IP}`);
      await writeExec(lan.pc1, '/tmp/outer.sh', 'bash /tmp/inner.sh');
      const out = await lan.pc1.executeCommand('bash /tmp/outer.sh');
      expect(out).toContain(`64 bytes from ${PC2_IP}`);
      expect(out).not.toMatch(/not found/);
    });
  });

  describe('plain (non-network) scripts still behave exactly as before', () => {
    it('`bash script.sh` still returns normal output and exit code', async () => {
      await writeExec(lan.pc1, '/tmp/plain1.sh', 'echo hello; exit 3');
      const out = await lan.pc1.executeCommand('bash /tmp/plain1.sh; echo "exit=$?"');
      expect(out).toContain('hello');
      expect(out).toContain('exit=3');
    });

    it('`./script.sh` still returns normal output and exit code', async () => {
      await writeExec(lan.pc1, '/tmp/plain2.sh', 'echo hi-there; exit 7');
      await lan.pc1.executeCommand('cd /tmp');
      const out = await lan.pc1.executeCommand('./plain2.sh; echo "exit=$?"');
      expect(out).toContain('hi-there');
      expect(out).toContain('exit=7');
    });

    it('`run-parts DIR` still runs every executable entry in order', async () => {
      await lan.pc1.executeCommand('mkdir -p /tmp/parts2');
      await writeExec(lan.pc1, '/tmp/parts2/a', 'echo first');
      await writeExec(lan.pc1, '/tmp/parts2/b', 'echo second');
      const out = await lan.pc1.executeCommand('run-parts /tmp/parts2');
      expect(out).toContain('first');
      expect(out).toContain('second');
      expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
    });
  });

  describe('sudo-wrapped script invocations still go through the real sudoers policy engine', () => {
    let srv: LinuxServer;

    beforeEach(async () => {
      srv = new LinuxServer('linux-server', 'srv1', 0, 0);
      srv.powerOn();
      await srv.executeCommand('useradd -m -s /bin/bash user-admin');
      await srv.executeCommand('useradd -m -s /bin/bash user-plain');
      await srv.executeCommand(`cat << 'EOF' > /etc/sudoers.d/phase2-async
user-admin ALL=(ALL) NOPASSWD: ALL
EOF`);
      await srv.executeCommand('chmod 440 /etc/sudoers.d/phase2-async');
      await srv.executeCommand("cat << 'EOF' > /tmp/whoami.sh\nwhoami\nEOF");
      await srv.executeCommand('chmod +x /tmp/whoami.sh');
    });

    it('a sudoer with NOPASSWD is genuinely elevated to root for `sudo bash script.sh`', async () => {
      const out = await srv.executeCommand('su - user-admin -c "sudo bash /tmp/whoami.sh"');
      expect(out.trim()).toBe('root');
    });

    it('a non-sudoer is still refused by the real policy engine, not silently allowed', async () => {
      const out = await srv.executeCommand('su - user-plain -c "sudo bash /tmp/whoami.sh"');
      expect(out).toMatch(/is not in the sudoers file/);
    });
  });
});
