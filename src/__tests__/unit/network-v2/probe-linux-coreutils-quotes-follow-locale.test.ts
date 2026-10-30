/*
 * GNU coreutils quote a file or an argument in a diagnostic with the quotation marks
 * of the locale: ‘x’ in a UTF-8 locale, 'x' in the C locale (LC_ALL, then LC_CTYPE,
 * then LANG decide). The coreutils modules wrote the curly pair whatever the
 * environment said, so `LC_ALL=C chmod 999 f` answered ‘999’ where the real command
 * answers '999', and the recorded Ubuntu transcripts (taken with no locale at all)
 * could not be replayed without a rewrite of their expectations. The kit now reads the
 * locale of the machine before each command.
 *
 * Measured at the commit before: of the 6 cases, 3 fall (every case that asks for the C
 * locale through LANG, LC_CTYPE or LC_ALL); the 3 that pass either way are the
 * witnesses: the default en_US.UTF-8 identity, an explicit UTF-8 LANG and the getopt
 * diagnostics, which glibc writes with plain quotes in every locale.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('coreutils quotation marks follow the locale', () => {
  it('the default en_US.UTF-8 identity quotes with the curly pair', async () => {
    expect(await pc().executeCommand('cp /etc/hostname 2>&1')).toContain('after ‘/etc/hostname’');
  });
  it('an explicit UTF-8 LANG keeps the curly pair', async () => {
    const machine = pc();
    await machine.executeCommand('export LANG=C.UTF-8');
    expect(await machine.executeCommand('cp /etc/hostname 2>&1')).toContain('after ‘/etc/hostname’');
  });
  it('LANG=C gives plain quotes', async () => {
    const machine = pc();
    await machine.executeCommand('export LANG=C');
    expect(await machine.executeCommand('cp /etc/hostname 2>&1')).toContain("after '/etc/hostname'");
  });
  it('LC_CTYPE outranks LANG', async () => {
    const machine = pc();
    await machine.executeCommand('export LC_CTYPE=POSIX');
    expect(await machine.executeCommand('mkdir -m 999 /tmp/q 2>&1')).toBe("mkdir: invalid mode '999'");
  });
  it('LC_ALL outranks LC_CTYPE and LANG', async () => {
    const machine = pc();
    await machine.executeCommand('export LC_CTYPE=en_US.UTF-8');
    await machine.executeCommand('export LC_ALL=C');
    expect(await machine.executeCommand('mkdir -m 999 /tmp/q 2>&1')).toBe("mkdir: invalid mode '999'");
  });
  it('getopt diagnostics keep plain quotes in every locale', async () => {
    expect(await pc().executeCommand('cp --bogus x y 2>&1')).toContain("unrecognized option '--bogus'");
  });
});
