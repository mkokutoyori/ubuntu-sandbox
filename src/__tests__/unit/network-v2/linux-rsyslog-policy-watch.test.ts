/*
 * Probe - policyWatch on a simulated Linux host.  rswatch.c registers an inotify watch on the DIRECTORY of the policy file with the
 * mask IN_CLOSE_WRITE | IN_MOVED_TO | IN_ATTRIB | IN_CREATE, keeps the events whose name is the policy file's basename and, after
 * the debounce, reloads the policy.  The VFS signals the same four things to the directory's watchers (onDirectoryEvent): a write
 * (close-write), a rename into the directory (moved-to), the creation of a name by open, mkdir, symlink, link or mkfifo (create)
 * and a change of attributes - chmod, chown, chgrp, touch, setfacl, chattr (attrib) - reported under the name the path resolved to,
 * so the policy reloads when `chown`, `touch` or `ln` touch it, and does NOT reload when only a name elsewhere points to it.
 * When the policy path is itself a symbolic link, inotify watches the directory of the link, so a write that resolves to the target
 * in another directory raises nothing there and the policy is NOT reloaded, whichever name the writer used.
 * Measured before the change (git stash push -- src/network): 8 of the 14 cases fall - chown, chgrp, touch, setfacl, chattr, a hard
 * link and a symbolic link created at the policy name raised no event (the VFS offered writes, renames and chmod only), and a write
 * through the symbolic link reloaded the policy because the old subscription was keyed by the lexical path.  The 6 that pass either
 * way are the WITNESS (a rewrite reloads), non-regressions (a rename over the policy, a chmod) and structural cases (a change to
 * another file of the directory, a hard link made elsewhere, a write to the target of the symbolic link by its own name).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const POLICY = '/etc/rl.yaml';
const CONFIG = 'module(load="imudp")\nratelimit(name="r" policy="/etc/rl.yaml" policyWatch="on")\ninput(type="imudp" port="514" ratelimit.name="r")\n';

async function lab(linkedTo: string | null = null): Promise<LinuxServer> {
  const host = new LinuxServer('linux-server', 'host1', 0, 0);
  host.powerOn();
  if (linkedTo === null) await host.executeCommand(`printf 'interval: 5\\nburst: 10\\n' > ${POLICY}`);
  else {
    await host.executeCommand(`mkdir -p /data && printf 'interval: 5\\nburst: 10\\n' > ${linkedTo}`);
    await host.executeCommand(`ln -s ${linkedTo} ${POLICY}`);
  }
  await host.executeCommand(`printf '${CONFIG.replace(/\n/g, '\\n').replace(/'/g, "'\\''")}' > /etc/rsyslog.d/40-test.conf`);
  await host.executeCommand('systemctl restart rsyslog');
  return host;
}

async function reloads(host: LinuxServer): Promise<number> {
  host.advanceTime(5_000);
  const text = await host.executeCommand('grep -c "reloaded policy" /var/log/syslog');
  return Number.parseInt(text, 10) || 0;
}

describe('policyWatch reload events (rswatch.c inotify mask)', () => {
  it('witness: the lab reloads the policy when the file is rewritten', async () => {
    const host = await lab();
    expect(await reloads(host)).toBe(0);
    await host.executeCommand(`printf 'interval: 5\\nburst: 20\\n' > ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('a rename over the policy reloads it', async () => {
    const host = await lab();
    await host.executeCommand(`printf 'interval: 5\\nburst: 30\\n' > /etc/rl.new`);
    await host.executeCommand(`mv /etc/rl.new ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('chmod reloads it', async () => {
    const host = await lab();
    await host.executeCommand(`chmod 600 ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('chown reloads it', async () => {
    const host = await lab();
    await host.executeCommand(`chown daemon ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('chgrp reloads it', async () => {
    const host = await lab();
    await host.executeCommand(`chgrp daemon ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('touch without a write reloads it', async () => {
    const host = await lab();
    await host.executeCommand(`touch ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('setfacl reloads it', async () => {
    const host = await lab();
    await host.executeCommand(`setfacl -m u:daemon:r ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('chattr reloads it', async () => {
    const host = await lab();
    await host.executeCommand(`chattr +i ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('a hard link created AT the policy name reloads it after the file is replaced by the link', async () => {
    const host = await lab();
    await host.executeCommand('printf "interval: 5\\nburst: 40\\n" > /etc/rl.other');
    await host.executeCommand(`rm ${POLICY}`);
    await host.executeCommand(`ln /etc/rl.other ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('a symbolic link created at the policy name reloads it', async () => {
    const host = await lab();
    await host.executeCommand('printf "interval: 5\\nburst: 50\\n" > /etc/rl.other');
    await host.executeCommand(`rm ${POLICY}`);
    await host.executeCommand(`ln -s /etc/rl.other ${POLICY}`);
    expect(await reloads(host)).toBe(1);
  });

  it('a change to another file of the directory does not reload it', async () => {
    const host = await lab();
    await host.executeCommand('printf "x" > /etc/unrelated.yaml');
    await host.executeCommand('chown daemon /etc/unrelated.yaml');
    await host.executeCommand('touch /etc/unrelated.yaml');
    expect(await reloads(host)).toBe(0);
  });

  it('a hard link made elsewhere to the policy file does not reload it (the directory sees no event)', async () => {
    const host = await lab();
    await host.executeCommand(`ln ${POLICY} /var/tmp/rl.copy`);
    expect(await reloads(host)).toBe(0);
  });

  it('a write through a symbolic link at the policy path does not reload it', async () => {
    const host = await lab('/data/real.yaml');
    await host.executeCommand(`printf 'interval: 5\\nburst: 20\\n' > ${POLICY}`);
    expect(await reloads(host)).toBe(0);
  });

  it('a write to the target of the symbolic link by its own name does not reload it either', async () => {
    const host = await lab('/data/real.yaml');
    await host.executeCommand("printf 'interval: 5\\nburst: 20\\n' > /data/real.yaml");
    expect(await reloads(host)).toBe(0);
  });
});
