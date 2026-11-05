/*
 * md5sum, sha1sum and sha256sum were a 40-line copy in the executor (two-space output, an `OK`/`FAILED`
 * check, no -b/-t/--tag/-z/--quiet/--status/--warn/--strict/--ignore-missing, no name escaping, no
 * permission check), sha224sum, sha384sum, sha512sum and b2sum did not exist and `sum` did not
 * exist. They now run on the engine of cksum (one digest table, one check loop): untagged
 * output with the `*` binary marker, --tag, the backslash escaping of names, -c with tagged and
 * plain lines whose digest length must fit the algorithm (b2sum takes it from the line),
 * --warn/--strict/--quiet/--status/--ignore-missing, the "meaningful only when verifying"
 * refusals, b2sum -l, and `sum` with -r/-s. cksum itself gained -w and the same name escaping.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by
 * running the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch
 * directory rewritten to /tmp/ff). NOT covered, because the machines differ: the version banner,
 * and the stderr of an earlier command of a `;` list, which the harness of the real side drops.
 *
 * Measured against the commit before (worktree): 81 cases; at the commit before 58 fall
 * (the sha-family, b2 and sum commands did not exist, md5sum lacked every option); the other 23 pass
 * either way as witnesses (plain digests of a file and of standard input, --help text, exit statuses).
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
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a b", "b1946ac92492d2347c6235b4d2611184  a\n7d793037a0760186574b0282f2f435e7  b\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -b a", "b1946ac92492d2347c6235b4d2611184 *a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -t a", "b1946ac92492d2347c6235b4d2611184  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --tag a b", "MD5 (a) = b1946ac92492d2347c6235b4d2611184\nMD5 (b) = 7d793037a0760186574b0282f2f435e7\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --tag -b a", "MD5 (a) = b1946ac92492d2347c6235b4d2611184\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a - < a", "b1946ac92492d2347c6235b4d2611184  a\nb1946ac92492d2347c6235b4d2611184  -\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum d", "md5sum: d: Is a directory\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum nofile", "md5sum: nofile: No such file or directory\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum e", "d41d8cd98f00b204e9800998ecf8427e  e\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum 'we ird'", "401b30e3b8b5d629635a5c613cdb7919  we ird\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum nl*", "\\009520053b00386d1173f3988c55d192  nl\\nx\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum 'back\\slash'", "\\a8a78d0ff555c931f045b6f448129846  back\\\\slash\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --tag nl*", "\\MD5 (nl\\nx) = 009520053b00386d1173f3988c55d192\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -z a | od -c | head -2", "0000000   b   1   9   4   6   a   c   9   2   4   9   2   d   2   3   4\n0000020   7   c   6   2   3   5   b   4   d   2   6   1   1   1   8   4\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a > s.md5; md5sum -c s.md5", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a b > s.md5; md5sum -c s.md5; echo $?; md5sum --quiet -c s.md5; md5sum --status -c s.md5; echo $?", "a: OK\nb: OK\n0\n0\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; printf 'bad line\\n' > s.md5; md5sum -c s.md5", "md5sum: s.md5: no properly formatted checksum lines found\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; printf 'bad line\\n' > s.md5; md5sum -c --warn s.md5", "md5sum: s.md5: 1: improperly formatted MD5 checksum line\nmd5sum: s.md5: no properly formatted checksum lines found\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; printf 'bad line\\n' > s.md5; md5sum -c --strict s.md5", "md5sum: s.md5: no properly formatted checksum lines found\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --tag a > s.md5; md5sum -c s.md5", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -b a > s.md5; md5sum -c s.md5", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -c nofile", "md5sum: nofile: No such file or directory\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -c", "md5sum: 'standard input': no properly formatted checksum lines found\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a | md5sum -c", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --bogus", "md5sum: unrecognized option '--bogus'\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -x", "md5sum: invalid option -- 'x'\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha256sum a", "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha512sum a", "e7c22b994c59d9cf2b48e549b1e24666636045930d3da7c1acb299d1c3b7f931f94aae41edda2c2b207a36e10f8bcb8d45223e54878f5b316e7ce3b6bc019629  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha384sum a", "1d0f284efe3edea4b9ca3bd514fa134b17eae361ccc7a1eefeff801b9bd6604e01f21f6bf249ef030599f0c218f2ba8c  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha224sum a", "2d6d67d91d0badcdd06cbbba1fe11538a68a37ec9c2e26457ceff12b  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha1sum a", "f572d396fae9206628714fb2ce00f72e94f2258f  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum a", "f60ce482e5cc1229f39d71313171a8d9f4ca3a87d066bf4b205effb528192a75f14f3271e2c1a90e1de53f275b4d4793eef2f5e31ea90d2ce29d2e481c36435f  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum -l 256 a", "93becc6e9882211c3ec3708c95bcd69baab7bb59c7f4bc84ce637b88a534b783  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum --tag -l 256 a", "BLAKE2b-256 (a) = 93becc6e9882211c3ec3708c95bcd69baab7bb59c7f4bc84ce637b88a534b783\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum -l 7 a", "b2sum: invalid length: '7'\nb2sum: length is not a multiple of 8\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum -l 1024 a", "b2sum: invalid length: '1024'\nb2sum: maximum digest length for 'BLAKE2b' is 512 bits\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum -l x a", "b2sum: invalid length: 'x'\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -l 5 a", "md5sum: invalid option -- 'l'\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum a", "36979     1 a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum -r a", "36979     1 a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum -s a", "542 1 a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum a b", "36979     1 a\n53451     1 b\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum --sysv a", "542 1 a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum --bsd a", "sum: unrecognized option '--bsd'\nTry 'sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum nofile", "sum: nofile: No such file or directory\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum", "00000     0\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; echo hi | sum", "32856     1\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; echo hi | sum -s -", "219 1 -\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; echo hi | md5sum -", "764efa883dda1e11db47671c4a3bbd9e  -\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; echo hi | md5sum", "764efa883dda1e11db47671c4a3bbd9e  -\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --zero a b | od -c | head -3", "0000000   b   1   9   4   6   a   c   9   2   4   9   2   d   2   3   4\n0000020   7   c   6   2   3   5   b   4   d   2   6   1   1   1   8   4\n0000040           a  \\0   7   d   7   9   3   0   3   7   a   0   7   6\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -c --tag a", "md5sum: the --tag option is meaningless when verifying checksums\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --check --check a", "md5sum: a: no properly formatted checksum lines found\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -bt a", "b1946ac92492d2347c6235b4d2611184  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --untagged a", "md5sum: unrecognized option '--untagged'\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha256sum --tag --untagged a", "sha256sum: unrecognized option '--untagged'\nTry 'sha256sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha1sum --raw a", "sha1sum: unrecognized option '--raw'\nTry 'sha1sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a a", "b1946ac92492d2347c6235b4d2611184  a\nb1946ac92492d2347c6235b4d2611184  a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -- -a", "md5sum: -a: No such file or directory\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --quiet a", "md5sum: the --quiet option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --status a", "md5sum: the --status option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --warn a", "md5sum: the --warn option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --strict a", "md5sum: the --strict option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum --ignore-missing a", "md5sum: the --ignore-missing option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum -w a", "md5sum: the --warn option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha256sum -c --quiet nofile", "sha256sum: nofile: No such file or directory\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha512sum a > s.sum ; sha512sum -c s.sum", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha512sum --tag a > s.sum ; sha512sum -c s.sum", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha512sum --tag a > s.sum ; sha256sum -c s.sum", "sha256sum: s.sum: no properly formatted checksum lines found\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sha256sum a > s.sum ; sha512sum -c s.sum", "sha512sum: s.sum: no properly formatted checksum lines found\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum --tag a > s.sum ; b2sum -c s.sum", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum -l 256 --tag a > s.sum ; b2sum -c s.sum", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum -l 256 a > s.sum ; b2sum -l 256 -c s.sum", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; b2sum -l 256 a > s.sum ; b2sum -c s.sum", "a: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a b > s.md5 ; echo more >> b ; md5sum -c --status s.md5 ; echo $?", "1\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a b > s.md5 ; rm b ; md5sum -c --ignore-missing s.md5 ; echo $?", "a: OK\n0\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a > s1.md5 ; md5sum b > s2.md5 ; md5sum -c s1.md5 s2.md5", "a: OK\nb: OK\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; echo 'garbage' | md5sum -c", "md5sum: 'standard input': no properly formatted checksum lines found\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; md5sum a > s.md5 ; sed -i 's/ a/ ./' s.md5 ; md5sum -c s.md5", "md5sum: .: Is a directory\n.: FAILED open or read\nmd5sum: WARNING: 1 listed file could not be read\n[1]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum -rs a", "542 1 a\n[0]"],
  ["printf 'hello\\n' > a ; printf 'world' > b ; : > e ; mkdir -p d ; printf 'x\\n' > 'we ird' ; printf 'y\\n' > \"$(printf 'nl\\nx')\" ; printf 'z\\n' > 'back\\slash' ; sum -sr a", "36979     1 a\n[0]"],
];

describe('the checksum commands follow GNU coreutils', () => {
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
