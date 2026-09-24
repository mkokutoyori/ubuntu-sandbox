/*
 * Probe — `ssh-keygen` draws the randomart the way OpenSSH does: the
 * "drunken bishop" walk of sshkey.c fingerprint_randomart (OpenSSH 9.6p1,
 * openssh/openssh-portable), a 17x9 field, each digest byte giving four
 * 2-bit moves from the centre, visited cells counted into
 * " .o+=*BOX@%&#/^SE", S at the start and E at the end, the header
 * "[<TYPE> <bits>]" and the footer "[SHA256]" centred in dashes.
 *
 * Before: every one of the 153 cells carried a glyph taken straight from
 * the digest bytes, with no walk, no S and no E, and the header named the
 * type without its size.
 *
 * The expected picture is computed in the probe from the SHA-256 of the
 * public key blob, independently of the simulator.
 *
 * Measured before the change (git stash of SshKeygenMaterial.ts): 3 of the
 * 3 cases fail.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { LinuxPC } from '@/network/devices/LinuxPC';
import '../new_firewall/fortigateBatteryHarness';

const WIDTH = 17;
const HEIGHT = 9;
const SYMBOLS = ' .o+=*BOX@%&#/^SE';

function openSshRandomart(title: string, digest: Buffer): string {
  const field = Array.from({ length: WIDTH }, () => new Array<number>(HEIGHT).fill(0));
  const last = SYMBOLS.length - 1;
  let x = Math.floor(WIDTH / 2);
  let y = Math.floor(HEIGHT / 2);
  for (const byte of digest) {
    let input = byte;
    for (let step = 0; step < 4; step++) {
      x = Math.min(Math.max(x + ((input & 1) ? 1 : -1), 0), WIDTH - 1);
      y = Math.min(Math.max(y + ((input & 2) ? 1 : -1), 0), HEIGHT - 1);
      if (field[x][y] < last - 2) field[x][y]++;
      input >>= 2;
    }
  }
  field[Math.floor(WIDTH / 2)][Math.floor(HEIGHT / 2)] = last - 1;
  field[x][y] = last;
  const border = (label: string): string => {
    const left = Math.floor((WIDTH - label.length) / 2);
    return `+${'-'.repeat(left)}${label}${'-'.repeat(WIDTH - left - label.length)}+`;
  };
  const rows = [border(title)];
  for (let row = 0; row < HEIGHT; row++) {
    let line = '|';
    for (let col = 0; col < WIDTH; col++) line += SYMBOLS[Math.min(field[col][row], last)];
    rows.push(`${line}|`);
  }
  rows.push(border('[SHA256]'));
  return rows.join('\n');
}

async function generate(): Promise<{ output: string; publicLine: string }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  const output = await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');
  const publicLine = (await pc.executeCommand('cat ~/.ssh/id_ed25519.pub')).trim();
  return { output, publicLine };
}

function expectedFor(publicLine: string): string {
  const blob = Buffer.from(publicLine.split(/\s+/)[1], 'base64');
  return openSshRandomart('[ED25519 256]', createHash('sha256').update(blob).digest());
}

describe('ssh-keygen randomart', () => {
  it('is the drunken bishop walk of the key fingerprint', async () => {
    const { output, publicLine } = await generate();
    expect(output).toContain(expectedFor(publicLine));
  });

  it('starts at S in the centre of the field', async () => {
    const { output } = await generate();
    const rows = output.split('\n').filter((line) => /^\|.{17}\|$/.test(line));
    expect(rows).toHaveLength(9);
    expect([...rows[4]][9]).toMatch(/[SE]/);
  });

  it('names the key type and size in its header', async () => {
    const { output } = await generate();
    expect(output).toContain('+--[ED25519 256]--+');
    expect(output).toContain('+----[SHA256]-----+');
  });
});
