import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';

async function getent(pc: LinuxPC, args: string): Promise<{ output: string; exitCode: number }> {
  const out = await pc.executeCommand(`getent ${args}; echo "__rc=$?"`);
  const m = /__rc=(\d+)\s*$/.exec(out);
  const exitCode = m ? parseInt(m[1], 10) : 0;
  const output = out.replace(/__rc=\d+\s*$/, '').trim();
  return { output, exitCode };
}

function makeRootPc(): LinuxPC {
  EquipmentRegistry.resetInstance();
  const bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);
  const pc = new LinuxPC('pc1');
  pc.setEventBus(bus);
  pc.powerOn();
  pc.executor.userMgr.currentUid = 0;
  pc.executor.userMgr.currentUser = 'root';
  return pc;
}

describe('nss-systemd — synthesised root/nobody', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = makeRootPc(); });

  it('synthesises root through the systemd source', async () => {
    const r = await getent(pc, '-s systemd passwd root');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^root:x:0:0:Super User:\/root:\/bin\/sh$/);
  });

  it('synthesises nobody (65534) by name', async () => {
    const r = await getent(pc, '-s systemd passwd nobody');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^nobody:x:65534:65534:.*:\/:\/usr\/sbin\/nologin$/);
  });

  it('synthesises nobody by uid', async () => {
    const r = await getent(pc, '-s systemd passwd 65534');
    expect(r.output).toMatch(/^nobody:/);
  });

  it('does not enumerate root/nobody (no duplication with files)', async () => {
    const r = await getent(pc, '-s systemd passwd');
    expect(r.output).not.toMatch(/^root:/m);
    expect(r.output).not.toMatch(/^nobody:/m);
  });

  it('keeps getent passwd root single (systemd adds no duplicate)', async () => {
    const r = await getent(pc, 'passwd');
    const roots = r.output.split('\n').filter(l => l.startsWith('root:'));
    expect(roots.length).toBe(1);
  });

  it('synthesises the root and nobody groups', async () => {
    expect((await getent(pc, '-s systemd group root')).output).toMatch(/^root:x:0:/);
    expect((await getent(pc, '-s systemd group nobody')).output).toMatch(/^nobody:x:65534:/);
  });

  it('returns a locked shadow entry for nobody via systemd', async () => {
    const r = await getent(pc, '-s systemd shadow nobody');
    expect(r.output).toMatch(/^nobody:\*:/);
  });
});

describe('nss-systemd — DynamicUser=', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = makeRootPc(); });

  async function installDynUnit(name: string): Promise<void> {
    await pc.executeCommand('mkdir -p /etc/systemd/system');
    await pc.executeCommand(`echo "[Service]" > /etc/systemd/system/${name}.service`);
    await pc.executeCommand(`echo "DynamicUser=yes" >> /etc/systemd/system/${name}.service`);
    await pc.executeCommand(`echo "ExecStart=/bin/sleep 999" >> /etc/systemd/system/${name}.service`);
    await pc.executeCommand('systemctl daemon-reload');
  }

  it('resolves a transient user while a DynamicUser= service runs', async () => {
    await installDynUnit('widget');
    await pc.executeCommand('systemctl start widget');

    const r = await getent(pc, 'passwd widget');
    expect(r.exitCode).toBe(0);
    const m = /^widget:x:(\d+):(\d+):Dynamic User:\/:\/usr\/sbin\/nologin$/.exec(r.output);
    expect(m).not.toBeNull();
    const uid = Number(m![1]);
    expect(uid).toBeGreaterThanOrEqual(61184);
    expect(uid).toBeLessThanOrEqual(65519);
    expect(Number(m![2])).toBe(uid);

    const byId = await getent(pc, `passwd ${uid}`);
    expect(byId.output).toMatch(/^widget:/);
  });

  it('releases the transient user when the service stops', async () => {
    await installDynUnit('gadget');
    await pc.executeCommand('systemctl start gadget');
    expect((await getent(pc, 'passwd gadget')).exitCode).toBe(0);

    await pc.executeCommand('systemctl stop gadget');
    expect((await getent(pc, 'passwd gadget')).exitCode).toBe(2);
  });
});
