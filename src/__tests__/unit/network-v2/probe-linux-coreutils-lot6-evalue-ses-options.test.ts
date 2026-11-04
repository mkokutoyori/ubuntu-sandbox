/*
 * diff accepted most of its options and evaluated a handful, and xargs accepted -s -x -o
 * without measuring a single byte: `diff -e -n -y -W -a -T -t -l -p -F -D`, `--left-column`,
 * `--suppress-common-lines`, `--strip-trailing-cr`, `--tabsize`, `--from-file`/`--to-file`,
 * `--no-dereference`, the numeric `-3`/`-u5` forms and every `--*-line-format` /
 * `--*-group-format` were missing or ignored; xargs ignored `-s` (no size splitting, no
 * "argument line too long" / "argument list too long" / "cannot fit single argument"),
 * `-x`, the option-conflict warnings of -I/-L/-l/-n, the `--replace` default, `--help`,
 * `--version`, kept silent on an empty input, and dropped the arguments read before an
 * unmatched quote.
 *
 * Every expected string was produced by the real GNU diffutils 3.10 / findutils 4.9.0 of
 * the dev container, by running the identical line in bash with LC_ALL=C.UTF-8 (typographic
 * quotes normalised, scratch directory rewritten to /tmp/ff). NOT covered, because the
 * machines differ: file timestamps in diff headers, the order in which a child's stderr
 * and xargs's own stderr interleave on a pipe, the -s upper limit (depends on the
 * environment size), `diff -l` page headers, `ls` columns, readdir order.
 *
 * Measured against the commit before (worktree): 158 cases; at the commit before 79 fall (diff -e/-n/-y/-D/-T/-t/-p, numeric context counts, line and group formats, --from-file, binary and no-newline handling; xargs -s/-x, conflict warnings, empty input, quotes), 79 pass either way as non-regression witnesses (normal/context/unified formats, -q -s -i -w -b -B -r -N, identical files, exit statuses).
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
  [": > z ; diff -c z a.txt | tail -n +3", "***************\n*** 0 ****\n--- 1 ----\n+ hi\n[0]"],
  [": > z ; diff -e z a.txt", "0a\nhi\n.\n[1]"],
  [": > z ; diff -n z a.txt", "a0 1\nhi\n[1]"],
  [": > z ; diff -u a.txt z | tail -n +3", "@@ -1 +0,0 @@\n-hi\n[0]"],
  [": > z ; diff -u z a.txt | tail -n +3", "@@ -0,0 +1 @@\n+hi\n[0]"],
  [": > z ; diff z a.txt", "0a1\n> hi\n[1]"],
  ["diff", "diff: missing operand after 'diff'\ndiff: Try 'diff --help' for more information.\n[2]"],
  ["diff --bogus a.txt words", "diff: unrecognized option '--bogus'\ndiff: Try 'diff --help' for more information.\n[2]"],
  ["diff --brief a.txt words", "Files a.txt and words differ\n[1]"],
  ["diff --color=never a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff --context=1 words nums | tail -n +3 | head -4", "***************\n*** 1,7 ****\n! foo bar\n! baz qux\n[0]"],
  ["diff --expand-tabs -y a.txt words | head -2", "hi                                                              |  foo bar\n                                                                >  baz qux\n[0]"],
  ["diff --from-file a.txt words nums | head -2", "1c1,7\n< hi\n[0]"],
  ["diff --from-file a.txt words nums | head -3", "1c1,7\n< hi\n---\n[0]"],
  ["diff --horizon-lines=1 a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff --ignore-case a.txt a.txt ; echo $?", "0\n[0]"],
  ["diff --label X --label Y -u a.txt words | head -3", "--- X\n+++ Y\n@@ -1 +1,7 @@\n[0]"],
  ["diff --label=X --label=Y -u words nums | head -2", "--- X\n+++ Y\n[0]"],
  ["diff --left-column -y a.txt words | head -3", "hi\t\t\t\t\t\t\t      |\tfoo bar\n\t\t\t\t\t\t\t      >\tbaz qux\n\t\t\t\t\t\t\t      >\tFoo BAR\n[0]"],
  ["diff --line-format='%L' a.txt words | head -2", "hi\nfoo bar\n[0]"],
  ["diff --minimal a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff --no-dereference lnk a.txt ; echo $?", "File lnk is a symbolic link while file a.txt is a regular file\n1\n[0]"],
  ["diff --normal a.txt words | head -3", "1c1,7\n< hi\n---\n[0]"],
  ["diff --normal words nums | head -2", "1,7c1,10\n< foo bar\n[0]"],
  ["diff --side-by-side -W 40 a.txt words | head -3", "hi\t\t   |\tfoo bar\n\t\t   >\tbaz qux\n\t\t   >\tFoo BAR\n[0]"],
  ["diff --speed-large-files a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff --strip-trailing-cr a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff --suppress-common-lines -y a.txt words | head -3", "hi\t\t\t\t\t\t\t      |\tfoo bar\n\t\t\t\t\t\t\t      >\tbaz qux\n\t\t\t\t\t\t\t      >\tFoo BAR\n[0]"],
  ["diff --to-file=a.txt words nums | head -2", "1,7c1\n< foo bar\n[0]"],
  ["diff --to-file=a.txt words nums | head -3", "1,7c1\n< foo bar\n< baz qux\n[0]"],
  ["diff --unchanged-line-format='= %L' --old-line-format='- %L' --new-line-format='+ %L' a.txt words | head -3", "- hi\n+ foo bar\n+ baz qux\n[0]"],
  ["diff --unified=1 words nums | tail -n +3 | head -3", "@@ -1,7 +1,10 @@\n-foo bar\n-baz qux\n[0]"],
  ["diff -3 words nums | tail -n +3 | head -4", "< baz qux\n< Foo BAR\n< hello world\n< baz qux\n[0]"],
  ["diff -B a.txt words | head -3", "1c1,7\n< hi\n---\n[0]"],
  ["diff -C 0 words nums | tail -n +3 | head -4", "***************\n*** 1,7 ****\n! foo bar\n! baz qux\n[0]"],
  ["diff -C 1 words nums | tail -n +3 | head -4", "***************\n*** 1,7 ****\n! foo bar\n! baz qux\n[0]"],
  ["diff -D FOO a.txt words | head -3", "#ifndef FOO\nhi\n#else /* FOO */\n[0]"],
  ["diff -F foo a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff -I hi a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff -L X -L Y -c words nums | head -2", "*** X\n--- Y\n[0]"],
  ["diff -N nofile words | head -2", "0a1,7\n> foo bar\n[0]"],
  ["diff -T -c words nums | tail -n +3 | head -4", "***************\n*** 1,7 ****\n!\tfoo bar\n!\tbaz qux\n[0]"],
  ["diff -T -u words nums | tail -n +3 | head -4", "@@ -1,7 +1,10 @@\n-\tfoo bar\n-\tbaz qux\n-\tFoo BAR\n[0]"],
  ["diff -T a.txt words | head -2", "1c1,7\n<\thi\n[0]"],
  ["diff -T a.txt words | head -4", "1c1,7\n<\thi\n---\n>\tfoo bar\n[0]"],
  ["diff -U 0 words nums | tail -n +3 | head -3", "@@ -1,7 +1,10 @@\n-foo bar\n-baz qux\n[0]"],
  ["diff -U 1 words nums | tail -n +3 | head -4", "@@ -1,7 +1,10 @@\n-foo bar\n-baz qux\n-Foo BAR\n[0]"],
  ["diff -Z a.txt a.txt ; echo $?", "0\n[0]"],
  ["diff -a a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff -b a.txt a.txt ; echo $?", "0\n[0]"],
  ["diff -c words nums | tail -n +3 | head -5", "***************\n*** 1,7 ****\n! foo bar\n! baz qux\n! Foo BAR\n[0]"],
  ["diff -d a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff -e a.txt words | head -3", "1c\nfoo bar\nbaz qux\n[0]"],
  ["diff -i a.txt a.txt", "[0]"],
  ["diff -i words words", "[0]"],
  ["diff -q words nums", "Files words and nums differ\n[1]"],
  ["diff -q words words ; echo $?", "0\n[0]"],
  ["diff -r sub sub ; echo $?", "0\n[0]"],
  ["diff -rq . . ; echo $?", "0\n[0]"],
  ["diff -s a.txt a.txt", "Files a.txt and a.txt are identical\n[0]"],
  ["diff -s words words", "Files words and words are identical\n[0]"],
  ["diff -t -y a.txt words | head -2", "hi                                                              |  foo bar\n                                                                >  baz qux\n[0]"],
  ["diff -u words nums | tail -n +3 | head -5", "@@ -1,7 +1,10 @@\n-foo bar\n-baz qux\n-Foo BAR\n-hello world\n[0]"],
  ["diff -u words words ; echo $?", "0\n[0]"],
  ["diff -u5 words nums | tail -n +3 | head -3", "@@ -1,7 +1,10 @@\n-foo bar\n-baz qux\n[0]"],
  ["diff -w a.txt a.txt", "[0]"],
  ["diff -x '*.txt' a.txt words | head -2", "1c1,7\n< hi\n[0]"],
  ["diff -y a.txt words | head -3", "hi\t\t\t\t\t\t\t      |\tfoo bar\n\t\t\t\t\t\t\t      >\tbaz qux\n\t\t\t\t\t\t\t      >\tFoo BAR\n[0]"],
  ["diff a.txt", "diff: missing operand after 'a.txt'\ndiff: Try 'diff --help' for more information.\n[2]"],
  ["diff a.txt words extra", "diff: extra operand 'extra'\ndiff: Try 'diff --help' for more information.\n[2]"],
  ["diff nofile words", "diff: nofile: No such file or directory\n[2]"],
  ["diff words nums | head -5", "1,7c1,10\n< foo bar\n< baz qux\n< Foo BAR\n< hello world\n[0]"],
  ["diff words words ; echo $?", "0\n[0]"],
  ["ln -s a.txt l ; diff --no-dereference l a.txt", "File l is a symbolic link while file a.txt is a regular file\n[1]"],
  ["mkdir d1 d2 ; echo x > d1/f ; echo x > d2/f ; ln -s f d1/s ; ln -s g d2/s ; diff -r --no-dereference d1 d2 ; echo $?", "Symbolic links d1/s and d2/s differ\n1\n[0]"],
  ["mkdir d1 d2 ; echo x > d1/f ; echo y > d2/f ; diff -rs d1 d2", "diff -rs d1/f d2/f\n1c1\n< x\n---\n> y\n[1]"],
  ["mkdir d1 d2 ; echo x > d1/f ; echo y > d2/f ; echo z > d1/only ; diff -r d1 d2", "diff -r d1/f d2/f\n1c1\n< x\n---\n> y\nOnly in d1: only\n[1]"],
  ["mkdir d1 d2 ; echo x > d1/f ; echo y > d2/f ; echo z > d1/only ; diff -rN d1 d2", "diff -rN d1/f d2/f\n1c1\n< x\n---\n> y\ndiff -rN d1/only d2/only\n1d0\n< z\n[1]"],
  ["mkdir d1 d2 ; echo x > d1/f ; echo y > d2/f ; echo z > d1/only ; diff -rq d1 d2", "Files d1/f and d2/f differ\nOnly in d1: only\n[1]"],
  ["mkdir d1 d2 ; echo x > d1/f ; echo y > d2/f ; echo z > d1/only ; diff d1 d2", "diff d1/f d2/f\n1c1\n< x\n---\n> y\nOnly in d1: only\n[1]"],
  ["printf 'a b\\n' > d1 ; printf 'a  b\\n' > d2 ; diff -b d1 d2 ; echo $?", "0\n[0]"],
  ["printf 'a b\\n' > d1 ; printf 'a  b\\n' > d2 ; diff -w d1 d2 ; echo $?", "0\n[0]"],
  ["printf 'a b\\n' > d1 ; printf 'ab\\n' > d2 ; diff -w d1 d2 ; echo $?", "0\n[0]"],
  ["printf 'a\\0b\\n' > bin1 ; printf 'a\\0c\\n' > bin2 ; diff -a bin1 bin2 | od -c | head -3", "0000000   1   c   1  \\n   <       a  \\0   b  \\n   -   -   -  \\n   >    \n0000020   a  \\0   c  \\n\n0000024\n[0]"],
  ["printf 'a\\0b\\n' > bin1 ; printf 'a\\0c\\n' > bin2 ; diff -q bin1 bin2", "Files bin1 and bin2 differ\n[1]"],
  ["printf 'a\\0b\\n' > bin1 ; printf 'a\\0c\\n' > bin2 ; diff -s bin1 bin1", "Files bin1 and bin1 are identical\n[0]"],
  ["printf 'a\\0b\\n' > bin1 ; printf 'a\\0c\\n' > bin2 ; diff -u bin1 bin2", "Binary files bin1 and bin2 differ\n[1]"],
  ["printf 'a\\0b\\n' > bin1 ; printf 'a\\0c\\n' > bin2 ; diff bin1 a.txt", "Binary files bin1 and a.txt differ\n[1]"],
  ["printf 'a\\0b\\n' > bin1 ; printf 'a\\0c\\n' > bin2 ; diff bin1 bin2", "Binary files bin1 and bin2 differ\n[1]"],
  ["printf 'a\\0b\\n' > d1 ; printf 'a\\0c\\n' > d2 ; diff -a d1 d2 | od -c | head -2", "0000000   1   c   1  \\n   <       a  \\0   b  \\n   -   -   -  \\n   >    \n0000020   a  \\0   c  \\n\n[0]"],
  ["printf 'a\\0b\\n' > d1 ; printf 'a\\0c\\n' > d2 ; diff d1 d2", "Binary files d1 and d2 differ\n[1]"],
  ["printf 'a\\n\\n\\nb\\n' > d1 ; printf 'a\\nb\\n' > d2 ; diff -B d1 d2 ; echo $?", "0\n[0]"],
  ["printf 'a\\nb' > n1 ; printf 'a\\nb\\n' > n2 ; diff -D X n1 n2", "a\n#ifndef X\nb\n#else /* X */\nb\n#endif /* X */\n[1]"],
  ["printf 'a\\nb' > n1 ; printf 'a\\nb\\n' > n2 ; diff -c n1 n2 | tail -n +3", "***************\n*** 1,2 ****\n  a\n! b\n\\ No newline at end of file\n--- 1,2 ----\n  a\n! b\n[0]"],
  ["printf 'a\\nb' > n1 ; printf 'a\\nb\\n' > n2 ; diff -u n1 n2 | tail -n +3", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n[0]"],
  ["printf 'a\\nb' > n1 ; printf 'a\\nb\\n' > n2 ; diff n1 n2", "2c2\n< b\n\\ No newline at end of file\n---\n> b\n[1]"],
  ["printf 'a\\nb' > n1 ; printf 'a\\nc' > n3 ; diff n1 n3", "2c2\n< b\n\\ No newline at end of file\n---\n> c\n\\ No newline at end of file\n[1]"],
  ["printf 'a\\nb\\nc' > d1 ; printf 'a\\nb\\nc\\n' > d2 ; diff d1 d2", "3c3\n< c\n\\ No newline at end of file\n---\n> c\n[1]"],
  ["printf 'a\\nb\\nc\\n' > d1 ; printf 'A\\nB\\nC\\n' > d2 ; diff -i d1 d2 ; echo $?", "0\n[0]"],
  ["printf 'a\\nb\\nc\\n' > d1 ; printf 'a\\nb\\nc\\nd\\ne\\n' > d2 ; diff d1 d2", "3a4,5\n> d\n> e\n[1]"],
  ["printf 'a\\nb\\nc\\n' > d1 ; printf 'a\\nc\\n' > d2 ; diff d1 d2", "2d1\n< b\n[1]"],
  ["printf 'a\\nb\\nc\\n' > d1 ; printf 'a\\nx\\nc\\n' > d2 ; diff -c d1 d2 | tail -n +3", "***************\n*** 1,3 ****\n  a\n! b\n  c\n--- 1,3 ----\n  a\n! x\n  c\n[0]"],
  ["printf 'a\\nb\\nc\\n' > d1 ; printf 'a\\nx\\nc\\n' > d2 ; diff -e d1 d2", "2c\nx\n.\n[1]"],
  ["printf 'a\\nb\\nc\\n' > d1 ; printf 'a\\nx\\nc\\n' > d2 ; diff -u d1 d2 | tail -n +3", "@@ -1,3 +1,3 @@\n a\n-b\n+x\n c\n[0]"],
  ["printf 'a\\nb\\nc\\n' > d1 ; printf 'a\\nx\\nc\\n' > d2 ; diff -y d1 d2", "a\t\t\t\t\t\t\t\ta\nb\t\t\t\t\t\t\t      |\tx\nc\t\t\t\t\t\t\t\tc\n[1]"],
  ["printf 'a\\nb\\nc\\n' > d1 ; printf 'a\\nx\\nc\\n' > d2 ; diff d1 d2", "2c2\n< b\n---\n> x\n[1]"],
  ["printf 'a\\r\\n' > d1 ; printf 'a\\n' > d2 ; diff --strip-trailing-cr d1 d2 ; echo $?", "0\n[0]"],
  ["printf 'a\\r\\nb\\r\\n' > cr1 ; printf 'a\\nb\\n' > cr2 ; diff --strip-trailing-cr cr1 cr2 ; echo $?", "0\n[0]"],
  ["printf 'a\\r\\nb\\r\\n' > cr1 ; printf 'a\\nb\\n' > cr2 ; diff cr1 cr2 | cat -A", "1,2c1,2$\n< a^M$\n< b^M$\n---$\n> a$\n> b$\n[0]"],
  ["printf 'a\\r\\nb\\r\\n' > cr1 ; printf 'a\\nc\\n' > cr2 ; diff --strip-trailing-cr cr1 cr2 | cat -A", "2c2$\n< b$\n---$\n> c$\n[0]"],
  ["printf 'int f() {\\n  a;\\n  b;\\n}\\nint g() {\\n  c;\\n  d;\\n  e;\\n}\\n' > p1 ; sed 's/d;/D;/' p1 > p2 ; diff -c -p p1 p2 | tail -n +3", "*************** int f() {\n*** 4,9 ****\n  }\n  int g() {\n    c;\n!   d;\n    e;\n  }\n--- 4,9 ----\n  }\n  int g() {\n    c;\n!   D;\n    e;\n  }\n[0]"],
  ["printf 'int f() {\\n  a;\\n  b;\\n}\\nint g() {\\n  c;\\n  d;\\n  e;\\n}\\n' > p1 ; sed 's/d;/D;/' p1 > p2 ; diff -u -F '^int' p1 p2 | tail -n +3", "@@ -4,6 +4,6 @@ int f() {\n }\n int g() {\n   c;\n-  d;\n+  D;\n   e;\n }\n[0]"],
  ["printf 'int f() {\\n  a;\\n  b;\\n}\\nint g() {\\n  c;\\n  d;\\n  e;\\n}\\n' > p1 ; sed 's/d;/D;/' p1 > p2 ; diff -u -p p1 p2 | tail -n +3", "@@ -4,6 +4,6 @@ int f() {\n }\n int g() {\n   c;\n-  d;\n+  D;\n   e;\n }\n[0]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --changed-group-format='<<%<%>>>' a1 b1", "one\n<<two\n2\n>>three\n<<four\nfive\nfour2\nsix\nseven\n>>[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --group-format='G(%<|%>|%=)' a1 b1", "diff: unrecognized option '--group-format=G(%<|%>|%=)'\ndiff: Try 'diff --help' for more information.\n[2]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --ifdef=BAR b1 a1", "one\n#ifndef BAR\n2\n#else /* BAR */\ntwo\n#endif /* BAR */\nthree\n#ifndef BAR\nfour2\nsix\nseven\n#else /* BAR */\nfour\nfive\n#endif /* BAR */\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --line-format=\"%c'\\\\n'x\" a1 b1", "%c'\\n'x%c'\\n'x%c'\\n'x%c'\\n'x%c'\\n'x%c'\\n'x%c'\\n'x%c'\\n'x%c'\\n'x[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --line-format='%3dn:%l;' a1 b1", "  1:one;  2:two;  2:2;  3:three;  4:four;  5:five;  4:four2;  5:six;  6:seven;[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --line-format='[%l]' a1 b1", "[one][two][2][three][four][five][four2][six][seven][1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --old-group-format='OLD %df-%dl\\n' --new-group-format='NEW %dF-%dL %dn %dN\\n' --unchanged-group-format='' a1 b1", "OLD 2-2\\nNEW 2-2 1 1\\nOLD 4-5\\nNEW 4-6 2 3\\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --old-line-format='<%L' --new-line-format='>%L' --unchanged-line-format='=%L' a1 b1", "=one\n<two\n>2\n=three\n<four\n<five\n>four2\n>six\n>seven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff --unchanged-group-format='U%dn-%de|' --changed-group-format='C%<%>' a1 b1", "U1-0|Ctwo\n2\nU1-2|Cfour\nfive\nfour2\nsix\nseven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -D FOO a1 b1", "one\n#ifndef FOO\ntwo\n#else /* FOO */\n2\n#endif /* FOO */\nthree\n#ifndef FOO\nfour\nfive\n#else /* FOO */\nfour2\nsix\nseven\n#endif /* FOO */\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -e a1 b1", "4,5c\nfour2\nsix\nseven\n.\n2c\n2\n.\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -e b1 a1", "4,6c\nfour\nfive\n.\n2c\ntwo\n.\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -n a1 b1", "d2 1\na2 1\n2\nd4 2\na5 3\nfour2\nsix\nseven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -y --left-column -W 40 a1 b1", "one\t\t   (\ntwo\t\t   |\t2\nthree\t\t   (\nfour\t\t   |\tfour2\nfive\t\t   |\tsix\n\t\t   >\tseven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -y --suppress-common-lines -W 40 a1 b1", "two\t\t   |\t2\nfour\t\t   |\tfour2\nfive\t\t   |\tsix\n\t\t   >\tseven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -y -W 100 -T a1 b1", "one\t\t\t\t\t\tone\ntwo\t\t\t\t\t      |\t2\nthree\t\t\t\t\t\tthree\nfour\t\t\t\t\t      |\tfour2\nfive\t\t\t\t\t      |\tsix\n\t\t\t\t\t      >\tseven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -y -W 40 a1 b1", "one\t\t\tone\ntwo\t\t   |\t2\nthree\t\t\tthree\nfour\t\t   |\tfour2\nfive\t\t   |\tsix\n\t\t   >\tseven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -y -W 80 a1 b1", "one\t\t\t\t\tone\ntwo\t\t\t\t      |\t2\nthree\t\t\t\t\tthree\nfour\t\t\t\t      |\tfour2\nfive\t\t\t\t      |\tsix\n\t\t\t\t      >\tseven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -y -t -W 40 a1 b1", "one                   one\ntwo                |  2\nthree                 three\nfour               |  four2\nfive               |  six\n                   >  seven\n[1]"],
  ["printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > a1 ; printf 'one\\n2\\nthree\\nfour2\\nsix\\nseven\\n' > b1 ; diff -y a1 b1", "one\t\t\t\t\t\t\t\tone\ntwo\t\t\t\t\t\t\t      |\t2\nthree\t\t\t\t\t\t\t\tthree\nfour\t\t\t\t\t\t\t      |\tfour2\nfive\t\t\t\t\t\t\t      |\tsix\n\t\t\t\t\t\t\t      >\tseven\n[1]"],
  ["printf '' | xargs echo", "\n[0]"],
  ["printf '' | xargs -r echo", "[0]"],
  ["printf 'a b c\\n' | xargs -d ' ' echo", "a b c\n\n[0]"],
  ["printf 'aaa bbb ccc ddd\\n' | xargs -s 12 echo", "aaa\nbbb\nccc\nddd\n[0]"],
  ["printf 'aaaaaaaaaaaaaaaaaaaa\\n' | xargs -s 10 echo", "xargs: argument line too long\n[1]"],
  ["printf 'a b c\\n' | xargs -x -n2 echo", "a b\nc\n[0]"],
  ["printf 'a\\n' | xargs --replace echo X{}Y", "XaY\n[0]"],
  ["printf 'a b c d e f\\n' | xargs -n3 -s 10 echo", "a b\nc d\ne f\n[0]"],
  ["printf 'a b c d e f\\n' | xargs -n3 -x -s 9 echo", "xargs: argument list too long\n[1]"],
  ["printf 'a b c d e f\\n' | xargs -n3 -x -s 11 echo", "a b c\nd e f\n[0]"],
  ["printf 'a b\\nc d\\n' | xargs -L2 -s 9 echo", "xargs: argument list too long\n[1]"],
  ["printf 'a b\\nc d\\n' | xargs -L1 -s 9 echo", "a b\nc d\n[0]"],
  ["printf 'a b\\nc d\\n' | xargs -s 8 -L1 echo", "xargs: argument list too long\n[1]"],
  ["printf 'abc\\n' | xargs -I{} -s 9 echo {}-{}", "xargs: argument list too long\n[1]"],
  ["printf 'a\\nb\\n' | xargs -I{} -s 7 echo {}", "a\nb\n[0]"],
  ["printf 'a b c\\n' | xargs -x -s 4 echo", "xargs: cannot fit single argument within argument list size limit\n[1]"],
  ["printf 'a\\n' | xargs -s 4 echo", "xargs: cannot fit single argument within argument list size limit\n[1]"],
  ["printf 'a\\n' | xargs -s 5 echo", "xargs: argument line too long\n[1]"],
  ["printf 'a b c d e f\\n' | xargs -s 9 echo", "a b\nc d\ne f\n[0]"],
  ["printf 'a\\n' | xargs -s 0 echo", "xargs: value 0 for -s option should be >= 1\nxargs: cannot fit single argument within argument list size limit\n[1]"],
  ["printf 'a b\\nc\\n' | xargs -I{} -n1 echo X{}", "Xa b\nXc\n[0]"],
  ["printf 'a\\n' | xargs -I '' echo X", "xargs: command too long\n[1]"],
  ["printf '' | xargs -I{} echo x", "[0]"],
  ["printf '' | xargs -n1 echo x", "x\n[0]"],
  ["printf 'a\\n' | xargs -a /nonexistent echo", "xargs: Cannot open input file '/nonexistent': No such file or directory\n[1]"],
];

describe('coreutils batch 6 evaluates the options it accepts', () => {
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
