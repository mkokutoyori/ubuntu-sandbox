/*
 * A UDP answer cut at 512 bytes (60 A records of one name, a question without EDNS), against the real dig 9.18.39 and the real named: dig prints `;; Truncated, retrying in TCP mode.` BEFORE the banner of the
 * TCP answer (only while the comments are shown: nothing under `+nocomments`, `+noall` alone or `+short`), and prints the cut reply itself under `+ignore` (flags `qr aa tc`, ANSWER: 29, AUTHORITY: 0,
 * ADDITIONAL: 0, `MSG SIZE  rcvd: 504`, `(UDP)`). The simulator retried over TCP in silence and read no `+ignore` at all: the option was accepted and ignored.
 * The real reply to `+ignore` carries the `ad` flag as well (`qr aa tc ad`), which the simulated server does not set: it is left out of the comparison and recorded in TODO.md.
 * Measured before the change (git stash push -- src/network): 3 of the 4 tests fall (no notice, `+ignore` showing the TCP answer); the one that passes either way is the WITNESS, the same question over TCP
 * from the start, which truncates nothing and prints no notice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

async function ask(options: string): Promise<string> {
  const lab = await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  const bank = devices.get('NS1-BANK')!;
  await lab.bench.shell(bank, 'for i in $(seq 1 60); do echo "many IN A 198.51.100.$i" | sudo tee -a /etc/bind/db.banquehorizon.com > /dev/null; done; sudo sed -i s/2026103101/2026103102/ /etc/bind/db.banquehorizon.com; sudo rndc reload banquehorizon.com');
  return lab.bench.shell(devices.get('PC-CONSEILLER')!, `dig @203.0.113.10 many.banquehorizon.com +noedns +norecurse ${options}`);
}

describe('dig and a truncated UDP answer', () => {
  it('WITNESS: over TCP from the start nothing is truncated and no notice is printed', async () => {
    const out = await ask('+tcp +noall +comments');
    expect(out).toContain('ANSWER: 60');
    expect(out).not.toContain('Truncated');
  });

  it('prints the notice before the banner of the TCP answer', async () => {
    const out = await ask('');
    expect(out.split('\n').slice(0, 4)).toEqual([
      ';; Truncated, retrying in TCP mode.',
      '',
      expect.stringMatching(/^; <<>> DiG \S+ <<>> @203\.0\.113\.10 many\.banquehorizon\.com \+noedns \+norecurse$/),
      '; (1 server found)',
    ]);
    expect(out).toContain('ANSWER: 60, AUTHORITY: 2, ADDITIONAL: 2');
    expect(out).toContain('(TCP)');
  });

  it('prints it first under +noall +comments and not at all without the comments', async () => {
    expect((await ask('+noall +comments')).split('\n')[0]).toBe(';; Truncated, retrying in TCP mode.');
    expect(await ask('+noall +answer')).not.toContain('Truncated');
    expect(await ask('+short')).not.toContain('Truncated');
  });

  it('+ignore prints the cut reply and does not retry', async () => {
    const out = await ask('+ignore +noall +comments +stats');
    expect(out).not.toContain('Truncated');
    expect(out).toContain(';; flags: qr aa tc; QUERY: 1, ANSWER: 29, AUTHORITY: 0, ADDITIONAL: 0');
    expect(out).toContain('(UDP)');
    expect(out).toContain('MSG SIZE  rcvd: 504');
  });
});
