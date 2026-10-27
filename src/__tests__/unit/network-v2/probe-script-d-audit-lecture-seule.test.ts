/**
 * Un script d'audit lecture seule (exec > >(tee "$REPORT") 2>&1, df -hT, find -perm -0002, droits d'execution du script).
 * Mesure avant le correctif (git stash) : 5 des 7 cas tombent ; les deux qui passent des deux cotes sont
 * des temoins : le refus « Permission denied » d'un script sans le bit x, et le libelle de `[` deja porte par le commit precedent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

const SCRIPT = [
  '#!/usr/bin/env bash',
  'set -u',
  'REPORT="report_${HOSTNAME:-x}.txt"',
  'exec > >(tee "$REPORT") 2>&1',
  'echo "first line"',
  'echo "to stderr" >&2',
  'printf "last line\\n"',
].join('\n');

describe('read-only audit script', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    pc.powerOn();
    await pc.executeCommand(`cd /tmp; cat > audit.sh <<'EOF_AUDIT'\n${SCRIPT}\nEOF_AUDIT`);
  });

  it('refuses to execute a script without the x bit (witness)', async () => {
    expect(await pc.executeCommand('cd /tmp; ./audit.sh')).toBe('bash: ./audit.sh: Permission denied');
  });

  it('runs once chmod +x is applied and still shows the output on the terminal', async () => {
    await pc.executeCommand('cd /tmp; chmod +x audit.sh');
    expect(await pc.executeCommand('cd /tmp; ./audit.sh')).toBe('first line\nto stderr\nlast line');
  });

  it('writes the same text, stderr included and in order, to the report file', async () => {
    await pc.executeCommand('cd /tmp; chmod +x audit.sh; ./audit.sh > /dev/null');
    expect(await pc.executeCommand('cd /tmp; cat report_*.txt')).toBe('first line\nto stderr\nlast line');
  });

  it('can be run through bash without the x bit', async () => {
    expect(await pc.executeCommand('cd /tmp; bash audit.sh')).toBe('first line\nto stderr\nlast line');
  });

  it('df accepts a cluster of known short options', async () => {
    const out = await pc.executeCommand('df -hT');
    expect(out).not.toContain('invalid option');
    expect(out.split('\n')[0]).toMatch(/^Filesystem\s+Type\s+Size/);
    expect(await pc.executeCommand('df -hZ')).toContain("invalid option -- 'Z'");
  });

  it('find -perm distinguishes exact, all-bits and any-bit modes', async () => {
    await pc.executeCommand('cd /tmp; rm -rf fp; mkdir fp; cd fp; touch a b c; chmod 666 a; chmod 755 b; chmod 644 c');
    expect(await pc.executeCommand('cd /tmp/fp; find . -type f -perm 644')).toBe('./c');
    expect(await pc.executeCommand('cd /tmp/fp; find . -type f -perm -111')).toBe('./b');
    expect(await pc.executeCommand('cd /tmp/fp; find . -type f -perm -0002')).toBe('./a');
    expect(await pc.executeCommand('cd /tmp/fp; find . -type f -perm /022 | sort')).toBe('./a');
    expect(await pc.executeCommand('find /etc -perm 99')).toBe("find: Invalid mode '99'");
  });

  it('`test` reports errors with the script prefix and bash wording', async () => {
    await pc.executeCommand("cd /tmp; cat > t.sh <<'EOF_T'\n[ 1 -eq abc ]\necho rc=$?\nEOF_T");
    expect(await pc.executeCommand('cd /tmp; bash t.sh 2>&1')).toBe('t.sh: line 1: [: abc: integer expression expected\nrc=2');
  });
});
