/**
 * `-A`, `-c` and `-r` with `-w` against the real tcpdump 4.99.4 / libpcap 1.10.4 (Ubuntu 24.04): scripts/oracle/record_tcpdump_ascii_count.py ran 47 command lines on the
 * savefile of an HTTP exchange (a GET and its answer with CRLF, a tab, control bytes and 8-bit bytes in the payload, a POST, an ICMP echo, a DNS query, a FIN pair; the last two
 * records carry a microsecond field of 1000000 and 1100000) and stored the whole answer in program order, banner and status included: every `-A` spelling (-A, -AA, -nnA, -x/-X/-xx/-XX beside it, -v -q -e -t -tttt -S -l),
 * `-c` (count, zero, negative, not a number, missing, repeated, larger than the capture, with a filter that matches nothing, with the variable-offset GET test), `--count`, `-s` shorter than the frames.
 * It also ran 19 command lines that read a savefile AND write another (`-r http.pcap -w g.pcap` with a filter, -c, --count, --print, -s, --nano, a directory that does not exist, a filter that does not compile,
 * an input that does not exist), and stored the bytes of the file the real tool wrote. The replay runs the same lines in a simulated host and compares the whole text, then the file byte for byte.
 * What is normalised: the three version lines of the usage text (the simulated host is not the machine that recorded).
 * Measured before the change (git stash push -- src/network): 68 tests (47 reads, 19 writes, 2 WITNESSes), 22 fall and 46 pass. What fell: 4 reads (the last packet of an `-A` capture whose payload ends with a newline lost the
 * line end that tcpdump writes after it) and 18 of the 19 writes: 15 where `-r ... -w` printed the packets and wrote nothing, 2 where a refusal (a filter that does not compile, an unreadable `-F` file) came without the
 * `reading from file` banner the real tool prints first, and 1 where `-w` into a directory that does not exist said `Permission denied` instead of `No such file or directory`. What passes either way: the 2 WITNESSes,
 * the 43 reads whose last packet has no payload newline or that the tool refuses (`invalid packet count`, `option requires an argument`), and `-r nothere.pcap -w g.pcap` (the input is refused before anything is written).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { base64ToBytes, bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Written { out: string; file: string | null }

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/tcpdump-ascii-count-readwrite-4.99.4.json', import.meta.url), 'utf8')) as {
  pcap: string;
  reads: Record<string, string>;
  writes: Record<string, Written>;
};

const VERSION_LINES = /^(tcpdump version|libpcap version|OpenSSL) .*\n/gm;

function normalised(text: string): string {
  return text.replace(VERSION_LINES, '').replace(/\n+$/, '');
}

function textOf(base64: string): string {
  return Buffer.from(base64, 'base64').toString('latin1');
}

async function labWithSavefile(): Promise<{ pc: LinuxPC; vfs: VirtualFileSystem }> {
  const pc = new LinuxPC('PC1', 0, 0);
  const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  await pc.executeCommand('sudo mkdir -p /work && sudo chmod 777 /work');
  vfs.writeFile('/work/http.pcap', bytesToFileText(base64ToBytes(fixture.pcap)), 0, 0, 0o022);
  return { pc, vfs };
}

async function replay(pc: LinuxPC, command: string): Promise<string> {
  return pc.executeCommand(`cd /work && sudo tcpdump ${command}; echo "STATUS:$?"`);
}

describe('tcpdump -A and -c against the real tool', () => {
  it('WITNESS: the savefile holds twelve packets and the lab reads it all', async () => {
    const { pc } = await labWithSavefile();
    const text = await replay(pc, '-nn --count -r http.pcap');
    expect(text).toContain('12 packets');
  });

  for (const [command, answer] of Object.entries(fixture.reads)) {
    it(command, async () => {
      const { pc } = await labWithSavefile();
      expect(normalised(await replay(pc, command))).toBe(normalised(textOf(answer)));
    });
  }
});

describe('tcpdump -r with -w against the real tool', () => {
  it('WITNESS: a savefile written by the real tool is read back by the simulated one', async () => {
    const { pc, vfs } = await labWithSavefile();
    const real = fixture.writes['-nn -c 3 -r http.pcap -w g.pcap'];
    vfs.writeFile('/work/g.pcap', bytesToFileText(base64ToBytes(real.file!)), 0, 0, 0o022);
    expect(await replay(pc, '-nn --count -r g.pcap')).toContain('3 packets');
  });

  for (const [command, answer] of Object.entries(fixture.writes)) {
    it(command, async () => {
      const { pc, vfs } = await labWithSavefile();
      expect(normalised(await replay(pc, command))).toBe(normalised(textOf(answer.out)));
      const written = vfs.readFile('/work/g.pcap');
      const wrote = written === null ? null : Buffer.from(fileTextToBytes(written)).toString('base64');
      expect(wrote).toBe(answer.file);
    });
  }
});
