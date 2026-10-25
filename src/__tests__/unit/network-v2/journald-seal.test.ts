/*
 * Probe - forward secure sealing of the journal (systemd 255.4: libsystemd/sd-journal/fsprg.c, journal-authenticate.c, journal-file.c,
 * journalctl.c --setup-keys / --verify-key). The generator is pinned by its algebra (the moduli are products of two 768-bit primes
 * congruent to 3 mod 4, evolving k times lands on the state seek(k) builds directly, the same seed gives the same state 0), the key file
 * by its bytes (KSHHRHLP, 88-byte header, 394-byte state: 482), and the seal by what a learner reads: --setup-keys prints the verification
 * key, a journal file created afterwards carries the SEALED flags and one Tag object per sealing interval of the SIMULATED clock, and
 * --verify-key passes with the key it was generated with, fails with another, and reports "Required key not available" without one.
 * The tag chain itself was compared with the real /lib/systemd/systemd-journald and /usr/bin/journalctl 255.4 on a sealed file: same
 * HMAC-SHA256 stream, same key derivation, same epoch evolution (including the upstream quirk that the first file of a boot, whose header
 * seqnum_id changes with its first entry, fails the verification of its first tag).
 * Measured before the port (git stash push -- src/network): 9 of the 17 cases fall - no key file, no interval parsing, no permission check,
 * no sealed header flag, no Tag object, no verification outcome. The 8 that pass either way: the 4 FSPRG and 2 key-file cases are STRUCTURAL
 * (the pure modules under journal/seal/ are new files and stay in place when the tracked sources are stashed), the unsealed host is the
 * WITNESS (--verify passes, no Tag object: non-regression), and Seal=no keeps files unsealed, which an unported host also does (the sealed
 * counterpart is pinned by the cases above that fall).
 */
import { describe, it, expect } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { LinuxServer } from '@/network/devices/LinuxServer';
import {
  deterministicRandom, epochOf, evolve, generateMasterKey, generateState0, masterPublicKey, seek, stateKey, stateLength, RECOMMENDED_SECPAR,
} from '@/network/devices/linux/journal/seal/Fsprg';
import { decodeSealingKey, encodeSealingKey, parseVerificationKey } from '@/network/devices/linux/journal/seal/SealingKeyFile';

interface Lab {
  server: LinuxServer;
  exec: LinuxCommandExecutor;
}

function lab(): Lab {
  const server = new LinuxServer('linux-server', 'journald-seal');
  return { server, exec: (server as unknown as { executor: LinuxCommandExecutor }).executor };
}

const SEED = Uint8Array.from({ length: 12 }, (_, index) => index * 17 + 3);
const KEY_PATH = '/var/log/journal';

function verificationKey(output: string): string {
  return /([0-9a-f]{6}(?:-[0-9a-f]{6}){3}\/[0-9a-f]+-[0-9a-f]+)/.exec(output)?.[1] ?? '';
}

function sealedFiles(exec: LinuxCommandExecutor): string[] {
  return exec.logMgr.journald.fileInfos().filter((info) => info.compatibleFlags.includes('SEALED')).map((info) => info.path);
}

function tagCounts(exec: LinuxCommandExecutor): number[] {
  return exec.logMgr.journald.fileInfos().filter((info) => info.compatibleFlags.includes('SEALED')).map((info) => info.tags);
}

describe('FSPRG', () => {
  const master = generateMasterKey(SEED);

  it('the moduli are products of two primes of 768 bits congruent to 3 mod 4, so squaring is a permutation of the squares', () => {
    expect(master.p % 4n).toBe(3n);
    expect(master.q % 4n).toBe(3n);
    expect(master.p.toString(2)).toHaveLength(RECOMMENDED_SECPAR / 2);
    expect(master.q.toString(2)).toHaveLength(RECOMMENDED_SECPAR / 2);
    expect((master.p * master.q).toString(2)).toHaveLength(RECOMMENDED_SECPAR);
  });

  it('the same seed gives the same master key and the same state 0, another seed gives another', () => {
    const publicKey = masterPublicKey(master);
    const first = generateState0(publicKey, SEED);
    expect(Array.from(generateState0(masterPublicKey(generateMasterKey(SEED)), SEED))).toEqual(Array.from(first));
    const other = Uint8Array.from(SEED, (byte) => byte ^ 0x5a);
    expect(Array.from(generateState0(masterPublicKey(generateMasterKey(other)), other))).not.toEqual(Array.from(first));
    expect(first).toHaveLength(stateLength(RECOMMENDED_SECPAR));
    expect(epochOf(first)).toBe(0);
  });

  it('evolving k times is seeking to the epoch k from the master key, and each epoch has its own key', () => {
    const state = generateState0(masterPublicKey(master), SEED);
    const keys = new Set<string>();
    for (let epoch = 1; epoch <= 4; epoch++) {
      keys.add(Buffer.from(stateKey(state, 32, 0)).toString('hex'));
      evolve(state);
      expect(epochOf(state)).toBe(epoch);
      expect(Array.from(seek(epoch, master, SEED))).toEqual(Array.from(state));
    }
    expect(keys.size).toBe(4);
  });

  it('the deterministic generator is a counter-mode SHA-256 stream: the first block depends on seed and index only', () => {
    expect(Array.from(deterministicRandom(48, SEED, 0))).toEqual(Array.from(deterministicRandom(64, SEED, 0).slice(0, 48)));
    expect(Array.from(deterministicRandom(32, SEED, 1))).not.toEqual(Array.from(deterministicRandom(32, SEED, 0)));
  });
});

