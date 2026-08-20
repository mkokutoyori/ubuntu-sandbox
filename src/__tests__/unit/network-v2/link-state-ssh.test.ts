import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CrossVendorRemoteShell } from '@/shell/CrossVendorRemoteShell';
import { installDefaultShells } from '@/shell/registerDefaults';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

function lan(): { a: LinuxPC; b: LinuxPC; cable: Cable } {
  const a = new LinuxPC('linux-pc', 'pcA', 0, 0);
  const b = new LinuxPC('linux-pc', 'pcB', 0, 0);
  a.setHostname('pca');
  b.setHostname('pcb');
  const cable = new Cable('c1');
  cable.connect(a.getPorts()[0], b.getPorts()[0]);
  const mask = new SubnetMask('255.255.255.0');
  a.getPorts()[0].configureIP(new IPAddress('10.0.3.1'), mask);
  b.getPorts()[0].configureIP(new IPAddress('10.0.3.2'), mask);

  for (const d of [a, b]) {
    const um = (d as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void;
      getUser: (u: string) => unknown;
      setPassword: (u: string, p: string) => void;
    } } }).executor.userMgr;
    if (!um.getUser('alice')) {
      um.useradd('alice', { m: true, s: '/bin/bash' });
      um.setPassword('alice', 'admin');
    }
  }
  return { a, b, cable };
}

describe('one-shot ssh over a severed link (docs/PRD-Link-State.md §4 #10, P6)', () => {
  it('reaches the remote while the cable is plugged in', async () => {
    const { a } = lan();
    const out = await a.executeCommand('ssh alice@10.0.3.2 hostname');
    expect(out).toContain('pcb');
  }, 30000);

  it('fails once the cable is pulled instead of silently succeeding', async () => {
    const { a, cable } = lan();
    expect(await a.executeCommand('ssh alice@10.0.3.2 hostname')).toContain('pcb');

    cable.disconnect();

    const out = await a.executeCommand('ssh alice@10.0.3.2 hostname');
    expect(out).not.toContain('pcb');
    expect(out).toMatch(/No route to host|Connection timed out|Network is unreachable/);
  }, 30000);

  it('scp fails the same way once the link is gone', async () => {
    const { a, cable } = lan();
    cable.disconnect();
    const out = await a.executeCommand('scp /etc/hostname alice@10.0.3.2:/tmp/x');
    expect(out).toMatch(/No route to host|Connection timed out|Network is unreachable/);
  }, 30000);

  it('sftp fails the same way once the link is gone', async () => {
    const { a, cable } = lan();
    cable.disconnect();
    const out = await a.executeCommand('sftp alice@10.0.3.2');
    expect(out).toMatch(/No route to host|Connection timed out|Network is unreachable/);
  }, 30000);
});

describe('interactive remote shell liveness (docs/PRD-Link-State.md §3.3 / §4 #11, P6)', () => {
  function remoteShell(alive: () => boolean, onClose?: () => void): CrossVendorRemoteShell {
    const { b } = lan();
    return new CrossVendorRemoteShell({
      device: b,
      user: 'alice',
      remoteHost: '10.0.3.2',
      primaryKind: 'bash',
      probeAlive: alive,
      onClose,
    });
  }

  it('runs commands normally while the path is alive', async () => {
    const shell = remoteShell(() => true);
    const res = await shell.processLine('hostname');
    expect(res.output.join('\n')).toContain('pcb');
    expect(res.exit).toBeFalsy();
  }, 30000);

  it('reports a broken pipe and ends the session once the path is gone', async () => {
    const shell = remoteShell(() => false);
    const res = await shell.processLine('hostname');
    expect(res.output.join('\n')).toContain('client_loop: send disconnect: Broken pipe');
    expect(res.output.join('\n')).not.toContain('pcb');
    expect(res.exit).toBe(true);
    expect(shell.isFinished).toBe(true);
  }, 30000);

  it('closes the session registry entry so w/who stop listing it', async () => {
    let closed = false;
    const shell = remoteShell(() => false, () => { closed = true; });
    await shell.processLine('hostname');
    expect(closed).toBe(true);
  }, 30000);

  it('a session with no probe configured is left exactly as before', async () => {
    const { b } = lan();
    const shell = new CrossVendorRemoteShell({
      device: b, user: 'alice', remoteHost: '10.0.3.2', primaryKind: 'bash',
    });
    const res = await shell.processLine('hostname');
    expect(res.output.join('\n')).toContain('pcb');
  }, 30000);
});
