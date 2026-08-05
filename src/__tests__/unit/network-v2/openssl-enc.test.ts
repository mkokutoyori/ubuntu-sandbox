/**
 * docs/PRD-OpenSSL.md §P2 — `enc`, symmetric encryption.
 *
 * Everything checked here is REAL: AES-CBC comes from
 * `src/crypto/cipher/`, PBKDF2 from `src/crypto/kdf/`. The contract that
 * matters is the round-trip — encrypt then decrypt must return EXACTLY the
 * input — and its counterpart, that a wrong password fails instead of
 * returning noise.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'ENC'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

describe('§P2 — enc: the round-trip', () => {
  it('encrypting then decrypting returns exactly the input', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "secret message" > /tmp/plain.txt'`);

    await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -a -k passphrase -in /tmp/plain.txt -out /tmp/cipher.b64');
    await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -a -d -k passphrase -in /tmp/cipher.b64 -out /tmp/back.txt');

    expect((await srv.executeCommand('cat /tmp/back.txt')).trim()).toBe('secret message');
  });

  it('the encrypted file carries openssl\'s Salted__ header', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "abc" > /tmp/c.txt'`);

    await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -a -k pw -in /tmp/c.txt -out /tmp/c.b64');

    // `Salted__` in base64 always starts with `U2FsdGVkX1`.
    expect((await srv.executeCommand('cat /tmp/c.b64')).trim()).toMatch(/^U2FsdGVkX1/);
  });

  it('a WRONG password fails instead of returning noise', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "secret message" > /tmp/s.txt'`);
    await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -a -k rightpw -in /tmp/s.txt -out /tmp/s.b64');

    const out = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -a -d -k wrongpw -in /tmp/s.b64');

    expect(out).toContain('bad decrypt');
  });

  it('the exit code tells success from failure', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "x" > /tmp/e.txt'`);
    await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -a -k good -in /tmp/e.txt -out /tmp/e.b64');

    // Chained with `&&`/`||`, which is how a real script uses it.
    // Deliberately NOT `> /dev/null 2>&1`: `bad decrypt` goes to stderr,
    // as on a real machine, and the simulator's single-command fast path
    // merges stdout and stderr — a real but distinct gap that does not
    // belong to `enc`.
    const good = await srv.executeCommand(
      `sh -c 'openssl enc -aes-256-cbc -pbkdf2 -a -d -k good -in /tmp/e.b64 && echo PASSED'`);
    const bad = await srv.executeCommand(
      `sh -c 'openssl enc -aes-256-cbc -pbkdf2 -a -d -k wrong -in /tmp/e.b64 || echo FAILED'`);

    expect(good).toContain('PASSED');
    expect(bad).toContain('FAILED');
  });

  it('the same salt and password give the SAME ciphertext', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "deterministic" > /tmp/d.txt'`);

    const first = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -S A1B2C3D4E5F60718 -a -k pw -in /tmp/d.txt');
    const second = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -S A1B2C3D4E5F60718 -a -k pw -in /tmp/d.txt');

    // This is what makes the exercise reproducible, and why `-S` exists on
    // the real tool.
    expect(first.trim()).toBe(second.trim());
  });

  it('a different salt gives a different ciphertext for the same plaintext', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "same plaintext" > /tmp/m.txt'`);

    const first = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -S 0000000000000000 -a -k pw -in /tmp/m.txt');
    const second = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -S FFFFFFFFFFFFFFFF -a -k pw -in /tmp/m.txt');

    expect(first.trim()).not.toBe(second.trim());
  });
});

describe('§P2 — enc: ciphers and key derivation', () => {
  for (const algo of ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc']) {
    it(`${algo} completes the round-trip`, async () => {
      const srv = machine(`A-${algo}`);
      await srv.executeCommand(`sh -c 'printf "content ${algo}" > /tmp/a.txt'`);

      await srv.executeCommand(
        `openssl enc -${algo} -pbkdf2 -a -k pw -in /tmp/a.txt -out /tmp/a.b64`);
      await srv.executeCommand(
        `openssl enc -${algo} -pbkdf2 -a -d -k pw -in /tmp/a.b64 -out /tmp/a.out`);

      expect((await srv.executeCommand('cat /tmp/a.out')).trim()).toBe(`content ${algo}`);
    });
  }

  it('`-P` prints salt, key and IV without operating', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "x" > /tmp/p.txt'`);

    const out = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -S A1B2C3D4E5F60718 -P -k pw -in /tmp/p.txt');

    expect(out).toContain('salt=A1B2C3D4E5F60718');
    expect(out).toMatch(/key=[0-9A-F]{64}/);
    expect(out).toMatch(/iv =[0-9A-F]{32}/);
  });

  it('PBKDF2 and the legacy derivation do NOT give the same key', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "x" > /tmp/k.txt'`);

    const withPbkdf2 = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -S 0011223344556677 -P -k pw -in /tmp/k.txt');
    const without = await srv.executeCommand(
      'openssl enc -aes-256-cbc -S 0011223344556677 -P -k pw -in /tmp/k.txt');

    // This is the difference openssl 3 reproaches its own default with:
    // reproducing it lets us SHOW it rather than talk about it.
    expect(withPbkdf2).not.toBe(without);
  });

  it('the iteration count changes the key', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "x" > /tmp/i.txt'`);

    const thousand = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -iter 1000 -S 0011223344556677 -P -k pw -in /tmp/i.txt');
    const tenThousand = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -iter 10000 -S 0011223344556677 -P -k pw -in /tmp/i.txt');

    expect(thousand).not.toBe(tenThousand);
  });

  it('a cipher openssl knows and this build lacks is named', async () => {
    const out = await machine().executeCommand('openssl enc -chacha20 -k pw -in /etc/hostname');
    expect(out).toContain("'chacha20' is not implemented in this simulator");
  });

  it('the direct alias `openssl aes-256-cbc` behaves like `enc -aes-256-cbc`', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "alias" > /tmp/al.txt'`);

    const viaAlias = await srv.executeCommand(
      'openssl aes-256-cbc -pbkdf2 -S 0011223344556677 -a -k pw -in /tmp/al.txt');
    const viaEnc = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -S 0011223344556677 -a -k pw -in /tmp/al.txt');

    expect(viaAlias.trim()).toBe(viaEnc.trim());
  });
});

describe('§P2 — enc: honest refusals', () => {
  it('raw binary output is refused, saying WHY', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "x" > /tmp/b.txt'`);

    const out = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -k pw -in /tmp/b.txt -out /tmp/b.bin');

    // This simulator's filesystem stores text: writing arbitrary bytes
    // would lose them SILENTLY on decryption. The refusal names the cause
    // and the option that lifts it.
    expect(out).toContain('raw binary output cannot be stored');
    expect(out).toContain('-a');
  });

  it('with no password it refuses instead of encrypting with nothing', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "x" > /tmp/n.txt'`);

    expect(await srv.executeCommand('openssl enc -aes-256-cbc -a -in /tmp/n.txt'))
      .toContain('a password is required');
  });

  it('with no cipher it refuses instead of picking one', async () => {
    const srv = machine();
    expect(await srv.executeCommand('openssl enc -a -k pw -in /etc/hostname'))
      .toContain('a cipher is required');
  });

  it('a truncated ciphertext is refused, not half-decrypted', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "not valid base64 at all!!" > /tmp/t.b64'`);

    const out = await srv.executeCommand(
      'openssl enc -aes-256-cbc -pbkdf2 -a -d -k pw -in /tmp/t.b64');

    expect(out).toMatch(/bad magic number|bad decrypt|error reading input/);
  });
});
