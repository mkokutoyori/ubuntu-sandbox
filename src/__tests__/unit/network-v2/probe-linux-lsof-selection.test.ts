/*
 * lsof selection semantics measured on the real lsof 4.95.0: selectors of different kinds are ORed, -a
 * ANDs them, ^ excludes, -t prints each PID once, -F prints one field per line starting with the
 * process, a named file selects the rows that hold it, and an empty selection exits with status 1.
 * The listing itself comes from the simulated process table, so the witnesses are built in the same lab:
 * PID 1 (systemd, root, cwd /) must be selectable in every way it is selectable on the real machine.
 *
 * Measured against the commit before (worktree): 11 of 12 cases fall; the witness (the listing row of PID 1)
 * passes either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

const run = async (machine: Sh, line: string): Promise<string> => machine.executeCommand(`${line} 2>&1; echo "[$?]"`);

describe('lsof selection', () => {
  it('lists the cwd row of PID 1 (witness)', async () => {
    const out = await run(await lab(), 'lsof -p 1');
    expect(out).toContain('systemd');
    expect(out).toMatch(/\bcwd\b/);
  });

  it('-t prints the PID once', async () => {
    expect(await run(await lab(), 'lsof -p 1 -t')).toBe('1\n[0]');
  });

  it('an empty selection prints nothing and exits 1', async () => {
    expect(await run(await lab(), 'lsof -p 999999')).toBe('[1]');
  });

  it('selectors of different kinds are ORed', async () => {
    const out = await run(await lab(), 'lsof -p 1 -c nosuchcmdx -t');
    expect(out.split('\n')).toContain('1');
  });

  it('-a ANDs them: both match', async () => {
    expect(await run(await lab(), 'lsof -p 1 -c systemd -a -t')).toBe('1\n[0]');
  });

  it('-a ANDs them: one fails', async () => {
    expect(await run(await lab(), 'lsof -p 1 -c nosuchcmdx -a -t')).toBe('[1]');
  });

  it('^ excludes a user', async () => {
    expect(await run(await lab(), 'lsof -p 1 -u ^root -a -t')).toBe('[1]');
  });

  it('-d selects by descriptor name', async () => {
    expect(await run(await lab(), 'lsof -p 1 -d cwd -a -t')).toBe('1\n[0]');
    expect(await run(await lab(), 'lsof -p 1 -d 99 -a -t')).toBe('[1]');
  });

  it('-F prints the process then its fields', async () => {
    expect(await run(await lab(), 'lsof -F pcfn -p 1')).toBe('p1\ncsystemd\nfcwd\nn/\n[0]');
  });

  it('a named file selects the rows that hold it', async () => {
    const out = await run(await lab(), 'lsof -t /');
    expect(out.split('\n')).toContain('1');
  });

  it('options end at the first operand', async () => {
    expect(await run(await lab(), 'lsof /nonexistent -t')).toBe('lsof: status error on /nonexistent: No such file or directory\nlsof: status error on -t: No such file or directory\n[1]');
  });

  it('-u refuses a name that is both included and excluded', async () => {
    const out = await run(await lab(), 'lsof -u root,^root');
    expect(out).toContain('lsof: UID 0 has been included and excluded.');
    expect(out).toContain('[1]');
  });
});
