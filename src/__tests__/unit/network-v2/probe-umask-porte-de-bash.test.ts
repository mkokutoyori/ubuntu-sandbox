/**
 * umask as bash 5.2.21 implements it (builtins/umask.def, builtins/common.c) and what the creation commands do with it, measured in a fresh
 * network and pid namespace (the corpus umask-bash-5.2.json, 5 labs and 232 steps, is replayed by netcmds-oracle.test.ts; these cases pin the
 * rules that corpus cannot name):
 *
 *   umask, -S, -p, -pS             0022 | u=rwx,g=rx,o=rx | umask 0022 | umask -S u=rwx,g=rx,o=rx ; -S with a mode prints the NEW mask
 *   umask 7777 / 1000              accepted (read_octal stops at 07777, the kernel keeps the low nine bits) ; 0778 and 8 are out of range, rc 1
 *   umask abc / u=q / u=rwxs       "`b': invalid symbolic mode operator" / "`q': invalid symbolic mode character", rc 1, the mask is unchanged
 *   umask -x                       "-x: invalid option" and the usage line, rc 2 ; extra operands are ignored
 *   ( umask 077 ) / | cat / $( )   a subshell, a pipeline stage and a command substitution never change the parent ; a { } group does
 *   bash -c 'umask 077'            a child shell does not leak into the caller, and sudo runs its command under 0022 whatever the caller had
 *   touch, mkdir, > f, mkfifo      0666 / 0777 filtered by the mask ; mkdir -p makes the intermediate directories u+wx ; mkdir -m ignores the mask
 *   cp                             new file = source mode & ~mask (never 0666) ; -p / -a keep the exact mode
 *   install, mktemp                install defaults to 0755 and mktemp to 0600 / 0700 whatever the mask
 *   nc -lU                         the socket file is 0777 & ~mask
 *   exec 5> f                      opens f and the script goes on (it used to redirect the shell's own stdout and swallow the rest)
 *   ls -ld b a c                   operands are sorted, files first
 *   dd of=f 2>/dev/null            the "records in / out" report is on stderr
 *
 * Measured with the sources at HEAD: 14 of the 16 cases fall. The two that pass either way are the WITNESSES: the plain `umask`/`umask 077`
 * round trip (the lab is sound) and the group `{ umask 077; }` that must keep persisting (non-regression of the isolation).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

async function root(line: string): Promise<string> {
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  const text = await machine.executor.runAsUser('root', () => pc.executeCommand(line));
  return text.replace(/^\[\d+\] \d+\n?/gm, '').replace(/\n$/, '');
}

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await root('mkdir -p /tmp/lab; cd /tmp/lab; umask 022');
});

describe('umask', () => {
  it('WITNESS: the octal round trip', async () => {
    expect(await root('umask 077; umask')).toBe('0077');
  });

  it('prints in the four forms and -S with a mode prints the new mask', async () => {
    expect(await root('umask -S')).toBe('u=rwx,g=rx,o=rx');
    expect(await root('umask -p')).toBe('umask 0022');
    expect(await root('umask -pS')).toBe('umask -S u=rwx,g=rx,o=rx');
    expect(await root('umask -S 077; umask')).toBe('u=rwx,g=,o=\n0077');
  });

  it('accepts a mode up to 07777 and refuses what is not octal', async () => {
    expect(await root('umask 7777; echo rc=$?; umask')).toBe('rc=0\n0777');
    expect(await root('umask 022; umask 0778; echo rc=$?; umask')).toContain('umask: 0778: octal number out of range\nrc=1\n0022');
    expect(await root('umask 8; echo rc=$?')).toContain('umask: 8: octal number out of range\nrc=1');
  });

  it('builds the mask from a symbolic mode like chmod does', async () => {
    expect(await root('umask u=rwx,g=rx,o=; umask')).toBe('0027');
    expect(await root('umask 022; umask g+w; umask')).toBe('0002');
    expect(await root('umask 022; umask go-rx; umask')).toBe('0077');
    expect(await root('umask 022; umask +w; umask -S')).toBe('u=rwx,g=rwx,o=rwx');
  });

  it('names the offending character of a bad symbolic mode', async () => {
    expect(await root('umask abc; echo rc=$?')).toContain("umask: `b': invalid symbolic mode operator\nrc=1");
    expect(await root('umask u=q; echo rc=$?')).toContain("umask: `q': invalid symbolic mode character\nrc=1");
    expect(await root('umask 022; umask u=rwxs; umask')).toContain('0022');
  });

  it('refuses an unknown option with the usage line and rc 2', async () => {
    expect(await root('umask -x; echo rc=$?')).toContain('umask: -x: invalid option\numask: usage: umask [-p] [-S] [mode]\nrc=2');
    expect(await root('umask 022 033; echo rc=$?; umask')).toBe('rc=0\n0022');
  });

  it('is private to a subshell, a pipeline stage and a command substitution', async () => {
    expect(await root('(umask 077; umask); umask')).toBe('0077\n0022');
    expect(await root('umask 077 | cat; umask')).toBe('0022');
    expect(await root('echo $(umask 077; umask); umask')).toBe('0077\n0022');
  });

  it('WITNESS: a brace group changes the shell it runs in', async () => {
    expect(await root('{ umask 077; }; umask')).toBe('0077');
  });

  it('stays in the child shell of bash -c and is reset by sudo', async () => {
    expect(await root('umask 077; bash -c "umask 027; umask"; umask')).toBe('0027\n0077');
    expect(await root('umask 077; sudo bash -c umask')).toBe('0022');
  });

  it('filters the modes of touch, mkdir, redirection and mkfifo', async () => {
    await root('umask 027; touch f1; mkdir d1; echo x > r1; mkfifo p1');
    expect(await root('ls -ld f1 d1 r1 p1 | cut -c1-10')).toBe('drwxr-x---\n-rw-r-----\nprw-r-----\n-rw-r-----');
  });

  it('creates intermediate directories u+wx and lets mkdir -m ignore the mask', async () => {
    await root('umask 0277; mkdir -p ra/rb; umask 077; mkdir -m 755 m1; mkdir -m +w m2');
    expect(await root('ls -ld ra m1 m2 | cut -c1-10')).toBe('drwxr-xr-x\ndrwxrwxrwx\ndrwx------');
  });

  it('copies with the source mode filtered by the mask, or exactly with -p', async () => {
    await root('umask 022; touch exe; chmod 755 exe; umask 077; cp exe plain; cp -p exe kept; umask 000; cp /etc/hostname open');
    expect(await root('ls -l plain kept open | cut -c1-10')).toBe('-rwxr-xr-x\n-rw-r--r--\n-rwx------');
  });

  it('gives install 0755 and mktemp 0600 or 0700 whatever the mask is', async () => {
    await root('umask 077; install /etc/hostname inst; mktemp > fname; mktemp -d > dname');
    expect(await root('ls -l inst | cut -c1-10')).toBe('-rwxr-xr-x');
    expect(await root('ls -ld $(cat fname) | cut -c1-10')).toBe('-rw-------');
    expect(await root('ls -ld $(cat dname) | cut -c1-10')).toBe('drwx------');
  });

  it('applies the mask to the socket file of nc -lU', async () => {
    await root('umask 027; nc -lU /tmp/lab/s1 & sleep 0.3');
    expect(await root('ls -ld /tmp/lab/s1 | cut -c1-10')).toBe('srwxr-x---');
  });

  it('opens the descriptor of exec 5> f and keeps going', async () => {
    expect(await root('exec 5> opened; echo still-here; ls opened')).toBe('still-here\nopened');
  });

  it('sorts the operands of ls and keeps the dd report on stderr', async () => {
    await root('touch b; mkdir a; touch c');
    expect(await root('ls -1d c b a')).toBe('a\nb\nc');
    expect(await root('dd if=/dev/null of=out 2>/dev/null; echo end')).toBe('end');
  });
});