describe('the sealing key file and the verification key', () => {
  it('encodes to 482 bytes starting with KSHHRHLP and decodes to the same state', () => {
    const state = generateState0(masterPublicKey(generateMasterKey(SEED)), SEED);
    const machineId = '0123456789abcdef0123456789abcdef';
    const text = encodeSealingKey({ machineId, bootId: 'fedcba9876543210fedcba9876543210', startUsec: 900_000_000, intervalUsec: 300_000_000, secpar: RECOMMENDED_SECPAR, state });
    expect(text).toHaveLength(482);
    expect(text.startsWith('KSHHRHLP')).toBe(true);
    const decoded = decodeSealingKey(text, machineId);
    expect(typeof decoded).toBe('object');
    if (typeof decoded === 'string') return;
    expect(Array.from(decoded.state)).toEqual(Array.from(state));
    expect(decoded.intervalUsec).toBe(300_000_000);
    expect(decodeSealingKey(text, 'ffffffffffffffffffffffffffffffff')).toBe('EHOSTDOWN');
    expect(decodeSealingKey(`XXXXXXXX${text.slice(8)}`, machineId)).toBe('EBADMSG');
    expect(decodeSealingKey(text.slice(0, 50), machineId)).toBe('ENODATA');
  });

  it('parses the seed, the epoch and the interval it prints', () => {
    const parsed = parseVerificationKey('010203-040506-070809-0a0b0c/5-493e0');
    expect(parsed).not.toBeNull();
    expect(Array.from(parsed!.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(parsed!.intervalUsec).toBe(0x493e0);
    expect(parsed!.startUsec).toBe(5 * 0x493e0);
    expect(parseVerificationKey('zz0203-040506-070809-0a0b0c/5-493e0')).toBeNull();
  });
});

describe('journalctl --setup-keys', () => {
  it('witness: a host that was never set up has no sealed file and --verify passes', () => {
    const { exec } = lab();
    expect(sealedFiles(exec)).toEqual([]);
    const out = exec.execute('sudo journalctl --verify');
    expect(out).toContain('PASS: ');
    expect(out).not.toContain('FAIL');
  });

  it('generates the key file, prints the verification key and refuses a second run without --force', () => {
    const { exec } = lab();
    const out = exec.execute('sudo journalctl --setup-keys --interval=5min');
    expect(out).toContain('Generating seed...');
    expect(out).toContain('Generating key pair...');
    expect(out).toContain('Generating sealing key...');
    expect(out).toContain('The sealing key is automatically changed every 5min.');
    const key = verificationKey(out);
    expect(key).not.toBe('');
    expect(key.endsWith(`-${(300_000_000).toString(16)}`)).toBe(true);
    const files = exec.vfs.listDirectory(`${KEY_PATH}/${exec.vfs.readFile(`/etc/machine-id`)?.trim()}`) ?? [];
    expect(files.some((entry) => entry.name === 'fss')).toBe(true);
    const again = exec.execute('sudo journalctl --setup-keys');
    expect(again).toContain('exists already. Use --force to recreate.');
    const forced = exec.execute('sudo journalctl --setup-keys --force --interval=5min');
    expect(verificationKey(forced)).not.toBe('');
    expect(verificationKey(forced)).not.toBe(key);
  });

  it('refuses an interval that does not parse, in the words of journalctl', () => {
    const { exec } = lab();
    expect(exec.execute('sudo journalctl --setup-keys --interval=xx')).toContain('Failed to parse sealing key change interval: xx');
  });

  it('a login user cannot write the key file: the directory belongs to root', () => {
    const { exec } = lab();
    exec.execute('useradd -m -u 1000 alice');
    const out = exec.execute("su alice -c 'journalctl --setup-keys'");
    expect(out).toContain('Permission denied');
    expect(exec.vfs.listDirectory(`${KEY_PATH}/${exec.vfs.readFile('/etc/machine-id')?.trim()}`)?.some((entry) => entry.name === 'fss')).toBe(false);
  });
});

describe('sealed journal files', () => {
  async function sealedHost(): Promise<{ lab: Lab; key: string }> {
    const l = lab();
    const out = l.exec.execute('sudo journalctl --setup-keys --interval=5min');
    await l.server.executeCommand('systemctl restart systemd-journald');
    l.exec.execute('sudo journalctl --rotate');
    return { lab: l, key: verificationKey(out) };
  }

  it('a file created after the setup carries the SEALED flags and its first tag', async () => {
    const { lab: l } = await sealedHost();
    expect(sealedFiles(l.exec)).not.toEqual([]);
    const header = l.exec.execute('sudo journalctl --header');
    expect(header).toContain('SEALED');
    expect(tagCounts(l.exec).every((count) => count >= 1)).toBe(true);
  });

  it('one more tag is appended for every sealing interval the simulated clock crosses', async () => {
    const { lab: l } = await sealedHost();
    const before = tagCounts(l.exec).at(-1) ?? 0;
    l.exec.execute('logger -t probe first');
    l.server.advanceTime(5 * 60 * 1000);
    l.exec.execute('logger -t probe second');
    const afterOne = tagCounts(l.exec).at(-1) ?? 0;
    expect(afterOne).toBeGreaterThan(before);
    l.server.advanceTime(20 * 60 * 1000);
    l.exec.execute('logger -t probe third');
    const afterMany = tagCounts(l.exec).at(-1) ?? 0;
    expect(afterMany - afterOne).toBeGreaterThanOrEqual(4);
  });

  it('--verify-key accepts the key it was set up with and reports the validated period', async () => {
    const { lab: l, key } = await sealedHost();
    l.exec.execute('logger -t probe first');
    l.server.advanceTime(12 * 60 * 1000);
    l.exec.execute('logger -t probe second');
    l.exec.execute('sudo journalctl --rotate');
    const out = l.exec.execute(`sudo journalctl --verify --verify-key=${key}`);
    expect(out).not.toContain('FAIL');
    expect(out).toMatch(/=> Validated from .* to .*, final .* entries not sealed\./);
  });

  it('--verify-key rejects another key: the tag fails verification', async () => {
    const { lab: l } = await sealedHost();
    l.server.advanceTime(6 * 60 * 1000);
    l.exec.execute('logger -t probe second');
    l.exec.execute('sudo journalctl --rotate');
    const other = l.exec.execute('sudo journalctl --setup-keys --force --interval=5min');
    const out = l.exec.execute(`sudo journalctl --verify --verify-key=${verificationKey(other)}`);
    expect(out).toContain('Tag failed verification');
    expect(out).toContain('FAIL: ');
    expect(out).toContain('(Bad message)');
  });

  it('without a key a sealed file says so and fails with "Required key not available"', async () => {
    const { lab: l } = await sealedHost();
    const out = l.exec.execute('sudo journalctl --verify');
    expect(out).toContain('has sealing enabled but verification key has not been passed using --verify-key=.');
    expect(out).toContain('(Required key not available)');
  });

  it('a verification key that does not parse is refused', async () => {
    const { lab: l } = await sealedHost();
    expect(l.exec.execute('sudo journalctl --verify --verify-key=nonsense')).toContain('Failed to parse seed.');
  });

  it('Seal=no in journald.conf keeps new files unsealed even with a key file', async () => {
    const l = lab();
    l.exec.execute('sudo journalctl --setup-keys --interval=5min');
    l.exec.execute('mkdir -p /etc/systemd/journald.conf.d');
    l.exec.vfs.writeFile('/etc/systemd/journald.conf.d/zz-probe.conf', '[Journal]\nSeal=no\n', 0, 0, 0o022);
    await l.server.executeCommand('systemctl restart systemd-journald');
    l.exec.execute('sudo journalctl --rotate');
    expect(sealedFiles(l.exec)).toEqual([]);
  });
});
