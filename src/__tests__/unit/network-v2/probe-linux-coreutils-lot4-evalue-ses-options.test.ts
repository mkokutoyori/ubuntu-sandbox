/*
 * base64, cksum, cmp and fmt accepted options they did not evaluate and answered every failure at status 0 with the message on stdout: `base64 -d` swallowed invalid input and a second operand, `cksum` knew only the POSIX CRC (no -a, --tag, --untagged, --raw, -c, blake2b, sm3), `cmp` ignored -l -b -i -n and exited 0 on usage errors, and `fmt` flattened every paragraph (-p -t -c -s -u -g -w and the optimal line-breaking of GNU fmt were absent; it is now a port of fmt.c from coreutils 9.4).
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev
 * container on the same files, by running the identical line in bash with
 * LC_ALL=C.UTF-8; typographic quotes are normalised on both sides and the scratch
 * directory is rewritten to /tmp/ff. NOT covered, because the machines differ: the
 * version banner, `--help`, `ls` column layout (the harness terminal is not a pipe),
 * the order of a diagnostic against the output of a pipe, multibyte `fold -w` columns
 * and `split --filter` with several pieces (see TODO.md).
 *
 * Measured against the commit before (worktree): 96 cases, 68 fall; the 28 that pass either way are the plain invocations (base64 encode, cksum default, cmp of identical files, fmt of one short paragraph) and serve as the witness that the lab is sound.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/[‘’]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["base64 --bogus words", "base64: unrecognized option '--bogus'\nTry 'base64 --help' for more information.\n[1]"],
  ["base64 --ignore-garbage a.txt", "aGkK\n[0]"],
  ["base64 --wrap=5 a.txt", "aGkK\n[0]"],
  ["base64 -w -1 words", "base64: invalid wrap size: '-1'\n[1]"],
  ["base64 -w 10 words", "Zm9vIGJhcg\npiYXogcXV4\nCkZvbyBCQV\nIKaGVsbG8g\nd29ybGQKYm\nF6IHF1eApi\nYXogcXV4Cn\no6eTp4Cg==\n[0]"],
  ["base64 -w abc words", "base64: invalid wrap size: 'abc'\n[1]"],
  ["base64 -w0 words", "Zm9vIGJhcgpiYXogcXV4CkZvbyBCQVIKaGVsbG8gd29ybGQKYmF6IHF1eApiYXogcXV4Cno6eTp4Cg==[0]"],
  ["base64 a.txt words", "base64: extra operand 'words'\nTry 'base64 --help' for more information.\n[1]"],
  ["base64 nofile", "base64: nofile: No such file or directory\n[1]"],
  ["base64 words", "Zm9vIGJhcgpiYXogcXV4CkZvbyBCQVIKaGVsbG8gd29ybGQKYmF6IHF1eApiYXogcXV4Cno6eTp4\nCg==\n[0]"],
  ["cksum --bogus words", "cksum: unrecognized option '--bogus'\nTry 'cksum --help' for more information.\n[1]"],
  ["cksum --raw a.txt | od -c", "0000000   X   5   3   J\n0000004\n[0]"],
  ["cksum -a blake2b -l 12 a.txt", "cksum: invalid length: '12'\ncksum: length is not a multiple of 8\n[1]"],
  ["cksum -a blake2b -l 256 a.txt", "BLAKE2b-256 (a.txt) = de9543b2ae1b2b87434a730727db17f5ac8b8c020b84a5cb8c5fbcc1423443ba\n[0]"],
  ["cksum -a blake2b -l 8 big", "BLAKE2b-8 (big) = a7\n[0]"],
  ["cksum -a blake2b a.txt", "BLAKE2b (a.txt) = 7ea59e7a000ec003846b6607dfd5f9217b681dc1a81b0789b464c3995105d93083f7f0a86fca01a1bed27e9f9303ae58d01746e3b20443480bea56198e65bfc5\n[0]"],
  ["cksum -a blake2b big", "BLAKE2b (big) = 98668be3bac0df6722e0f1d0d1ec17c0b1042508c53681c78d87c06d0d20279018f10369baef8a9909935852415d363352d19a878b28d0c60eac7e17dea6ce9e\n[0]"],
  ["cksum -a bogus a.txt", "cksum: invalid argument 'bogus' for '--algorithm'\nValid arguments are:\n  - 'bsd'\n  - 'sysv'\n  - 'crc'\n  - 'md5'\n  - 'sha1'\n  - 'sha224'\n  - 'sha256'\n  - 'sha384'\n  - 'sha512'\n  - 'blake2b'\n  - 'sm3'\nTry 'cksum --help' for more information.\n[1]"],
  ["cksum -a bsd --raw a.txt | od -c", "0000000 200   X\n0000002\n[0]"],
  ["cksum -a bsd big", "05357     3 big\n[0]"],
  ["cksum -a bsd words", "28412     1 words\n[0]"],
  ["cksum -a crc --tag a.txt", "1479881546 3 a.txt\n[0]"],
  ["cksum -a crc words", "785891321 58 words\n[0]"],
  ["cksum -a md5 --tag a.txt", "MD5 (a.txt) = 764efa883dda1e11db47671c4a3bbd9e\n[0]"],
  ["cksum -a md5 --untagged -b a.txt", "764efa883dda1e11db47671c4a3bbd9e *a.txt\n[0]"],
  ["cksum -a md5 --untagged a.txt", "764efa883dda1e11db47671c4a3bbd9e  a.txt\n[0]"],
  ["cksum -a md5 -l 8 a.txt", "cksum: --length is only supported with --algorithm=blake2b\n[1]"],
  ["cksum -a md5 words", "MD5 (words) = 9b1b2a85f67bfd434a3507ea90790ab8\n[0]"],
  ["cksum -a sha1 words nums", "SHA1 (words) = 0dbc1cf0cbc26a102910ae6475bc95d050ee94b9\nSHA1 (nums) = 612ca68d0305c821750a452e9d5bf050e915824f\n[0]"],
  ["cksum -a sha224 a.txt", "SHA224 (a.txt) = 0689e590864cee67b037c8f4c390a75a192bb01160cc9c21374afb12\n[0]"],
  ["cksum -a sha256 a.txt", "SHA256 (a.txt) = 98ea6e4f216f2fb4b69fff9b3a44842c38686ca685f3f55dc48c5d3fb1107be4\n[0]"],
  ["cksum -a sha384 a.txt", "SHA384 (a.txt) = 4284b5694ca6c0d2cf4789a0b95ac8025c818de52304364be7cd2981b2d2edc685b322277ec25819962413d8c9b2c1f5\n[0]"],
  ["cksum -a sha512 a.txt", "SHA512 (a.txt) = d78abb0542736865f94704521609c230dac03a2f369d043ac212d6933b91410e06399e37f9c5cc88436a31737330c1c8eccb2c2f9f374d62f716432a32d50fac\n[0]"],
  ["cksum -a sm3 a.txt", "SM3 (a.txt) = 2934aeb13ac00cce1ec3ae6a023744450c93852811eee4c2e33cf42605d39a82\n[0]"],
  ["cksum -a sm3 big", "SM3 (big) = 39b4c122b0c1b549cd3051923b12e374ea5638b23acf99def7793c55103964d3\n[0]"],
  ["cksum -a sysv big", "32325 6 big\n[0]"],
  ["cksum -a sysv words", "4964 1 words\n[0]"],
  ["cksum -c nofile", "cksum: nofile: No such file or directory\n[1]"],
  ["cksum -c words", "cksum: words: no properly formatted checksum lines found\n[1]"],
  ["cksum big", "1370179171 3000 big\n[0]"],
  ["cksum nofile", "cksum: nofile: No such file or directory\n[1]"],
  ["cksum words", "785891321 58 words\n[0]"],
  ["cksum words nums", "785891321 58 words\n944657915 21 nums\n[0]"],
  ["cmp", "cmp: missing operand after 'cmp'\ncmp: Try 'cmp --help' for more information.\n[2]"],
  ["cmp --bogus a.txt words", "cmp: unrecognized option '--bogus'\ncmp: Try 'cmp --help' for more information.\n[2]"],
  ["cmp --bogus words nums", "cmp: unrecognized option '--bogus'\ncmp: Try 'cmp --help' for more information.\n[2]"],
  ["cmp -b words nums", "words nums differ: byte 1, line 1 is 146 f  61 1\n[1]"],
  ["cmp -i -1 words nums", "cmp: invalid --ignore-initial value '-1'\ncmp: Try 'cmp --help' for more information.\n[2]"],
  ["cmp -i 1 words nums", "words nums differ: byte 1, line 1\n[1]"],
  ["cmp -i 100 words nums ; echo $?", "0\n[0]"],
  ["cmp -i 3 words nums", "words nums differ: byte 1, line 1\n[1]"],
  ["cmp -i 3:4 words nums", "words nums differ: byte 1, line 1\n[1]"],
  ["cmp -n 2 words nums ; echo $?", "words nums differ: byte 1, line 1\n1\n[0]"],
  ["cmp -n 5 words nums ; echo $?", "words nums differ: byte 1, line 1\n1\n[0]"],
  ["cmp -n x words nums", "cmp: invalid --bytes value 'x'\ncmp: Try 'cmp --help' for more information.\n[2]"],
  ["cmp -s nofile words ; echo $?", "2\n[0]"],
  ["cmp -s words nums ; echo $?", "1\n[0]"],
  ["cmp -z words nums", "cmp: invalid option -- 'z'\ncmp: Try 'cmp --help' for more information.\n[2]"],
  ["cmp a.txt a.txt ; echo $?", "0\n[0]"],
  ["cmp words", "cmp: EOF on - which is empty\n[1]"],
  ["cmp words /nonexist", "cmp: /nonexist: No such file or directory\n[2]"],
  ["cmp words nofile", "cmp: nofile: No such file or directory\n[2]"],
  ["cmp words nums", "words nums differ: byte 1, line 1\n[1]"],
  ["cmp words words", "[0]"],
  ["cmp words words words", "cmp: invalid --ignore-initial value 'words'\ncmp: Try 'cmp --help' for more information.\n[2]"],
  ["fmt -g 5 words", "foo bar\nbaz qux\nFoo BAR\nhello world\nbaz qux\nbaz qux z:y:x\n[0]"],
  ["fmt -s words", "foo bar\nbaz qux\nFoo BAR\nhello world\nbaz qux\nbaz qux\nz:y:x\n[0]"],
  ["fmt -u words", "foo bar baz qux Foo BAR hello world baz qux baz qux z:y:x\n[0]"],
  ["fmt -w 5 words", "foo\nbar\nbaz\nqux\nFoo\nBAR\nhello\nworld\nbaz\nqux\nbaz\nqux\nz:y:x\n[0]"],
  ["printf '  indented first line\\n    and second\\n    third more words here\\n' | fmt -c -w 20", "  indented first\n    line and second\n    third more\n    words here\n[0]"],
  ["printf '  indented first line\\n    and second\\n    third more words here\\n' | fmt -w 20", "  indented first\n  line\n    and second\n    third more\n    words here\n[0]"],
  ["printf '  tag: first line words\\n    second line of words here\\n    third\\n' | fmt -t -w 20", "  tag: first line\n    words second\n    line of words\n    here third\n[0]"],
  ["printf '# comment line one two three\\n# line two\\nplain line\\n' | fmt -p '#' -w 15", "# comment\n# line one\n# two three\n# line two\nplain line\n[0]"],
  ["printf '' > z0 ; cmp words z0", "cmp: EOF on z0 which is empty\n[1]"],
  ["printf '' > z0 ; cmp z0 words", "cmp: EOF on z0 which is empty\n[1]"],
  ["printf '' > z0 ; cmp z0 z0 ; echo $?", "0\n[0]"],
  ["printf '' | base64", "[0]"],
  ["printf '' | cksum", "4294967295 0\n[0]"],
  ["printf '' | fmt", "[0]"],
  ["printf '(first) paragraph. (second) sentence! \"Third?\" fourth\\n' | fmt -w 15", "(first)\nparagraph.\n(second)\nsentence!\n\"Third?\"\nfourth\n[0]"],
  ["printf '> quoted text here and more words to wrap\\n> second quoted line\\n' | fmt -p '>' -w 20", "> quoted text here\n> and more words\n> to wrap second\n> quoted line\n[0]"],
  ["printf 'Mr. Smith went to Washington. He said hello (loudly) to everyone he met there.\\n' | fmt -w 25", "Mr. Smith went to\nWashington. He said\nhello (loudly) to\neveryone he met there.\n[0]"],
  ["printf 'The quick brown fox jumps over the lazy dog. It was a bright cold day in April, and the clocks were striking thirteen.  Winston Smith slipped quickly through the glass doors.\\n' | fmt -w 40 -g 20", "The quick brown fox\njumps over the lazy\ndog. It was a bright\ncold day in April,\nand the clocks were\nstriking thirteen.\nWinston Smith slipped\nquickly through the glass doors.\n[0]"],
  ["printf 'The quick brown fox jumps over the lazy dog. It was a bright cold day in April, and the clocks were striking thirteen.  Winston Smith slipped quickly through the glass doors.\\n\\nSecond paragraph here. Short.\\n' | fmt", "The quick brown fox jumps over the lazy dog. It was a bright cold day\nin April, and the clocks were striking thirteen.  Winston Smith slipped\nquickly through the glass doors.\n\nSecond paragraph here. Short.\n[0]"],
  ["printf 'The quick brown fox jumps over the lazy dog. It was a bright cold day in April, and the clocks were striking thirteen.  Winston Smith slipped quickly through the glass doors.\\n\\nSecond paragraph here. Short.\\n' | fmt -w 30", "The quick brown fox jumps\nover the lazy dog. It was\na bright cold day in April,\nand the clocks were striking\nthirteen.  Winston Smith\nslipped quickly through the\nglass doors.\n\nSecond paragraph here. Short.\n[0]"],
  ["printf 'The quick brown fox jumps over the lazy dog. It was a bright cold day in April, and the clocks were striking thirteen.\\n' | fmt -s -w 30", "The quick brown fox jumps\nover the lazy dog. It was\na bright cold day in April,\nand the clocks were striking\nthirteen.\n[0]"],
  ["printf 'The quick brown fox. Jumps over.\\n' | fmt -u -w 12", "The quick\nbrown\nfox. Jumps\nover.\n[0]"],
  ["printf 'a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l m n o p q r s t u v w x y z\\n' | fmt -w 20", "a b c d e f g h i\nj k l m n o p q r\ns t u v w x y z a\nb c d e f g h i j\nk l m n o p q r s\nt u v w x y z\n[0]"],
  ["printf 'a b c d e f g h i j k l m n o p q r s t u v w x y z\\n' | fmt -30", "a b c d e f g h i j k l m n\no p q r s t u v w x y z\n[0]"],
  ["printf 'a b c\\n' | fmt -g 100 -w 50", "fmt: invalid width: '100': Numerical result out of range\n[1]"],
  ["printf 'a b c\\n' | fmt -w 3000", "fmt: invalid width: '3000': Numerical result out of range\n[1]"],
  ["printf 'a\\tb\\tc  d\\n' | fmt", "a\tb\tc  d\n[0]"],
  ["printf 'abc' | cksum", "1219131554 3\n[0]"],
  ["printf 'abc' | cmp - words", "- words differ: byte 1, line 1\n[1]"],
  ["printf 'word\\n' | fmt -w 2", "word\n[0]"],
  ["printf 'x\\n\\n\\n\\ny\\n' | fmt", "x\n\n\n\ny\n[0]"],
];

describe('coreutils batch 4 evaluates the options it accepts', () => {
  it.each(CASES)('%s', async (line, expected) => {
    const machine = await lab();
    await machine.executeCommand(`cd /tmp/ff; chmod -R u+rwx /tmp/ff; rm -rf /tmp/ff/*; ${SETUP}`);
    const answer = await machine.executeCommand(`cd /tmp/ff; ${line} 2>&1; echo "[$?]"`);
    expect(normalise(answer)).toBe(expected);
  });
});

