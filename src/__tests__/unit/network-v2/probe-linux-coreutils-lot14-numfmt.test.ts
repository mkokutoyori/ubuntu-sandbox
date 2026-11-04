/*
 * numfmt answered `command not found`. NumfmtCommand.ts follows numfmt.c 9.4 (fetched from the v9.4
 * tag): --from/--to with none, auto, si, iec and iec-i, --from-unit/--to-unit with their suffix rules,
 * --round, --padding (negative = left), --suffix, --format (the printf f directive with prefix and
 * suffix), --field ranges, -d, --header, --invalid and the exit status 2 of a conversion warning, with
 * the diagnostics of each failure. Numbers are IEEE doubles, so the 18-digit integers of the real long
 * double arithmetic are passed through as text when no scaling applies.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). NOT covered: the stderr of an earlier command of a `;` list, values beyond
 * the precision of a double, and NUL-delimited input (the simulated printf does not read the octal).
 *
 * Measured against the commit before (worktree): 104 cases; the command did not exist, all 104 fall.
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
  ["echo 1234567 | numfmt --to=si", "1.3M\n[0]"],
  ["echo 1234567 | numfmt --to=iec", "1.2M\n[0]"],
  ["echo 1K | numfmt --from=si", "1000\n[0]"],
  ["echo 1Ki | numfmt --from=iec", "numfmt: invalid suffix in input '1Ki': 'i'\n[2]"],
  ["echo 1Ki | numfmt --from=auto", "1024\n[0]"],
  ["echo 1K | numfmt --from=auto", "1000\n[0]"],
  ["echo 1Ki | numfmt --from=iec-i", "1024\n[0]"],
  ["echo 1K | numfmt --from=iec-i", "numfmt: missing 'i' suffix in input: '1K' (e.g Ki/Mi/Gi)\n[2]"],
  ["echo 1234567 | numfmt --to=iec --format=%.2f", "1.18M\n[0]"],
  ["echo 1234567 | numfmt --grouping", "1234567\n[0]"],
  ["echo 12 | numfmt --padding=6", "    12\n[0]"],
  ["echo 12 | numfmt --padding=-6", "12    \n[0]"],
  ["echo 12 | numfmt --suffix=B", "12B\n[0]"],
  ["echo abc | numfmt", "numfmt: invalid number: 'abc'\n[2]"],
  ["numfmt --to=si 1500 2000000", "1.5K\n2.0M\n[0]"],
  ["echo '1 2' | numfmt -d' ' --field=2 --to=si", "1 2\n[0]"],
  ["echo '1000 2000' | numfmt --field=1,2 --to=si", "1.0K 2.0K\n[0]"],
  ["echo '1000 2000' | numfmt --field=2- --to=si", "1000 2.0K\n[0]"],
  ["echo '1000 2000 3000' | numfmt --field=-2 --to=si", "1.0K 2.0K 3000\n[0]"],
  ["echo 999 | numfmt --to=si", "999\n[0]"],
  ["echo 1000 | numfmt --to=si", "1.0K\n[0]"],
  ["echo 1500 | numfmt --to=si --round=nearest", "1.5K\n[0]"],
  ["echo 1500 | numfmt --to=si --round=down", "1.5K\n[0]"],
  ["echo 1499 | numfmt --to=si --round=up", "1.5K\n[0]"],
  ["echo 1.5K | numfmt --from=si", "1500\n[0]"],
  ["echo 5 | numfmt --to-unit=1", "5\n[0]"],
  ["echo 10 | numfmt --invalid=ignore", "10\n[0]"],
  ["echo 1000 | numfmt --to=iec-i", "1000\n[0]"],
  ["echo 1024 | numfmt --to=iec-i", "1.0Ki\n[0]"],
  ["echo 1048576 | numfmt --to=iec", "1.0M\n[0]"],
  ["echo -1500 | numfmt --to=si", "-1.5K\n[0]"],
  ["echo 0 | numfmt --to=si", "0\n[0]"],
  ["echo 9999 | numfmt --to=si", "10K\n[0]"],
  ["echo 999999 | numfmt --to=si", "1.0M\n[0]"],
  ["echo 99999 | numfmt --to=si", "100K\n[0]"],
  ["echo 1M | numfmt --from=si --to=iec", "977K\n[0]"],
  ["echo 2G | numfmt --from=iec", "2147483648\n[0]"],
  ["echo 2G | numfmt --from=si", "2000000000\n[0]"],
  ["echo 2G | numfmt --from=none", "numfmt: rejecting suffix in input: '2G' (consider using --from)\n[2]"],
  ["echo 2X | numfmt --from=si", "numfmt: invalid suffix in input: '2X'\n[2]"],
  ["echo 2 | numfmt --from-unit=512", "1024\n[0]"],
  ["echo 2048 | numfmt --to-unit=1K", "3\n[0]"],
  ["echo 2048 | numfmt --to-unit=Ki", "2\n[0]"],
  ["echo 2048 | numfmt --to-unit=KiB", "numfmt: invalid unit size: 'KiB'\n[1]"],
  ["echo 2048 | numfmt --to-unit=0", "numfmt: invalid unit size: '0'\n[1]"],
  ["echo 2048 | numfmt --from-unit=x", "numfmt: invalid unit size: 'x'\n[1]"],
  ["echo 1.234 | numfmt", "1.234\n[0]"],
  ["echo 1.234 | numfmt --format=%.1f", "1.3\n[0]"],
  ["echo 1.25 | numfmt --format=%.1f", "1.3\n[0]"],
  ["echo 1234 | numfmt --format=%10f", "      1234\n[0]"],
  ["echo 1234 | numfmt --format=%-10f", "1234      \n[0]"],
  ["echo 1234 | numfmt --format=%010f", "0000001234\n[0]"],
  ["echo 1234 | numfmt --format='[%f]'", "[1234]\n[0]"],
  ["echo 1234 | numfmt --format='%f%%'", "1234%%\n[0]"],
  ["echo 1234 | numfmt --format=abc", "numfmt: format 'abc' has no % directive\n[1]"],
  ["echo 1234 | numfmt --format=%d", "numfmt: invalid format '%d', directive must be %[0]['][-][N][.][N]f\n[1]"],
  ["echo 1234 | numfmt --format=%f%f", "numfmt: format '%f%f' has too many % directives\n[1]"],
  ["echo 1234 | numfmt --format=%", "numfmt: format '%' ends in %\n[1]"],
  ["echo 1234 | numfmt --format=%.-1f", "numfmt: invalid precision in format '%.-1f'\n[1]"],
  ["echo 1234 | numfmt --format=%f --grouping", "numfmt: --grouping cannot be combined with --format\n[1]"],
  ["echo 1234 | numfmt --grouping --to=si", "numfmt: grouping cannot be combined with --to\n[1]"],
  ["echo 1234567890123456789012 | numfmt", "numfmt: value too large to be printed: '1.23457e+21' (consider using --to)\n[2]"],
  ["echo 1234567890123456789 | numfmt", "1234567890123456789\n[0]"],
  ["echo 12345678901234567 | numfmt", "12345678901234567\n[0]"],
  ["echo 1234567890123456789012345678 | numfmt --to=si", "1.3R\n[0]"],
  ["echo 1234567890123456789012345678901234 | numfmt --to=si", "numfmt: value too large to be converted: '1234567890123456789012345678901234'\n[2]"],
  ["echo 1234567890123456789012345678901234 | numfmt", "numfmt: value too large to be converted: '1234567890123456789012345678901234'\n[2]"],
  ["printf '1000\\n2000\\n' | numfmt --to=si", "1.0K\n2.0K\n[0]"],
  ["printf '1000\\n2000' | numfmt --to=si", "1.0K\n2.0K[0]"],
  ["printf 'h1\\nh2\\n1000\\n' | numfmt --header=2 --to=si", "h1\nh2\n1.0K\n[0]"],
  ["printf 'h1\\n1000\\n' | numfmt --header --to=si", "h1\n1.0K\n[0]"],
  ["printf 'h1\\n1000\\n' | numfmt --header=0 --to=si", "numfmt: invalid header value '0'\n[1]"],
  ["printf 'h1\\n1000\\n' | numfmt --header=x --to=si", "numfmt: invalid header value 'x'\n[1]"],
  ["echo '  1000' | numfmt --to=si", "  1.0K\n[0]"],
  ["echo 'a 1000' | numfmt --to=si --field=2", "a 1.0K\n[0]"],
  ["echo 'x   1000   y' | numfmt --to=si --field=2", "x   1.0K   y\n[0]"],
  ["echo '1000;2000' | numfmt -d';' --to=si --field=2", "1000;2.0K\n[0]"],
  ["echo '1000;2000' | numfmt -d';;' --to=si", "numfmt: the delimiter must be a single character\n[1]"],
  ["echo '1000;2000' | numfmt -d ';' --field=1,2 --to=si", "1.0K;2.0K\n[0]"],
  ["echo 1000 | numfmt --field=1 --field=2", "numfmt: multiple field specifications\n[1]"],
  ["echo 1000 | numfmt --field=0", "numfmt: fields are numbered from 1\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo 1000 | numfmt --field=x", "numfmt: invalid field value 'x'\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo 1000 | numfmt --field=3-2", "numfmt: invalid decreasing range\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo 1000 | numfmt --suffix=B --to=si", "1.0KB\n[0]"],
  ["echo 1000B | numfmt --suffix=B --to=si", "1.0KB\n[0]"],
  ["echo 1000X | numfmt --suffix=B --to=si", "numfmt: invalid suffix in input: '1000X'\n[2]"],
  ["echo abc | numfmt --invalid=ignore; echo $?", "abc\n0\n[0]"],
  ["echo abc | numfmt --invalid=bogus", "numfmt: invalid argument 'bogus' for '--invalid'\nValid arguments are:\n  - 'abort'\n  - 'fail'\n  - 'warn'\n  - 'ignore'\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo 1000 | numfmt --to=bogus", "numfmt: invalid argument 'bogus' for '--to'\nValid arguments are:\n  - 'none'\n  - 'si'\n  - 'iec'\n  - 'iec-i'\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo 1000 | numfmt --to=s", "1.0K\n[0]"],
  ["echo 1000 | numfmt --to=i", "numfmt: ambiguous argument 'i' for '--to'\nValid arguments are:\n  - 'none'\n  - 'si'\n  - 'iec'\n  - 'iec-i'\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo 1000 | numfmt --round=bogus", "numfmt: invalid argument 'bogus' for '--round'\nValid arguments are:\n  - 'up'\n  - 'down'\n  - 'from-zero'\n  - 'towards-zero'\n  - 'nearest'\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo 1000 | numfmt --padding=0", "numfmt: invalid padding value '0'\n[1]"],
  ["echo 1000 | numfmt --padding=x", "numfmt: invalid padding value 'x'\n[1]"],
  ["echo 1000 | numfmt --bogus", "numfmt: unrecognized option '--bogus'\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo 1000 | numfmt -x", "numfmt: invalid option -- 'x'\nTry 'numfmt --help' for more information.\n[1]"],
  ["echo | numfmt", "numfmt: invalid number: ''\n[2]"],
  ["printf '\\n' | numfmt", "numfmt: invalid number: ''\n[2]"],
  ["printf '' | numfmt", "[0]"],
  ["numfmt", "[0]"],
  ["numfmt 1 2 3", "1\n2\n3\n[0]"],
  ["numfmt 1K --from=si 2M --from=si", "1000\n2000000\n[0]"],
  ["numfmt --from=si 1K 2M", "1000\n2000000\n[0]"],
  ["numfmt -d '' 1", "1\n[0]"],
];

describe('numfmt follows GNU numfmt', () => {
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
