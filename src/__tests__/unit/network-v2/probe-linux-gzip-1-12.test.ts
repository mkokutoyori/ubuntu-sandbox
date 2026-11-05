/*
/*
 * gzip, gunzip and zcat looked at their arguments with a Set of strings: no bundles (-dk), no -l, -t, -S, -N, -r, -v,
 * no standard streams, no levels, and success or failure messages glued to the output. GzipCommand.ts follows gzip 1.12:
 * short and long options through the shared getopt reader, files and standard input/output (a pipe no longer ends
 * in 'not read from a terminal'), the suffix rules (.gz .z .Z -gz -z _z .tgz), 'already has .gz suffix',
 * 'already exists; not overwritten', the unknown-suffix refusal, name restoration with -N, directories with -r,
 * zcat -f passthrough, the leading blank line gzip prints before a data error, exit statuses 0/1/2.
 *
 * Every expected string was produced by the real gzip 1.12 of the dev container, by running the identical
 * line in bash with LC_ALL=C.UTF-8 (scratch directory rewritten to /tmp/ff). Rows that print compressed sizes
 * or ratios (-l, -v, wc -c of an archive) are not pinned: the simulator's deflate emits other bytes than zlib's.
 *
 * Measured against the commit before (worktree): 53 of 73 cases fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "printf 'hello\\nhello\\nhello\\n' > a.txt; printf 'world\\n' > b.txt; mkdir -p d; printf 'in\\n' > d/c.txt; : > e0; seq 1 200 > nums";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["gzip a.txt; ls -1", "a.txt.gz\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip -k a.txt; ls -1", "a.txt\na.txt.gz\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip -c a.txt | gunzip", "hello\nhello\nhello\n[0]"],
  ["gzip -c a.txt | zcat", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt; gunzip a.txt.gz; ls -1; cat a.txt", "a.txt\nb.txt\nd\ne0\nnums\nhello\nhello\nhello\n[0]"],
  ["gzip a.txt; zcat a.txt.gz", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt; gzip -d a.txt.gz; ls -1", "a.txt\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip a.txt; gzip -dk a.txt.gz; ls -1", "a.txt\na.txt.gz\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip a.txt b.txt; ls -1", "a.txt.gz\nb.txt.gz\nd\ne0\nnums\n[0]"],
  ["gzip a.txt; gzip a.txt 2>&1; echo $?", "gzip: a.txt: No such file or directory\n1\n[0]"],
  ["gzip a.txt; gzip a.txt.gz 2>&1; echo $?", "gzip: a.txt.gz already has .gz suffix -- unchanged\n0\n[0]"],
  ["gzip nofile 2>&1; echo $?", "gzip: nofile: No such file or directory\n1\n[0]"],
  ["gzip nofile a.txt 2>&1; echo $?; ls -1", "gzip: nofile: No such file or directory\n1\na.txt.gz\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip d 2>&1; echo $?", "gzip: d is a directory -- ignored\n2\n[0]"],
  ["gzip -r d; ls -1 d", "c.txt.gz\n[0]"],
  ["gzip -rk d; ls -1 d", "c.txt\nc.txt.gz\n[0]"],
  ["gzip a.txt; gzip -t a.txt.gz; echo $?", "0\n[0]"],
  ["gzip a.txt; echo junk >> a.txt.gz; gzip -t a.txt.gz 2>&1; echo $?", "\ngzip: a.txt.gz: decompression OK, trailing garbage ignored\n2\n[0]"],
  ["gzip -t a.txt 2>&1; echo $?", "\ngzip: a.txt: not in gzip format\n1\n[0]"],
  ["gzip -t nofile 2>&1; echo $?", "gzip: nofile.gz: No such file or directory\n1\n[0]"],
  ["gzip -v a.txt 2>&1 | sed -E 's/ +/ /g'", "a.txt:\t 44.4% -- replaced with a.txt.gz\n[0]"],
  ["gzip -kv a.txt 2>&1 | sed -E 's/ +/ /g'", "a.txt:\t 44.4% -- created a.txt.gz\n[0]"],
  ["gzip -c a.txt > o.gz; gunzip -c o.gz", "hello\nhello\nhello\n[0]"],
  ["gzip -10 a.txt 2>&1; echo $?", "gzip: invalid option -- '0'\nTry `gzip --help' for more information.\n1\n[0]"],
  ["gzip -S .z a.txt; ls -1", "a.txt.z\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip -S .z a.txt; gunzip -S .z a.txt.z; ls -1", "a.txt\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip --suffix=.zz a.txt; ls -1", "a.txt.zz\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip a.txt; gunzip a.txt.gz -c", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt; gunzip -N a.txt.gz; ls -1", "a.txt\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip a.txt; mv a.txt.gz x.gz; gunzip -N x.gz; ls -1", "a.txt\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip a.txt; mv a.txt.gz x.gz; gunzip x.gz; ls -1", "b.txt\nd\ne0\nnums\nx\n[0]"],
  ["gzip a.txt; mv a.txt.gz x.gz; gunzip -k x.gz; ls -1", "b.txt\nd\ne0\nnums\nx\nx.gz\n[0]"],
  ["gzip -n a.txt; ls -1", "a.txt.gz\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip --bogus 2>&1; echo $?", "gzip: unrecognized option '--bogus'\nTry `gzip --help' for more information.\n1\n[0]"],
  ["gzip -y 2>&1; echo $?", "gzip: invalid option -- 'y'\nTry `gzip --help' for more information.\n1\n[0]"],
  ["gunzip a.txt 2>&1; echo $?", "gzip: a.txt: unknown suffix -- ignored\n2\n[0]"],
  ["gunzip nofile.gz 2>&1; echo $?", "gzip: nofile.gz: No such file or directory\n1\n[0]"],
  ["gunzip 2>&1 < /dev/null; echo $?", "\ngzip: stdin: unexpected end of file\n1\n[0]"],
  ["zcat nofile 2>&1; echo $?", "gzip: nofile.gz: No such file or directory\n1\n[0]"],
  ["zcat a.txt 2>&1; echo $?", "\ngzip: a.txt: not in gzip format\n1\n[0]"],
  ["zcat -f a.txt", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt; zcat a.txt.gz a.txt.gz", "hello\nhello\nhello\nhello\nhello\nhello\n[0]"],
  ["gzip a.txt; zcat < a.txt.gz", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt; gunzip < a.txt.gz", "hello\nhello\nhello\n[0]"],
  ["gzip < a.txt | gunzip", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt; gzip -cd a.txt.gz", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt; gzip -c a.txt.gz > /dev/null 2>&1; echo $?", "0\n[0]"],
  ["gzip -q nofile; echo $?", "1\n[0]"],
  ["gzip -q a.txt; gzip -q a.txt; echo $?", "1\n[0]"],
  ["gzip a.txt; gzip -dq a.txt.gz; echo $?", "0\n[0]"],
  ["gzip -k a.txt; gzip -d a.txt.gz 2>&1; echo $?", "gzip: a.txt already exists;\tnot overwritten\n2\n[0]"],
  ["gzip -kf a.txt; gzip -d -f a.txt.gz; echo $?", "0\n[0]"],
  ["gzip a.txt; gzip -dc a.txt.gz a.txt.gz", "hello\nhello\nhello\nhello\nhello\nhello\n[0]"],
  ["gzip -- -x 2>&1; echo $?", "gzip: -x: No such file or directory\n1\n[0]"],
  ["gzip a.txt; gunzip -t a.txt.gz; echo $?", "0\n[0]"],
  ["gzip -f a.txt; gzip -f a.txt 2>/dev/null; ls -1", "a.txt.gz\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip -V 2>&1 | head -1", "gzip 1.12\n[0]"],
  ["gzip a.txt; gzip -l a.txt.gz | cut -c1-8", "        \n        \n[0]"],
  ["gunzip < /dev/null 2>&1; echo $?", "\ngzip: stdin: unexpected end of file\n1\n[0]"],
  ["gzip -d < /dev/null 2>&1; echo $?", "\ngzip: stdin: unexpected end of file\n1\n[0]"],
  ["zcat < /dev/null 2>&1; echo $?", "\ngzip: stdin: unexpected end of file\n1\n[0]"],
  ["gzip a.txt; gunzip -t a.txt.gz -v 2>&1", "a.txt.gz:\t OK\n[0]"],
  ["gzip -c a.txt | gzip -dc | wc -c", "18\n[0]"],
  ["gzip -kc a.txt b.txt | gunzip", "hello\nhello\nhello\nworld\n[0]"],
  ["gzip -9c a.txt | gzip -dc", "hello\nhello\nhello\n[0]"],
  ["gzip -1c a.txt | zcat", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt; mv a.txt.gz a.txt.z; gunzip a.txt.z; ls -1", "a.txt\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip a.txt; mv a.txt.gz a.tgz; gunzip a.tgz; ls -1", "a.tar\nb.txt\nd\ne0\nnums\n[0]"],
  ["gzip a.txt; gunzip nofile 2>&1; echo $?", "gzip: nofile.gz: No such file or directory\n1\n[0]"],
  ["gzip -d nofile 2>&1; echo $?", "gzip: nofile.gz: No such file or directory\n1\n[0]"],
  ["gunzip -f a.txt 2>&1; echo $?", "gzip: a.txt: unknown suffix -- ignored\n2\n[0]"],
  ["gzip -dfc a.txt", "hello\nhello\nhello\n[0]"],
  ["gzip a.txt b.txt nofile 2>&1 | sed 's/^/>/'; echo $?", ">gzip: nofile: No such file or directory\n0\n[0]"],
];

describe('gzip, gunzip and zcat against the real gzip', () => {
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
