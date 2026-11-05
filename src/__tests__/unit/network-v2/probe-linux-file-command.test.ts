/*
 * file looked at three options. It now follows file(1) 5.4x: the shared getopt reader with the real option table (-b -i -L -h -N -0 -E -s -e -F -f -m -P --mime-type
 * --mime-encoding --extension --apple --help --version), standard input as '-' (named /dev/stdin, 'application/x-empty' when empty), names read
 * with -f (NUL-terminated lines, '-' for stdin), the padding of the name column computed from the longest argument, -N, -F, -0, broken and
 * followed symbolic links, '-E' (ERROR: cannot stat), the 'with no line terminators' / 'CRLF' / 'very long lines' attributes, the script table keyed
 * by interpreter (POSIX shell, Bourne-Again, Python, Perl, ...) with its MIME types, the excluded tests (ascii/text give data, soft), and the
 * -P parameter names. The classification of the content stays the simulator's own (archives, pcap, data, ASCII text).
 *
 * Every expected string was produced by the real file 5.45 of the dev container; rows of the magic database that this container ships reduced
 * (PNG, gzip, ELF... all answer 'data' there) are not pinned. -c -C -l -d (parsed magic listings, debug trace) are refused with the usage and
 * recorded in TODO.md.
 *
 * Measured against the commit before (worktree): 72 of 109 cases fall. The 37 that pass either way are the descriptions and options that were already right
 * (plain files, directories, -b, -i on regular files, the usage on a missing operand) and double as witnesses of the lab.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/line 1: /g, '').replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["file a.txt", "a.txt: ASCII text\n[0]"],
  ["file -b a.txt", "ASCII text\n[0]"],
  ["file -i a.txt", "a.txt: text/plain; charset=us-ascii\n[0]"],
  ["file sub", "sub: directory\n[0]"],
  ["file nosuch", "nosuch: cannot open `nosuch' (No such file or directory)\n[0]"],
  ["file -x", "file: invalid option -- 'x'\nUsage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n[1]"],
  ["file", "Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n[1]"],
  ["file lnk", "lnk: symbolic link to a.txt\n[0]"],
  ["file -L lnk", "lnk: ASCII text\n[0]"],
  ["file -h lnk", "lnk: symbolic link to a.txt\n[0]"],
  ["file big", "big: ASCII text, with very long lines (3000), with no line terminators\n[0]"],
  ["file --mime-type a.txt", "a.txt: text/plain\n[0]"],
  ["file -z a.txt", "a.txt: ASCII text\n[0]"],
  ["file -s a.txt", "a.txt: ASCII text\n[0]"],
  ["file --help", "Usage: file [OPTION...] [FILE...]\nDetermine type of FILEs.\n\n      --help                 display this help and exit\n  -v, --version              output version information and exit\n  -m, --magic-file LIST      use LIST as a colon-separated list of magic\n                               number files\n  -z, --uncompress           try to look inside compressed files\n  -Z, --uncompress-noreport  only print the contents of compressed files\n  -b, --brief                do not prepend filenames to output lines\n  -c, --checking-printout    print the parsed form of the magic file, use in\n                               conjunction with -m to debug a new magic file\n                               before installing it\n  -e, --exclude TEST         exclude TEST from the list of test to be\n                               performed for file. Valid tests are:\n                               apptype, ascii, cdf, compress, csv, elf,\n                               encoding, soft, tar, json, simh,\n                               text, tokens\n      --exclude-quiet TEST   like exclude, but ignore unknown tests\n  -f, --files-from FILE      read the filenames to be examined from FILE\n  -F, --separator STRING     use string as separator instead of `:'\n  -i, --mime                 output MIME type strings (--mime-type and\n                               --mime-encoding)\n      --apple                output the Apple CREATOR/TYPE\n      --extension            output a slash-separated list of extensions\n      --mime-type            output the MIME type\n      --mime-encoding        output the MIME encoding\n  -k, --keep-going           don't stop at the first match\n  -l, --list                 list magic strength\n  -L, --dereference          follow symlinks (default if POSIXLY_CORRECT is set)\n  -h, --no-dereference       don't follow symlinks (default if POSIXLY_CORRECT is not set) (default)\n  -n, --no-buffer            do not buffer output\n  -N, --no-pad               do not pad output\n  -0, --print0               terminate filenames with ASCII NUL\n  -p, --preserve-date        preserve access times on files\n  -P, --parameter            set file engine parameter limits\n                                   bytes 7340032 max bytes to look inside file\n                               elf_notes     256 max ELF notes processed\n                               elf_phnum    2048 max ELF prog sections processed\n                               elf_shnum   32768 max ELF sections processed\n                               elf_shsize 134217728 max ELF section size\n                                encoding   65536 max bytes to scan for encoding\n                                   indir      50 recursion limit for indirection\n                                    name      50 use limit for name/use magic\n                                   regex    8192 length limit for REGEX searches\n  -r, --raw                  don't translate unprintable chars to \\ooo\n  -s, --special-files        treat special (block/char devices) files as\n                             ordinary ones\n  -S, --no-sandbox           disable system call sandboxing\n  -C, --compile              compile file specified by -m\n  -d, --debug                print debugging messages\n\nReport bugs to https://bugs.astron.com/\n[0]"],
  ["file -b --mime-type a.txt", "text/plain\n[0]"],
  ["file -b --mime-encoding a.txt", "us-ascii\n[0]"],
  ["file -N a.txt", "a.txt: ASCII text\n[0]"],
  ["file -F @ a.txt", "a.txt@ ASCII text\n[0]"],
  ["file a.txt words", "a.txt: ASCII text\nwords: ASCII text\n[0]"],
  ["file -0 a.txt | od -c | head -2", "0000000   a   .   t   x   t  \\0   :       A   S   C   I   I       t   e\n0000020   x   t  \\n\n[0]"],
  ["file dang", "dang: broken symbolic link to nowhere\n[0]"],
  ["file -L dang", "dang: cannot open `dang' (No such file or directory)\n[0]"],
  ["file lnk2", "lnk2: broken symbolic link to lnk2\n[0]"],
  ["file /dev/null", "/dev/null: character special (1/3)\n[0]"],
  ["file -s /dev/null", "/dev/null: empty\n[0]"],
  ["file words nums", "words: ASCII text\nnums:  ASCII text\n[0]"],
  ["file -f list0", "a.txt: ASCII text\n[0]"],
  ["file z", "z: data\n[0]"],
  ["file -k a.txt", "a.txt: ASCII text\n[0]"],
  ["file -p a.txt", "a.txt: ASCII text\n[0]"],
  ["file -r a.txt", "a.txt: ASCII text\n[0]"],
  ["file -n a.txt", "a.txt: ASCII text\n[0]"],
  ["file -E nosuch; echo $?", "nosuch: ERROR: cannot stat `nosuch' (No such file or directory)\n1\n[0]"],
  ["file nosuch; echo $?", "nosuch: cannot open `nosuch' (No such file or directory)\n0\n[0]"],
  ["file --nosuch", "file: unrecognized option '--nosuch'\nUsage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n[1]"],
  ["file -e ascii a.txt", "a.txt: data\n[0]"],
  ["file -m /nosuch a.txt", "file: could not find any valid magic files! (No such file or directory)\n[1]"],
  ["file -", "/dev/stdin: empty\n[0]"],
  ["echo hi | file -", "/dev/stdin: ASCII text\n[0]"],
  ["echo hi | file -b -", "ASCII text\n[0]"],
  ["printf '' | file -", "/dev/stdin: empty\n[0]"],
  ["printf 'a\\0b' | file -", "/dev/stdin: data\n[0]"],
  ["printf 'a\\r\\nb\\r\\n' | file -", "/dev/stdin: ASCII text, with CRLF line terminators\n[0]"],
  ["printf 'a\\nb' | file -", "/dev/stdin: ASCII text\n[0]"],
  ["printf 'x%.0s' $(seq 1 200) | file -", "/dev/stdin: ASCII text, with no line terminators\n[0]"],
  ["printf '#!/bin/sh\\necho\\n' | file -", "/dev/stdin: POSIX shell script, ASCII text executable\n[0]"],
  ["file -i -", "/dev/stdin: application/x-empty; charset=binary\n[0]"],
  ["echo hi | file -i -", "/dev/stdin: text/plain; charset=us-ascii\n[0]"],
  ["file -i sub lnk dang a.txt", "sub:   inode/directory; charset=binary\nlnk:   inode/symlink; charset=binary\ndang:  inode/symlink\na.txt: text/plain; charset=us-ascii\n[0]"],
  ["file -i dang", "dang: inode/symlink\n[0]"],
  ["file --mime-encoding a.txt sub lnk", "a.txt: us-ascii\nsub:   binary\nlnk:   binary\n[0]"],
  ["file --mime-type a.txt sub lnk", "a.txt: text/plain\nsub:   inode/directory\nlnk:   inode/symlink\n[0]"],
  ["file -N a.txt sub", "a.txt: ASCII text\nsub: directory\n[0]"],
  ["file -i a.txt sub", "a.txt: text/plain; charset=us-ascii\nsub:   inode/directory; charset=binary\n[0]"],
  ["file -F:: a.txt", "a.txt:: ASCII text\n[0]"],
  ["file -F '' a.txt", "a.txt ASCII text\n[0]"],
  ["file -Fx a.txt sub", "a.txtx ASCII text\nsubx   directory\n[0]"],
  ["file -0 -N a.txt | od -c | head -1", "0000000   a   .   t   x   t  \\0   :       A   S   C   I   I       t   e\n[0]"],
  ["file -b0 a.txt | od -c | head -1", "0000000   A   S   C   I   I       t   e   x   t  \\n\n[0]"],
  ["file -P bytes=10 a.txt", "a.txt: ASCII text\n[0]"],
  ["file -P nosuch=1 a.txt", "file: Unknown param nosuch=1\n[1]"],
  ["file -P bytes a.txt", "file: Unknown param bytes\n[1]"],
  ["file -e nosuch a.txt", "Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n[1]"],
  ["file --exclude-quiet nosuch a.txt", "a.txt: ASCII text\n[0]"],
  ["file -e ascii -e soft a.txt", "a.txt: data\n[0]"],
  ["file -e soft a.txt", "a.txt: ASCII text\n[0]"],
  ["file -e text a.txt", "a.txt: data\n[0]"],
  ["file --exclude=ascii a.txt", "a.txt: data\n[0]"],
  ["file -e", "file: option requires an argument -- 'e'\nUsage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n[1]"],
  ["file -m", "file: option requires an argument -- 'm'\nUsage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n[1]"],
  ["file -f nosuch", "file: Cannot open `nosuch' (No such file or directory)\n[1]"],
  ["file -E a.txt", "a.txt: ASCII text\n[0]"],
  ["file -L -i lnk", "lnk: text/plain; charset=us-ascii\n[0]"],
  ["file -Li dang", "dang: cannot open `dang' (No such file or directory)\n[0]"],
  ["file --extension a.txt", "a.txt: ???\n[0]"],
  ["file --apple a.txt", "a.txt: UNKNUNKN\n[0]"],
  ["file -Lh lnk", "lnk: symbolic link to a.txt\n[0]"],
  ["file -hL lnk", "lnk: ASCII text\n[0]"],
  ["file -S a.txt", "a.txt: ASCII text\n[0]"],
  ["file -Z a.txt", "a.txt: ASCII text\n[0]"],
  ["file --dereference lnk", "lnk: ASCII text\n[0]"],
  ["file --no-pad a.txt sub", "a.txt: ASCII text\nsub: directory\n[0]"],
  ["file --print0 a.txt | od -c | head -1", "0000000   a   .   t   x   t  \\0   :       A   S   C   I   I       t   e\n[0]"],
  ["file --separator=@ a.txt", "a.txt@ ASCII text\n[0]"],
  ["file --files-from=list0", "a.txt: ASCII text\n[0]"],
  ["file -i --mime-type a.txt", "a.txt: text/plain; charset=us-ascii\n[0]"],
  ["file --mime-type --mime-encoding a.txt", "a.txt: text/plain; charset=us-ascii\n[0]"],
  ["file --mime --mime-type a.txt", "a.txt: text/plain; charset=us-ascii\n[0]"],
  ["file --mime-type --mime a.txt", "a.txt: text/plain; charset=us-ascii\n[0]"],
  ["file -k a.txt", "a.txt: ASCII text\n[0]"],
  ["file --keep-going --brief a.txt", "ASCII text\n[0]"],
  ["file a.txt -", "a.txt: ASCII text\n/dev/stdin:     empty\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/bin/sh' > s.sh; file s.sh; file -i s.sh", "s.sh: POSIX shell script, ASCII text executable\ns.sh: text/x-shellscript; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/bin/bash' > s.sh; file s.sh; file -i s.sh", "s.sh: Bourne-Again shell script, ASCII text executable\ns.sh: text/x-shellscript; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/usr/bin/env bash' > s.sh; file s.sh; file -i s.sh", "s.sh: Bourne-Again shell script, ASCII text executable\ns.sh: text/x-shellscript; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/usr/bin/python3' > s.sh; file s.sh; file -i s.sh", "s.sh: Python script, ASCII text executable\ns.sh: text/x-script.python; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/usr/bin/env python3' > s.sh; file s.sh; file -i s.sh", "s.sh: Python script, ASCII text executable\ns.sh: text/x-script.python; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/usr/bin/perl' > s.sh; file s.sh; file -i s.sh", "s.sh: Perl script text executable\ns.sh: text/x-perl; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/bin/dash' > s.sh; file s.sh; file -i s.sh", "s.sh: a /bin/dash script, ASCII text executable\ns.sh: text/plain; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/bin/zsh' > s.sh; file s.sh; file -i s.sh", "s.sh: Paul Falstad's zsh script, ASCII text executable\ns.sh: text/x-shellscript; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/usr/bin/awk -f' > s.sh; file s.sh; file -i s.sh", "s.sh: awk script, ASCII text executable\ns.sh: text/x-awk; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/bin/ksh' > s.sh; file s.sh; file -i s.sh", "s.sh: Korn shell script, ASCII text executable\ns.sh: text/x-shellscript; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/usr/bin/ruby' > s.sh; file s.sh; file -i s.sh", "s.sh: Ruby script, ASCII text executable\ns.sh: text/x-ruby; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/usr/bin/env node' > s.sh; file s.sh; file -i s.sh", "s.sh: Node.js script executable, ASCII text\ns.sh: application/javascript; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#! /bin/sh' > s.sh; file s.sh; file -i s.sh", "s.sh: POSIX shell script, ASCII text executable\ns.sh: text/x-shellscript; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/bin/csh' > s.sh; file s.sh; file -i s.sh", "s.sh: C shell script, ASCII text executable\ns.sh: text/x-shellscript; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/usr/bin/tclsh' > s.sh; file s.sh; file -i s.sh", "s.sh: Tcl/Tk script, ASCII text executable\ns.sh: text/x-tcl; charset=us-ascii\n[0]"],
  ["printf '%s\\necho hi\\n' '#!/foo/bar' > s.sh; file s.sh; file -i s.sh", "s.sh: a /foo/bar script, ASCII text executable\ns.sh: text/plain; charset=us-ascii\n[0]"],
];

describe('file against the real file', () => {
  it.each(CASES)('%s', async (line, expected) => {
    const machine = await lab();
    const asRoot = (text: string): Promise<string> => machine.executor.runAsUser('root', () => machine.executeCommand(text));
    const root = line.startsWith('ROOT:');
    const command = line.replace(/^ROOT:/, '');
    await asRoot('cd /tmp/ff; chmod -R u+rwx /tmp/ff; rm -rf /tmp/ff/*');
    if (root) await asRoot(`cd /tmp/ff; ${SETUP}`); else await machine.executeCommand(`cd /tmp/ff; ${SETUP}`);
    const script = `cd /tmp/ff; ${command} 2>&1; echo "[$?]"`;
    const answer = root ? await asRoot(script) : await machine.executeCommand(script);
    expect(normalise(answer)).toBe(expected);
  });
});
