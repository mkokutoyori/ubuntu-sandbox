/*
/*
 * ls --dired and --hyperlink were accepted and ignored. --dired (with -l) indents every non-blank line by two
 * spaces and appends //DIRED// (byte offsets of each name, without the alignment space), //SUBDIRED// (the
 * directory headings, in recursive and multi-operand listings) and //DIRED-OPTIONS// with the quoting style;
 * --hyperlink=always wraps names, headings and link targets in OSC 8 links to the canonical path with
 * lower-case percent-encoding, and turns --dired off. Found on the way, and fixed with them: a link target
 * is quoted like a name and takes the -F indicator (not the -p one); -1 no longer overrides -l; -R puts a
 * blank line between top-level directories; a command-line file listing is padded to the widths of the
 * directory operands too; an empty option argument is 'ambiguous'.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 as root (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff, dates and host name masked). Inode numbers, colours and the order of -t/-U are not pinned.
 *
 * Measured against the commit before (worktree): 70 of 85 cases fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep other; printf 'hi\\n' > a.txt; printf 'yo\\n' > 'b c'; printf 'z\\n' > sub/z1; touch 'sub/e x' sub/deep/q 'other/o p'; ln -sf a.txt lnk; ln -sfn sub dl";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["ROOT:ls -lD | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 T other\n  drwxr-xr-x 3 root root 4096 T sub\n//DIRED// 54 59 103 106 150 152 203 206 259 264 308 311\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -l --dired | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 T other\n  drwxr-xr-x 3 root root 4096 T sub\n//DIRED// 54 59 103 106 150 152 203 206 259 264 308 311\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDR | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  .:\n  total 16\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 T other\n  drwxr-xr-x 3 root root 4096 T sub\n\n  ./other:\n  total 0\n  -rw-r--r-- 1 root root 0 T o p\n\n  ./sub:\n  total 8\n  drwxr-xr-x 2 root root 4096 T deep\n  -rw-r--r-- 1 root root    0 T e x\n  -rw-r--r-- 1 root root    2 T z1\n\n  ./sub/deep:\n  total 0\n  -rw-r--r-- 1 root root 0 T q\n//DIRED// 59 64 108 111 155 157 208 211 264 269 313 316 379 382 446 450 494 497 541 543 609 610\n//SUBDIRED// 2 3 320 327 386 391 547 557\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lD sub other | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  other:\n  total 0\n  -rw-r--r-- 1 root root 0 T o p\n\n  sub:\n  total 8\n  drwxr-xr-x 2 root root 4096 T deep\n  -rw-r--r-- 1 root root    0 T e x\n  -rw-r--r-- 1 root root    2 T z1\n//DIRED// 59 62 124 128 172 175 219 221\n//SUBDIRED// 2 7 66 69\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDQ | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 T \"a.txt\"\n  -rw-r--r-- 1 root root    3 T \"b c\"\n  lrwxrwxrwx 1 root root    3 T \"dl\" -> \"sub\"\n  lrwxrwxrwx 1 root root    5 T \"lnk\" -> \"a.txt\"\n  drwxr-xr-x 2 root root 4096 T \"other\"\n  drwxr-xr-x 3 root root 4096 T \"sub\"\n//DIRED// 54 61 105 110 154 158 211 216 271 278 322 327\n//DIRED-OPTIONS// --quoting-style=c\n[0]"],
  ["ROOT:ls -lDb | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b\\ c\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 T other\n  drwxr-xr-x 3 root root 4096 T sub\n//DIRED// 54 59 103 107 151 153 204 207 260 265 309 312\n//DIRED-OPTIONS// --quoting-style=escape\n[0]"],
  ["ROOT:ls -lD --quoting-style=shell | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 T  a.txt\n  -rw-r--r-- 1 root root    3 T 'b c'\n  lrwxrwxrwx 1 root root    3 T  dl -> sub\n  lrwxrwxrwx 1 root root    5 T  lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 T  other\n  drwxr-xr-x 3 root root 4096 T  sub\n//DIRED// 55 60 104 109 154 156 208 211 265 270 315 318\n//DIRED-OPTIONS// --quoting-style=shell\n[0]"],
  ["ROOT:ls -lDF | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  lrwxrwxrwx 1 root root    3 T dl -> sub/\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 T other/\n  drwxr-xr-x 3 root root 4096 T sub/\n//DIRED// 54 59 103 106 150 152 204 207 260 265 310 313\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDA | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 T other\n  drwxr-xr-x 3 root root 4096 T sub\n//DIRED// 54 59 103 106 150 152 203 206 259 264 308 311\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDRA sub | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  sub:\n  total 8\n  drwxr-xr-x 2 root root 4096 T deep\n  -rw-r--r-- 1 root root    0 T e x\n  -rw-r--r-- 1 root root    2 T z1\n\n  sub/deep:\n  total 0\n  -rw-r--r-- 1 root root 0 T q\n//DIRED// 60 64 108 111 155 157 221 222\n//SUBDIRED// 2 5 161 169\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDS | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  drwxr-xr-x 2 root root 4096 T other\n  drwxr-xr-x 3 root root 4096 T sub\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n//DIRED// 54 59 103 106 150 153 206 211 255 258 302 304\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDh | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16K\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root 4.0K T other\n  drwxr-xr-x 3 root root 4.0K T sub\n//DIRED// 55 60 104 107 151 153 204 207 260 265 309 312\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDs | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  4 -rw-r--r-- 1 root root    3 T a.txt\n  4 -rw-r--r-- 1 root root    3 T b c\n  0 lrwxrwxrwx 1 root root    3 T dl -> sub\n  0 lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  4 drwxr-xr-x 2 root root 4096 T other\n  4 drwxr-xr-x 3 root root 4096 T sub\n//DIRED// 56 61 107 110 156 158 211 214 269 274 320 323\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDn | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 0 0    3 T a.txt\n  -rw-r--r-- 1 0 0    3 T b c\n  lrwxrwxrwx 1 0 0    3 T dl -> sub\n  lrwxrwxrwx 1 0 0    5 T lnk -> a.txt\n  drwxr-xr-x 2 0 0 4096 T other\n  drwxr-xr-x 3 0 0 4096 T sub\n//DIRED// 48 53 91 94 132 134 179 182 229 234 272 275\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDg | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root    3 T a.txt\n  -rw-r--r-- 1 root    3 T b c\n  lrwxrwxrwx 1 root    3 T dl -> sub\n  lrwxrwxrwx 1 root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root 4096 T other\n  drwxr-xr-x 3 root 4096 T sub\n//DIRED// 49 54 93 96 135 137 183 186 234 239 278 281\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDo | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root    3 T a.txt\n  -rw-r--r-- 1 root    3 T b c\n  lrwxrwxrwx 1 root    3 T dl -> sub\n  lrwxrwxrwx 1 root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root 4096 T other\n  drwxr-xr-x 3 root 4096 T sub\n//DIRED// 49 54 93 96 135 137 183 186 234 239 278 281\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDRQ | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  \".\":\n  total 16\n  -rw-r--r-- 1 root root    3 T \"a.txt\"\n  -rw-r--r-- 1 root root    3 T \"b c\"\n  lrwxrwxrwx 1 root root    3 T \"dl\" -> \"sub\"\n  lrwxrwxrwx 1 root root    5 T \"lnk\" -> \"a.txt\"\n  drwxr-xr-x 2 root root 4096 T \"other\"\n  drwxr-xr-x 3 root root 4096 T \"sub\"\n\n  \"./other\":\n  total 0\n  -rw-r--r-- 1 root root 0 T \"o p\"\n\n  \"./sub\":\n  total 8\n  drwxr-xr-x 2 root root 4096 T \"deep\"\n  -rw-r--r-- 1 root root    0 T \"e x\"\n  -rw-r--r-- 1 root root    2 T \"z1\"\n\n  \"./sub/deep\":\n  total 0\n  -rw-r--r-- 1 root root 0 T \"q\"\n//DIRED// 61 68 112 117 161 165 218 223 278 285 329 334 399 404 470 476 520 525 569 573 641 644\n//SUBDIRED// 2 5 338 347 408 415 577 589\n//DIRED-OPTIONS// --quoting-style=c\n[0]"],
  ["ROOT:ls -lDR sub | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  sub:\n  total 8\n  drwxr-xr-x 2 root root 4096 T deep\n  -rw-r--r-- 1 root root    0 T e x\n  -rw-r--r-- 1 root root    2 T z1\n\n  sub/deep:\n  total 0\n  -rw-r--r-- 1 root root 0 T q\n//DIRED// 60 64 108 111 155 157 221 222\n//SUBDIRED// 2 5 161 169\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lD a.txt lnk | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  -rw-r--r-- 1 root root 3 T a.txt\n  lrwxrwxrwx 1 root root 5 T lnk -> a.txt\n//DIRED// 40 45 86 89\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDd a.txt 'b c' sub | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  drwxr-xr-x 3 root root 4096 T sub\n//DIRED// 43 48 92 95 139 142\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lD dl | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  lrwxrwxrwx 1 root root 3 T dl -> sub\n//DIRED// 40 42\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lD -L dl | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 8\n  drwxr-xr-x 2 root root 4096 T deep\n  -rw-r--r-- 1 root root    0 T e x\n  -rw-r--r-- 1 root root    2 T z1\n//DIRED// 53 57 101 104 148 150\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDr | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  drwxr-xr-x 3 root root 4096 T sub\n  drwxr-xr-x 2 root root 4096 T other\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n  -rw-r--r-- 1 root root    3 T b c\n  -rw-r--r-- 1 root root    3 T a.txt\n//DIRED// 54 57 101 106 150 153 206 208 259 262 306 311\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDm | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "a.txt, b c, dl, lnk, other, sub\n[0]"],
  ["ROOT:ls -lDx | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "a.txt  b c  dl\tlnk  other  sub\n[0]"],
  ["ROOT:ls -lDC | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "a.txt  b c  dl\tlnk  other  sub\n[0]"],
  ["ROOT:ls -lD1 | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 T a.txt\n  -rw-r--r-- 1 root root    3 T b c\n  lrwxrwxrwx 1 root root    3 T dl -> sub\n  lrwxrwxrwx 1 root root    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 T other\n  drwxr-xr-x 3 root root 4096 T sub\n//DIRED// 54 59 103 106 150 152 203 206 259 264 308 311\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lD --time-style=long-iso | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root    3 2026-11-05 02:14 a.txt\n  -rw-r--r-- 1 root root    3 2026-11-05 02:14 b c\n  lrwxrwxrwx 1 root root    3 2026-11-05 02:14 dl -> sub\n  lrwxrwxrwx 1 root root    5 2026-11-05 02:14 lnk -> a.txt\n  drwxr-xr-x 2 root root 4096 2026-11-05 02:14 other\n  drwxr-xr-x 3 root root 4096 2026-11-05 02:14 sub\n//DIRED// 58 63 111 114 162 164 219 222 279 284 332 335\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lD --block-size=K | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16K\n  -rw-r--r-- 1 root root 1K T a.txt\n  -rw-r--r-- 1 root root 1K T b c\n  lrwxrwxrwx 1 root root 1K T dl -> sub\n  lrwxrwxrwx 1 root root 1K T lnk -> a.txt\n  drwxr-xr-x 2 root root 4K T other\n  drwxr-xr-x 3 root root 4K T sub\n//DIRED// 53 58 100 103 145 147 196 199 250 255 297 300\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lD -Z | sed -E 's/[A-Z][a-z]{2} +[0-9]+ +[0-9:]+ /T /'", "  total 16\n  -rw-r--r-- 1 root root ?    3 T a.txt\n  -rw-r--r-- 1 root root ?    3 T b c\n  lrwxrwxrwx 1 root root ?    3 T dl -> sub\n  lrwxrwxrwx 1 root root ?    5 T lnk -> a.txt\n  drwxr-xr-x 2 root root ? 4096 T other\n  drwxr-xr-x 3 root root ? 4096 T sub\n//DIRED// 56 61 107 110 156 158 211 214 269 274 320 323\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -D -1 sub", "deep\ne x\nz1\n[0]"],
  ["ROOT:ls --hyperlink | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/a.txt^Ga.txt^[]8;;^G\n^[]8;;file://H/tmp/ff/b%20c^Gb c^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gdl^[]8;;^G\n^[]8;;file://H/tmp/ff/a.txt^Glnk^[]8;;^G\n^[]8;;file://H/tmp/ff/other^Gother^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G\n[0]"],
  ["ROOT:ls --hyperlink=always | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/a.txt^Ga.txt^[]8;;^G\n^[]8;;file://H/tmp/ff/b%20c^Gb c^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gdl^[]8;;^G\n^[]8;;file://H/tmp/ff/a.txt^Glnk^[]8;;^G\n^[]8;;file://H/tmp/ff/other^Gother^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G\n[0]"],
  ["ROOT:ls --hyperlink=yes | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/a.txt^Ga.txt^[]8;;^G\n^[]8;;file://H/tmp/ff/b%20c^Gb c^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gdl^[]8;;^G\n^[]8;;file://H/tmp/ff/a.txt^Glnk^[]8;;^G\n^[]8;;file://H/tmp/ff/other^Gother^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G\n[0]"],
  ["ROOT:ls --hyperlink=force | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/a.txt^Ga.txt^[]8;;^G\n^[]8;;file://H/tmp/ff/b%20c^Gb c^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gdl^[]8;;^G\n^[]8;;file://H/tmp/ff/a.txt^Glnk^[]8;;^G\n^[]8;;file://H/tmp/ff/other^Gother^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G\n[0]"],
  ["ROOT:ls --hyperlink=auto | sed 's#file://[^/]*#file://H#g' | cat -v", "a.txt\nb c\ndl\nlnk\nother\nsub\n[0]"],
  ["ROOT:ls --hyperlink=tty | sed 's#file://[^/]*#file://H#g' | cat -v", "a.txt\nb c\ndl\nlnk\nother\nsub\n[0]"],
  ["ROOT:ls --hyperlink=if-tty | sed 's#file://[^/]*#file://H#g' | cat -v", "a.txt\nb c\ndl\nlnk\nother\nsub\n[0]"],
  ["ROOT:ls --hyperlink=never | sed 's#file://[^/]*#file://H#g' | cat -v", "a.txt\nb c\ndl\nlnk\nother\nsub\n[0]"],
  ["ROOT:ls --hyperlink=no | sed 's#file://[^/]*#file://H#g' | cat -v", "a.txt\nb c\ndl\nlnk\nother\nsub\n[0]"],
  ["ROOT:ls --hyperlink=none | sed 's#file://[^/]*#file://H#g' | cat -v", "a.txt\nb c\ndl\nlnk\nother\nsub\n[0]"],
  ["ROOT:ls --hyperlink=bogus", "ls: invalid argument 'bogus' for '--hyperlink'\nValid arguments are:\n  - 'always', 'yes', 'force'\n  - 'never', 'no', 'none'\n  - 'auto', 'tty', 'if-tty'\nTry 'ls --help' for more information.\n[1]"],
  ["ROOT:ls --hyperlink=", "ls: ambiguous argument '' for '--hyperlink'\nValid arguments are:\n  - 'always', 'yes', 'force'\n  - 'never', 'no', 'none'\n  - 'auto', 'tty', 'if-tty'\nTry 'ls --help' for more information.\n[1]"],
  ["ROOT:ls --hyper=always | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/a.txt^Ga.txt^[]8;;^G\n^[]8;;file://H/tmp/ff/b%20c^Gb c^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gdl^[]8;;^G\n^[]8;;file://H/tmp/ff/a.txt^Glnk^[]8;;^G\n^[]8;;file://H/tmp/ff/other^Gother^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G\n[0]"],
  ["ROOT:ls -1 --hyperlink=always sub | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -l --hyperlink=always sub | sed 's#file://[^/]*#file://H#g' | cat -v", "total 8\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G\n-rw-r--r-- 1 root root    0 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n-rw-r--r-- 1 root root    2 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -lF --hyperlink=always | sed 's#file://[^/]*#file://H#g' | cat -v", "total 16\n-rw-r--r-- 1 root root    3 Nov  5 02:14 ^[]8;;file://H/tmp/ff/a.txt^Ga.txt^[]8;;^G\n-rw-r--r-- 1 root root    3 Nov  5 02:14 ^[]8;;file://H/tmp/ff/b%20c^Gb c^[]8;;^G\nlrwxrwxrwx 1 root root    3 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub^Gdl^[]8;;^G -> ^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G/\nlrwxrwxrwx 1 root root    5 Nov  5 02:14 ^[]8;;file://H/tmp/ff/a.txt^Glnk^[]8;;^G -> ^[]8;;file://H/tmp/ff/a.txt^Ga.txt^[]8;;^G\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 ^[]8;;file://H/tmp/ff/other^Gother^[]8;;^G/\ndrwxr-xr-x 3 root root 4096 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G/\n[0]"],
  ["ROOT:ls -R --hyperlink=always sub | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G:\n^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n\n^[]8;;file://H/tmp/ff/sub/deep^Gsub/deep^[]8;;^G:\n^[]8;;file://H/tmp/ff/sub/deep/q^Gq^[]8;;^G\n[0]"],
  ["ROOT:ls -lQ --hyperlink=always sub | sed 's#file://[^/]*#file://H#g' | cat -v", "total 8\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/deep^G\"deep\"^[]8;;^G\n-rw-r--r-- 1 root root    0 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/e%20x^G\"e x\"^[]8;;^G\n-rw-r--r-- 1 root root    2 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/z1^G\"z1\"^[]8;;^G\n[0]"],
  ["ROOT:ls -1 --hyperlink=always 'b c' sub | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/b%20c^Gb c^[]8;;^G\n\n^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G:\n^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -1d --hyperlink=always sub a.txt | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/a.txt^Ga.txt^[]8;;^G\n^[]8;;file://H/tmp/ff/sub^Gsub^[]8;;^G\n[0]"],
  ["ROOT:ls -1 --hyperlink=always ./sub | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -1 --hyperlink=always sub/../sub | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -m --hyperlink=always sub | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G, ^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G, ^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -C --hyperlink=always sub | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G  ^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G  ^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -lD --hyperlink=always sub | sed 's#file://[^/]*#file://H#g' | cat -v", "total 8\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G\n-rw-r--r-- 1 root root    0 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n-rw-r--r-- 1 root root    2 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -1 --hyperlink=always -L dl | sed 's#file://[^/]*#file://H#g' | cat -v", "^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
  ["ROOT:ls -1D sub", "deep\ne x\nz1\n[0]"],
  ["ROOT:ls -1 -D -R sub", "sub:\ndeep\ne x\nz1\n\nsub/deep:\nq\n[0]"],
  ["ROOT:ls -lDR sub other", "  other:\n  total 0\n  -rw-r--r-- 1 root root 0 Nov  5 02:14 o p\n\n  sub:\n  total 8\n  drwxr-xr-x 2 root root 4096 Nov  5 02:14 deep\n  -rw-r--r-- 1 root root    0 Nov  5 02:14 e x\n  -rw-r--r-- 1 root root    2 Nov  5 02:14 z1\n\n  sub/deep:\n  total 0\n  -rw-r--r-- 1 root root 0 Nov  5 02:14 q\n//DIRED// 59 62 124 128 172 175 219 221 285 286\n//SUBDIRED// 2 7 66 69 225 233\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lD -d sub other", "  drwxr-xr-x 2 root root 4096 Nov  5 02:14 other\n  drwxr-xr-x 3 root root 4096 Nov  5 02:14 sub\n//DIRED// 43 48 92 95\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lDd sub other", "  drwxr-xr-x 2 root root 4096 Nov  5 02:14 other\n  drwxr-xr-x 3 root root 4096 Nov  5 02:14 sub\n//DIRED// 43 48 92 95\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lFD dl lnk", "  lrwxrwxrwx 1 root root 3 Nov  5 02:14 dl -> sub/\n  lrwxrwxrwx 1 root root 5 Nov  5 02:14 lnk -> a.txt\n//DIRED// 40 42 91 94\n//DIRED-OPTIONS// --quoting-style=literal\n[0]"],
  ["ROOT:ls -lp dl", "lrwxrwxrwx 1 root root 3 Nov  5 02:14 dl -> sub\n[0]"],
  ["ROOT:ls -l -F sub dl", "lrwxrwxrwx 1 root root    3 Nov  5 02:14 dl -> sub/\n\nsub:\ntotal 8\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 deep/\n-rw-r--r-- 1 root root    0 Nov  5 02:14 e x\n-rw-r--r-- 1 root root    2 Nov  5 02:14 z1\n[0]"],
  ["ROOT:ls -l1", "total 16\n-rw-r--r-- 1 root root    3 Nov  5 02:14 a.txt\n-rw-r--r-- 1 root root    3 Nov  5 02:14 b c\nlrwxrwxrwx 1 root root    3 Nov  5 02:14 dl -> sub\nlrwxrwxrwx 1 root root    5 Nov  5 02:14 lnk -> a.txt\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 other\ndrwxr-xr-x 3 root root 4096 Nov  5 02:14 sub\n[0]"],
  ["ROOT:ls -1l", "total 16\n-rw-r--r-- 1 root root    3 Nov  5 02:14 a.txt\n-rw-r--r-- 1 root root    3 Nov  5 02:14 b c\nlrwxrwxrwx 1 root root    3 Nov  5 02:14 dl -> sub\nlrwxrwxrwx 1 root root    5 Nov  5 02:14 lnk -> a.txt\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 other\ndrwxr-xr-x 3 root root 4096 Nov  5 02:14 sub\n[0]"],
  ["ROOT:ls -lm", "a.txt, b c, dl, lnk, other, sub\n[0]"],
  ["ROOT:ls -ml", "total 16\n-rw-r--r-- 1 root root    3 Nov  5 02:14 a.txt\n-rw-r--r-- 1 root root    3 Nov  5 02:14 b c\nlrwxrwxrwx 1 root root    3 Nov  5 02:14 dl -> sub\nlrwxrwxrwx 1 root root    5 Nov  5 02:14 lnk -> a.txt\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 other\ndrwxr-xr-x 3 root root 4096 Nov  5 02:14 sub\n[0]"],
  ["ROOT:ls -lC", "a.txt  b c  dl\tlnk  other  sub\n[0]"],
  ["ROOT:ls -l --format=single-column", "a.txt\nb c\ndl\nlnk\nother\nsub\n[0]"],
  ["ROOT:ls -1R sub other", "other:\no p\n\nsub:\ndeep\ne x\nz1\n\nsub/deep:\nq\n[0]"],
  ["ROOT:ls -1R a.txt sub", "a.txt\n\nsub:\ndeep\ne x\nz1\n\nsub/deep:\nq\n[0]"],
  ["ROOT:ls -l a.txt sub", "-rw-r--r-- 1 root root    3 Nov  5 02:14 a.txt\n\nsub:\ntotal 8\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 deep\n-rw-r--r-- 1 root root    0 Nov  5 02:14 e x\n-rw-r--r-- 1 root root    2 Nov  5 02:14 z1\n[0]"],
  ["ROOT:ls -l dl sub", "lrwxrwxrwx 1 root root    3 Nov  5 02:14 dl -> sub\n\nsub:\ntotal 8\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 deep\n-rw-r--r-- 1 root root    0 Nov  5 02:14 e x\n-rw-r--r-- 1 root root    2 Nov  5 02:14 z1\n[0]"],
  ["ROOT:ls -l a.txt lnk", "-rw-r--r-- 1 root root 3 Nov  5 02:14 a.txt\nlrwxrwxrwx 1 root root 5 Nov  5 02:14 lnk -> a.txt\n[0]"],
  ["ROOT:ls -ld a.txt sub", "-rw-r--r-- 1 root root    3 Nov  5 02:14 a.txt\ndrwxr-xr-x 3 root root 4096 Nov  5 02:14 sub\n[0]"],
  ["ROOT:ls -ls a.txt sub", "4 -rw-r--r-- 1 root root    3 Nov  5 02:14 a.txt\n\nsub:\ntotal 8\n4 drwxr-xr-x 2 root root 4096 Nov  5 02:14 deep\n0 -rw-r--r-- 1 root root    0 Nov  5 02:14 e x\n4 -rw-r--r-- 1 root root    2 Nov  5 02:14 z1\n[0]"],
  ["ROOT:ls -li a.txt sub | sed 's/^ *[0-9]* //'", "-rw-r--r-- 1 root root    3 Nov  5 02:14 a.txt\n\nsub:\ntotal 8\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 deep\n-rw-r--r-- 1 root root    0 Nov  5 02:14 e x\n-rw-r--r-- 1 root root    2 Nov  5 02:14 z1\n[0]"],
  ["ROOT:ls -lh a.txt sub", "-rw-r--r-- 1 root root    3 Nov  5 02:14 a.txt\n\nsub:\ntotal 8.0K\ndrwxr-xr-x 2 root root 4.0K Nov  5 02:14 deep\n-rw-r--r-- 1 root root    0 Nov  5 02:14 e x\n-rw-r--r-- 1 root root    2 Nov  5 02:14 z1\n[0]"],
  ["ROOT:ls -lF dl lnk", "lrwxrwxrwx 1 root root 3 Nov  5 02:14 dl -> sub/\nlrwxrwxrwx 1 root root 5 Nov  5 02:14 lnk -> a.txt\n[0]"],
  ["ROOT:ls -lF dl", "lrwxrwxrwx 1 root root 3 Nov  5 02:14 dl -> sub/\n[0]"],
  ["ROOT:ls -lp dl", "lrwxrwxrwx 1 root root 3 Nov  5 02:14 dl -> sub\n[0]"],
  ["ROOT:ls -l --file-type dl", "lrwxrwxrwx 1 root root 3 Nov  5 02:14 dl -> sub/\n[0]"],
  ["ROOT:ls -lF --hyperlink=always sub | sed 's#file://[^/]*#file://H#g' | cat -v", "total 8\ndrwxr-xr-x 2 root root 4096 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/deep^Gdeep^[]8;;^G/\n-rw-r--r-- 1 root root    0 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/e%20x^Ge x^[]8;;^G\n-rw-r--r-- 1 root root    2 Nov  5 02:14 ^[]8;;file://H/tmp/ff/sub/z1^Gz1^[]8;;^G\n[0]"],
];

describe('ls --dired and --hyperlink against the real GNU ls', () => {
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
