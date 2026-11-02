/**
 * A capture file written before `tcpdump -w` produced a real savefile is a JSON document (`ubuntu-sandbox-capture-v1`, one object per
 * frame). A saved topology can still hold one. `tcpdump -r` reads it, read-only: the writer is libpcap, and nothing writes the old format any more.
 *
 * Two cases. The old document of one ARP request prints the packet; the same document with another `format` is refused with the sentence
 * libpcap gives a file it does not know. Removing `legacyJsonCapture` from CaptureFileFormat.ts makes the first fall; the second is the
 * non-regression (a JSON document that is not a capture never was one).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { decodeCapturedBytes } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const ARP_REQUEST_FRAME = Uint8Array.from([
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x01, 0x08, 0x00, 0x06, 0x04, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 10, 0, 0, 1,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 10, 0, 0, 2,
]);

function hostWithFile(content: string): LinuxPC {
  const pc = new LinuxPC('PC1', 0, 0);
  const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/tmp/old.cap', content, 0, 0, 0o022);
  return pc;
}

function legacyDocument(format: string): string {
  const frame = decodeCapturedBytes(ARP_REQUEST_FRAME, 60, 'eth0', 'in', new Date(Date.UTC(2026, 10, 2, 9, 0, 0)), 1793610000000000);
  return JSON.stringify({ format, linkType: 'EN10MB', snaplen: 262144, interfaces: [], frames: [frame] });
}

describe('tcpdump -r on a capture file of the old JSON format', () => {
  it('prints the packet', async () => {
    const output = await hostWithFile(legacyDocument('ubuntu-sandbox-capture-v1')).executeCommand('sudo tcpdump -nn -r /tmp/old.cap');
    expect(output).toContain('ARP, Request who-has 10.0.0.2 tell 10.0.0.1');
  });

  it('refuses a JSON document of another format', async () => {
    const output = await hostWithFile(legacyDocument('something-else')).executeCommand('sudo tcpdump -nn -r /tmp/old.cap');
    expect(output).not.toContain('ARP');
    expect(output).toMatch(/unknown file format|bad dump file format/);
  });
});
