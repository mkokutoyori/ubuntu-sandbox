import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Vfs {
  writeFile(p: string, c: string, uid: number, gid: number, umask: number, append?: boolean): boolean;
  readFile(p: string): string | null;
  exists(p: string): boolean;
}
function vfsOf(pc: LinuxPC): Vfs {
  return (pc as unknown as { executor: { vfs: Vfs } }).executor.vfs;
}

let pc: LinuxPC;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
});

describe('cron deliverMail is real, via LinuxCommandExecutor.advanceTime()/ensureCronEngine() (§2.1.12, P18)', () => {
  it('a due job with unredirected output is delivered to /var/mail/<user>', async () => {
    await pc.executeCommand('echo "* * * * * echo executor-cron-output" | crontab -');
    pc.advanceTime(120_000);

    const mail = vfsOf(pc).readFile('/var/mail/user');
    expect(mail).toContain('executor-cron-output');
    expect(mail).toMatch(/^From cron@/m);
  });

  it('the mbox entry uses the real mbox From-line / trailing blank-line format', async () => {
    await pc.executeCommand('echo "* * * * * echo real-mbox-format" | crontab -');
    pc.advanceTime(120_000);

    const mail = vfsOf(pc).readFile('/var/mail/user')!;
    expect(mail.endsWith('\r\n\r\n') || mail.trimEnd().length > 0).toBe(true);
    expect(mail).toContain('real-mbox-format');
  });

  it('deliverMail() is no longer the strict no-op it was — output actually reaches the mailbox rather than vanishing', async () => {
    await pc.executeCommand('echo "* * * * * echo not-a-noop" | crontab -');
    const before = vfsOf(pc).readFile('/var/mail/user') ?? '';
    pc.advanceTime(120_000);
    const after = vfsOf(pc).readFile('/var/mail/user') ?? '';
    expect(after).not.toBe(before);
    expect(after).toContain('not-a-noop');
  });
});
