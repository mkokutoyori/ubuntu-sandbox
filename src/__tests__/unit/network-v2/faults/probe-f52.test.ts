import { describe, it, beforeEach } from 'vitest';
import { writeFileSync } from 'fs';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
const L: string[] = [];
const log = (...a: unknown[]) => L.push(a.map(String).join(' '));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

describe('probe F5.2', () => {
  it('dump', async () => {
    const pc = new LinuxServer('linux-server', 'SRV'); pc.powerOn();
    log('/run:', await pc.executeCommand('ls -la /run'));
    log('/var/run:', await pc.executeCommand('ls -la /var/run'));
    log('unit ssh:', await pc.executeCommand('cat /usr/lib/systemd/system/ssh.service'));
    log('ss -ltn:', await pc.executeCommand('ss -ltn'));
    const ps = await pc.executeCommand('ps aux');
    const pid = ps.split('\n').find(l => l.includes('/usr/sbin/sshd'))!.trim().split(/\s+/)[1];
    log('pid', pid);
    log('kill -9:', await pc.executeCommand(`kill -9 ${pid}`));
    log('is-active immédiat:', await pc.executeCommand('systemctl is-active ssh'));
    log('ss juste après:', await pc.executeCommand('ss -ltn'));
    await wait(400);
    log('is-active après RestartSec:', await pc.executeCommand('systemctl is-active ssh'));
    log('ss après:', await pc.executeCommand('ss -ltn'));
    log('/run après:', await pc.executeCommand('ls -la /run'));
    writeFileSync('/tmp/claude-0/-home-user-ubuntu-sandbox/e90541ae-9893-590d-a0e6-cbe80fba9548/scratchpad/probe52.out', L.join('\n'));
  });
});
