/*
 * dircolors answered `command not found`. DircolorsCommand.ts ports dircolors.c 9.4 (fetched from the v9.4
 * tag): the compiled default database (captured from the real `dircolors -p`), the TERM and COLORTERM
 * state machine with fnmatch, the keyword table (NORMAL..CLRTOEOL and the extension forms), the
 * Bourne/C-shell/--print-ls-colors outputs with the backslash/quote rules of append_quoted, SHELL
 * guessing, the diagnostics (missing second token, unrecognized keyword, mutually exclusive options).
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff), with TERM=xterm and SHELL=/bin/bash exported in every line.
 *
 * Measured against the commit before (worktree): 65 cases; the command did not exist, all of them fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -p | md5sum", "fd549b7faa1e9869d26014d6aff71109  -\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -p | head -n 5", "# Configuration file for dircolors, a utility to help you set the\n# LS_COLORS environment variable used by GNU ls with the --color option.\n# Copyright (C) 1996-2023 Free Software Foundation, Inc.\n# Copying and distribution of this file, with or without modification,\n# are permitted provided the copyright notice and this notice are preserved.\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -b | md5sum", "c0a74c326b5625e59b2bbfae2e528a3a  -\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -c | md5sum", "48fcb3ee59f09816033a80939d2b3ad7  -\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors | md5sum", "c0a74c326b5625e59b2bbfae2e528a3a  -\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors --print-ls-colors | md5sum", "12a36587a379a9b82b2a17c45f47ba37  -\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors --print-ls-colors | head -n 3 | od -c | head -n 3", "0000000 033   [   0   m   r   s  \\t   0 033   [   0   m  \\n 033   [   0\n0000020   1   ;   3   4   m   d   i  \\t   0   1   ;   3   4 033   [   0\n0000040   m  \\n 033   [   0   1   ;   3   6   m   l   n  \\t   0   1   ;\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -b | head -c 80", "LS_COLORS='rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35:do=01;35:bd=40;33;01:c[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -c | head -c 60", "setenv LS_COLORS 'rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=0[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; TERM=dumb dircolors -b | head -c 80", "LS_COLORS='';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; TERM=dumb dircolors -b | wc -c", "31\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; TERM= dircolors -b | wc -c", "31\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; TERM=none dircolors -b | wc -c", "31\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; TERM=linux dircolors -b | md5sum", "c0a74c326b5625e59b2bbfae2e528a3a  -\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; TERM=xterm-256color dircolors -b | md5sum", "c0a74c326b5625e59b2bbfae2e528a3a  -\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; COLORTERM=truecolor dircolors -b | md5sum", "c0a74c326b5625e59b2bbfae2e528a3a  -\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; SHELL=/bin/tcsh dircolors | head -c 40", "setenv LS_COLORS 'rs=0:di=01;34:ln=01;36[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; SHELL=/bin/csh dircolors | tail -c 20", "0:*.ucf-old=00;90:'\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; SHELL=/bin/zsh dircolors | tail -c 30", "old=00;90:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; SHELL= dircolors", "dircolors: no SHELL environment variable, and no shell type option given\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; unset SHELL ; dircolors", "dircolors: no SHELL environment variable, and no shell type option given\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; unset SHELL ; dircolors -b | head -c 20", "LS_COLORS='rs=0:di=0[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; unset SHELL ; dircolors --print-ls-colors | head -n 1 | od -c | head -n 1", "0000000 033   [   0   m   r   s  \\t   0 033   [   0   m  \\n\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -b -p", "dircolors: the options to output non shell syntax,\nand to select a shell syntax are mutually exclusive\nTry 'dircolors --help' for more information.\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -c -p", "dircolors: the options to output non shell syntax,\nand to select a shell syntax are mutually exclusive\nTry 'dircolors --help' for more information.\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -b --print-ls-colors", "dircolors: the options to output non shell syntax,\nand to select a shell syntax are mutually exclusive\nTry 'dircolors --help' for more information.\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -p --print-ls-colors", "dircolors: options --print-database and --print-ls-colors are mutually exclusive\nTry 'dircolors --help' for more information.\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -p x", "dircolors: extra operand 'x'\nfile operands cannot be combined with --print-database (-p)\nTry 'dircolors --help' for more information.\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -b x y", "dircolors: extra operand 'y'\nTry 'dircolors --help' for more information.\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -b nofile", "dircolors: nofile: No such file or directory\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -x", "dircolors: invalid option -- 'x'\nTry 'dircolors --help' for more information.\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors --bogus", "dircolors: unrecognized option '--bogus'\nTry 'dircolors --help' for more information.\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors --sh | head -c 20", "LS_COLORS='rs=0:di=0[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors --csh | head -c 20", "setenv LS_COLORS 'rs[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors --c-shell | head -c 20", "setenv LS_COLORS 'rs[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors --bourne-shell | head -c 20", "LS_COLORS='rs=0:di=0[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors --print-database | head -n 2", "# Configuration file for dircolors, a utility to help you set the\n# LS_COLORS environment variable used by GNU ls with the --color option.\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR 01;34' | dircolors -b -", "LS_COLORS='di=01;34:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'TERM xterm' | dircolors -b -", "LS_COLORS='';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'FOO 01' | dircolors -b -", "LS_COLORS='';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR' | dircolors -b -", "dircolors: -:1: invalid line;  missing second token\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR 01 # comment' | dircolors -b -", "LS_COLORS='di=01:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo '  DIR   01;34  ' | dircolors -b -", "LS_COLORS='di=01;34:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo '# only comment' | dircolors -b -", "LS_COLORS='';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo '.tar 01;31' | dircolors -b -", "LS_COLORS='*.tar=01;31:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo '*.tar 01;31' | dircolors -b -", "LS_COLORS='*.tar=01;31:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo \"*.it's 01;31\" | dircolors -b -", "LS_COLORS='*.it'\\''s=01;31:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR 01:34' | dircolors -b -", "LS_COLORS='di=01\\:34:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR a=b' | dircolors -b -", "LS_COLORS='di=a\\=b:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR a\\:b' | dircolors -b -", "LS_COLORS='di=a\\:b:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR a^:b' | dircolors -b -", "LS_COLORS='di=a^:b:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'dir 01' | dircolors -b -", "LS_COLORS='di=01:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR 01;34' | dircolors -c -", "setenv LS_COLORS 'di=01;34:'\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; echo 'DIR 01;34' | dircolors --print-ls-colors - | od -c | head -n 3", "0000000 033   [   0   1   ;   3   4   m   d   i  \\t   0   1   ;   3   4\n0000020 033   [   0   m  \\n\n0000025\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'DIR 01;34' | dircolors -b -", "LS_COLORS='di=01;34:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; dircolors -b < /dev/null", "LS_COLORS='rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35:do=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:mi=00:su=37;41:sg=30;43:ca=00:tw=30;42:ow=34;42:st=37;44:ex=01;32:*.tar=01;31:*.tgz=01;31:*.arc=01;31:*.arj=01;31:*.taz=01;31:*.lha=01;31:*.lz4=01;31:*.lzh=01;31:*.lzma=01;31:*.tlz=01;31:*.txz=01;31:*.tzo=01;31:*.t7z=01;31:*.zip=01;31:*.z=01;31:*.dz=01;31:*.gz=01;31:*.lrz=01;31:*.lz=01;31:*.lzo=01;31:*.xz=01;31:*.zst=01;31:*.tzst=01;31:*.bz2=01;31:*.bz=01;31:*.tbz=01;31:*.tbz2=01;31:*.tz=01;31:*.deb=01;31:*.rpm=01;31:*.jar=01;31:*.war=01;31:*.ear=01;31:*.sar=01;31:*.rar=01;31:*.alz=01;31:*.ace=01;31:*.zoo=01;31:*.cpio=01;31:*.7z=01;31:*.rz=01;31:*.cab=01;31:*.wim=01;31:*.swm=01;31:*.dwm=01;31:*.esd=01;31:*.avif=01;35:*.jpg=01;35:*.jpeg=01;35:*.mjpg=01;35:*.mjpeg=01;35:*.gif=01;35:*.bmp=01;35:*.pbm=01;35:*.pgm=01;35:*.ppm=01;35:*.tga=01;35:*.xbm=01;35:*.xpm=01;35:*.tif=01;35:*.tiff=01;35:*.png=01;35:*.svg=01;35:*.svgz=01;35:*.mng=01;35:*.pcx=01;35:*.mov=01;35:*.mpg=01;35:*.mpeg=01;35:*.m2v=01;35:*.mkv=01;35:*.webm=01;35:*.webp=01;35:*.ogm=01;35:*.mp4=01;35:*.m4v=01;35:*.mp4v=01;35:*.vob=01;35:*.qt=01;35:*.nuv=01;35:*.wmv=01;35:*.asf=01;35:*.rm=01;35:*.rmvb=01;35:*.flc=01;35:*.avi=01;35:*.fli=01;35:*.flv=01;35:*.gl=01;35:*.dl=01;35:*.xcf=01;35:*.xwd=01;35:*.yuv=01;35:*.cgm=01;35:*.emf=01;35:*.ogv=01;35:*.ogx=01;35:*.aac=00;36:*.au=00;36:*.flac=00;36:*.m4a=00;36:*.mid=00;36:*.midi=00;36:*.mka=00;36:*.mp3=00;36:*.mpc=00;36:*.ogg=00;36:*.ra=00;36:*.wav=00;36:*.oga=00;36:*.opus=00;36:*.spx=00;36:*.xspf=00;36:*~=00;90:*#=00;90:*.bak=00;90:*.crdownload=00;90:*.dpkg-dist=00;90:*.dpkg-new=00;90:*.dpkg-old=00;90:*.dpkg-tmp=00;90:*.old=00;90:*.orig=00;90:*.part=00;90:*.rej=00;90:*.rpmnew=00;90:*.rpmorig=00;90:*.rpmsave=00;90:*.swp=00;90:*.tmp=00;90:*.ucf-dist=00;90:*.ucf-new=00;90:*.ucf-old=00;90:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'TERM xterm\\nDIR 01;34\\n' | dircolors -b -", "LS_COLORS='di=01;34:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'TERM vt100\\nDIR 01;34\\n' | dircolors -b -", "LS_COLORS='';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'TERM vt*\\nDIR 01;34\\nTERM xterm\\nFILE 00\\n' | dircolors -b -", "LS_COLORS='fi=00:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'TERM xterm\\nFOO 01\\n' | dircolors -b -", "dircolors: -:2: unrecognized keyword FOO\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'OPTIONS -F\\nCOLOR tty\\nEIGHTBIT 1\\nDIR 01\\n' | dircolors -b -", "LS_COLORS='di=01:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'NORMAL 00\\nFILE 00\\nRESET 0\\nLINK 01\\nORPHAN 01\\nMISSING 01\\nFIFO 01\\nSOCK 01\\nBLK 01\\nCHR 01\\nDOOR 01\\nEXEC 01\\nLEFT 01\\nRIGHT 01\\nEND 01\\nSUID 01\\nSGID 01\\nSTICKY 01\\nOWR 01\\nOWT 01\\nCAPABILITY 01\\nMULTIHARDLINK 01\\nCLRTOEOL 01\\n' | dircolors -b -", "LS_COLORS='no=00:fi=00:rs=0:ln=01:or=01:mi=01:pi=01:so=01:bd=01:cd=01:do=01:ex=01:lc=01:rc=01:ec=01:su=01:sg=01:st=01:ow=01:tw=01:ca=01:mh=01:cl=01:';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'FOO 01\\nBAR 02\\n' | dircolors -b -", "LS_COLORS='';\nexport LS_COLORS\n[0]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'DIR 01\\nDIR\\nFILE 02\\n' | dircolors -b -", "dircolors: -:2: invalid line;  missing second token\n[1]"],
  ["export TERM=xterm SHELL=/bin/bash ; unset COLORTERM ; printf 'COLORTERM ?*\\nDIR 01\\n' | dircolors -b -", "LS_COLORS='';\nexport LS_COLORS\n[0]"],
];

describe('dircolors follows GNU dircolors', () => {
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
