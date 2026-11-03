/**
 * The filter expressions of pcap-filter(7), against the real tcpdump 4.99.4 / libpcap 1.10.4 (Ubuntu 24.04): scripts/oracle/record_tcpdump_filters.py runs
 * `tcpdump -nn -t -r <lab>.pcap '<expression>'` on the "base" and "dns" savefiles that tcpdump-options-oracle.test.ts already replays and stores the whole answer, status
 * included, for 108 expressions: the TCP flag tests of the sysadmin's cookbook (`tcp[tcpflags] & tcp-syn != 0`, `tcp[tcpflags] & (tcp-fin|tcp-rst) != 0`,
 * `tcp[tcpflags] & (tcp-syn|tcp-ack) = (tcp-syn|tcp-ack)`), arithmetic over packet bytes (`+ - * / % & | ^ << >>`, parentheses, `len`, a constant on the left of the comparison),
 * variable offsets (`tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x47455420`, the classic HTTP GET test), `ether[]`, `icmp[icmptype]`, `ip6[]`, and the expressions the tool refuses
 * (`syntax error`, `data size must be 1, 2, or 4`, `expression rejects all packets`). The replay writes the same savefile into a simulated host and runs the same line; the
 * whole text is compared.
 * Measured before the change (git stash push -- src/network): 110 tests (108 expressions and the 2 WITNESSes), 67 fall and 43 pass. The 43 that pass either way are the 2 WITNESSes (the lab holds packets),
 * the non-regressions the old parser already answered (`host A and host B`, `tcp port 9000`, `tcp[tcpflags] & tcp-syn != 0`, one slice against one constant, `icmp[icmptype] = icmp-echo`, `arp[6:2] = 1`) and the
 * refusals the old parser happened to give for the right reason (`tcp[tcpflags] &`, `tcp[tcpflags] & ( != 0`, `ip[x] = 1`, `ip[] = 1`, `tcp[99999] = 1`); the 67 that fall are the arithmetic, the parenthesised
 * operands (`tcp[tcpflags] & (tcp-fin|tcp-rst) != 0`), the variable offsets, `len`, `ether[]`, `ip6[]`, the constant comparisons and the refusals with their own wording.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { base64ToBytes, bytesToFileText } from '@/crypto/encoding';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Answer { status: number; text: string }
interface Lab { pcap: string; answers: Record<string, Answer> }

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/tcpdump-filters-4.99.4.json', import.meta.url), 'utf8')) as { labs: Record<string, Lab> };

function normalised(text: string): string {
  return text.split('\n').filter((line) => !line.startsWith('reading from file ')).join('\n').replace(/\n+$/, '');
}

async function replay(lab: Lab, expression: string): Promise<{ status: number; text: string }> {
  const pc = new LinuxPC('PC1', 0, 0);
  const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/tmp/replay.cap', bytesToFileText(base64ToBytes(lab.pcap)), 0, 0, 0o022);
  const text = await pc.executeCommand(`sudo tcpdump -nn -t -r /tmp/replay.cap '${expression}'; echo "STATUS:$?"`);
  const status = Number(/STATUS:(\d+)\s*$/.exec(text)![1]);
  return { status, text: text.replace(/\n?STATUS:\d+\s*$/, '') };
}

for (const [name, lab] of Object.entries(fixture.labs)) {
  describe(`tcpdump filter expressions against the real tool: lab ${name}`, () => {
    it('WITNESS: no expression prints every packet of the lab', async () => {
      const packets = (text: string): number => text.split('\n').filter((line) => /^(IP|IP6|ARP|STP|CDP|LLDP|ethertype)/.test(line)).length;
      const everything = await replay(lab, '');
      expect(packets(everything.text)).toBeGreaterThan(0);
    });

    for (const [expression, answer] of Object.entries(lab.answers)) {
      it(expression, async () => {
        const got = await replay(lab, expression);
        expect(normalised(got.text)).toBe(normalised(answer.text));
        expect(got.status).toBe(answer.status);
      });
    }
  });
}
