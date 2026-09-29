/*
 * `ssh-keygen` fabrique de vraies cles, dans les formats d'OpenSSH.
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `PROTOCOL.key` : le fichier prive est
 *   « openssh-key-v1\0 », le chiffre et la KDF (« none » pour une cle sans
 *   phrase de passe), les options de la KDF, le nombre de cles, les cles
 *   publiques, puis la liste des cles privees : deux « checkint » egaux,
 *   chaque cle et son commentaire, un bourrage 1, 2, 3… jusqu'a la taille
 *   de bloc ;
 * - `sshkey.c` (`sshkey_private_serialize_opt`) : une cle Ed25519 privee
 *   porte la cle publique puis les 64 octets graine || publique ; une cle
 *   RSA porte n, e, d, iqmp, p, q ;
 * - RFC 4253 §6.6 et RFC 8709 : le blob public est « ssh-rsa », e, n, ou
 *   « ssh-ed25519 » et les 32 octets de la cle ;
 * - les cles de test d'OpenSSH (`regress/unittests/sshkey/testdata`,
 *   etiquette V_8_9_P1) : `ed25519_1`, sa `.pub`, son empreinte `.fp` ;
 *   `rsa_1.pub` et son `.fp`, une cle de 1024 bits.
 *
 * Ecrite a l'aveugle contre ces sources. Le lecteur d'openssh-key-v1 de
 * cette sonde est le sien, ecrit depuis PROTOCOL.key : se servir de celui
 * du simulateur ne prouverait rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { ed25519PublicKey, ed25519Sign, ed25519Verify } from '@/crypto/ecc';
import { base64ToBytes, bytesToHex } from '@/crypto/encoding';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const OPENSSH_ED25519_1 = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBThupGO0X+FLQhbz8CoKPwc7V3JNsQuGtlsgN+F7SMGQAAAJjnj4Ao54+A',
  'KAAAAAtzc2gtZWQyNTUxOQAAACBThupGO0X+FLQhbz8CoKPwc7V3JNsQuGtlsgN+F7SMGQ',
  'AAAED3KgoDbjR54V7bdNpfKlQY5m20UK1QaHytkCR+6rZEDFOG6kY7Rf4UtCFvPwKgo/Bz',
  'tXck2xC4a2WyA34XtIwZAAAAE0VEMjU1MTkgdGVzdCBrZXkgIzEBAg==',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n');
const OPENSSH_ED25519_1_PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFOG6kY7Rf4UtCFvPwKgo/BztXck2xC4a2WyA34XtIwZ ED25519 test key #1';
const OPENSSH_ED25519_1_FP = 'SHA256:L3k/oJubblSY0lB9Ulsl7emDMnRPKm/8udf2ccwk560';
const OPENSSH_RSA_1_PUB = [
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDLV5lUTt7FrADseB/CGhEZzpoojjEW5y8+ePvLppmK3MmMI18ud6vxzpK3bwZLYkVSyfJYI0Hm',
  'IuGhdu7yMrW6wb84gbq8C31Xoe9EORcIUuGSvDKdNSM1SjlhDquRblDFB8kToqXyx1lqrXecXylxIUOL0jE+u0rU1967pDJx+w== RSA test key #1',
].join('');
const OPENSSH_RSA_1_FP = 'SHA256:l6itGumSMcRBBAFteCgmjQBIXqLK/jFGUH3viHX1RmE';

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  raw(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new RangeError('truncated');
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  uint32(): number {
    const b = this.raw(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
  string(): Uint8Array { return this.raw(this.uint32()); }
  text(): string { return new TextDecoder().decode(this.string()); }
  mpint(): bigint {
    let n = 0n;
    for (const b of this.string()) n = (n << 8n) | BigInt(b);
    return n;
  }
  get rest(): Uint8Array { return this.bytes.slice(this.at); }
}

interface OpensshFile {
  lines: string[];
  magic: string;
  cipher: string;
  kdf: string;
  kdfOptions: Uint8Array;
  keyCount: number;
  publicBlob: Uint8Array;
  privateLength: number;
  checkints: [number, number];
  keyType: string;
  fields: Reader;
  privateTail: Uint8Array;
}

function readOpenssh(text: string): OpensshFile {
  const lines = text.trim().split('\n');
  const body = base64ToBytes(lines.slice(1, -1).join(''));
  const outer = new Reader(body);
  const magic = new TextDecoder().decode(outer.raw(15));
  const cipher = outer.text();
  const kdf = outer.text();
  const kdfOptions = outer.string();
  const keyCount = outer.uint32();
  const publicBlob = outer.string();
  const privateSection = outer.string();
  const inner = new Reader(privateSection);
  const checkints: [number, number] = [inner.uint32(), inner.uint32()];
  const keyType = inner.text();
  return {
    lines, magic, cipher, kdf, kdfOptions, keyCount, publicBlob, privateLength: privateSection.length, checkints, keyType,
    fields: inner, privateTail: inner.rest,
  };
}

function publicBlobOf(line: string): Uint8Array {
  return base64ToBytes(line.trim().split(/\s+/)[1]);
}

async function machine(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  return pc;
}

describe('the keys OpenSSH itself wrote are read as OpenSSH reads them', () => {
  it('ssh-keygen -y derives the public line of OpenSSH\'s ed25519_1', async () => {
    const pc = await machine();
    await pc.executeCommand(`printf '%s' '${OPENSSH_ED25519_1}' > /tmp/ed25519_1`);
    await pc.executeCommand('chmod 600 /tmp/ed25519_1');

    expect((await pc.executeCommand('ssh-keygen -y -f /tmp/ed25519_1')).trim()).toBe(OPENSSH_ED25519_1_PUB);
  });

  it('ssh-keygen -l gives ed25519_1\'s own fingerprint — WITNESS', async () => {
    const pc = await machine();
    await pc.executeCommand(`echo '${OPENSSH_ED25519_1_PUB}' > /tmp/ed25519_1.pub`);

    expect(await pc.executeCommand('ssh-keygen -l -f /tmp/ed25519_1.pub'))
      .toBe(`256 ${OPENSSH_ED25519_1_FP} ED25519 test key #1 (ED25519)`);
  });

  it('ssh-keygen -l counts the bits of rsa_1\'s modulus', async () => {
    const pc = await machine();
    await pc.executeCommand(`echo '${OPENSSH_RSA_1_PUB}' > /tmp/rsa_1.pub`);

    expect(await pc.executeCommand('ssh-keygen -l -f /tmp/rsa_1.pub'))
      .toBe(`1024 ${OPENSSH_RSA_1_FP} RSA test key #1 (RSA)`);
  });
});

describe('an Ed25519 key made here is a real one', () => {
  async function made(): Promise<{ priv: string; pub: string }> {
    const pc = await machine();
    await pc.executeCommand("ssh-keygen -t ed25519 -N '' -C 'alice@PC1' -f /tmp/k -q");
    return { priv: await pc.executeCommand('cat /tmp/k'), pub: (await pc.executeCommand('cat /tmp/k.pub')).trim() };
  }

  it('the private file is openssh-key-v1 without encryption, one key, lines of 70', async () => {
    const file = readOpenssh((await made()).priv);

    expect(file.lines[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(file.lines.at(-1)).toBe('-----END OPENSSH PRIVATE KEY-----');
    expect(file.lines.slice(1, -2).every((l) => l.length === 70)).toBe(true);
    expect([file.magic, file.cipher, file.kdf, file.kdfOptions.length, file.keyCount])
      .toEqual(['openssh-key-v1\0', 'none', 'none', 0, 1]);
    expect(file.checkints[0]).toBe(file.checkints[1]);
  });

  it('its private section carries the public key, seed || public, the comment and the 1, 2, 3… padding', async () => {
    const { priv, pub } = await made();
    const file = readOpenssh(priv);
    const publicKey = file.fields.string();
    const secret = file.fields.string();
    const comment = file.fields.text();
    const padding = file.fields.rest;

    expect(file.keyType).toBe('ssh-ed25519');
    expect(bytesToHex(publicKey)).toBe(bytesToHex(publicBlobOf(pub).slice(4 + 11 + 4)));
    expect(secret.length).toBe(64);
    expect(bytesToHex(secret.slice(32))).toBe(bytesToHex(publicKey));
    expect(comment).toBe('alice@PC1');
    expect([...padding]).toEqual([...padding].map((_, i) => i + 1));
    expect(padding.length).toBeLessThan(8);
    expect(file.privateLength % 8).toBe(0);
  });

  it('its seed derives its public key, and signs what its public key verifies', async () => {
    const { priv } = await made();
    const file = readOpenssh(priv);
    const publicKey = file.fields.string();
    const seed = file.fields.string().slice(0, 32);
    const message = new TextEncoder().encode('proof of possession');

    expect(bytesToHex(ed25519PublicKey(seed))).toBe(bytesToHex(publicKey));
    expect(ed25519Verify(publicKey, message, ed25519Sign(seed, message))).toBe(true);
  });

  it('ssh-keygen -y gives back the .pub — WITNESS', async () => {
    const pc = await machine();
    await pc.executeCommand("ssh-keygen -t ed25519 -N '' -f /tmp/k -q");

    expect((await pc.executeCommand('ssh-keygen -y -f /tmp/k')).trim())
      .toBe((await pc.executeCommand('cat /tmp/k.pub')).trim());
  });
});

describe('an RSA key made here is a real one', () => {
  it('n is the product of the p and q the private file carries, e*d = 1 mod lcm(p-1, q-1), and iqmp = q^-1 mod p', async () => {
    const pc = await machine();
    await pc.executeCommand("ssh-keygen -t rsa -b 2048 -N '' -f /tmp/r -q");
    const file = readOpenssh(await pc.executeCommand('cat /tmp/r'));
    const [n, e, d, iqmp, p, q] = [0, 1, 2, 3, 4, 5].map(() => file.fields.mpint());
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
    const lcm = ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n);
    const blob = new Reader(publicBlobOf(await pc.executeCommand('cat /tmp/r.pub')));

    expect(file.keyType).toBe('ssh-rsa');
    expect([blob.text(), blob.mpint(), blob.mpint()]).toEqual(['ssh-rsa', e, n]);
    expect(p * q).toBe(n);
    expect(n.toString(2).length).toBe(2048);
    expect((e * d) % lcm).toBe(1n);
    expect((iqmp * q) % p).toBe(1n);
  }, 60_000);

  it('ssh-keygen -l reports the size asked for', async () => {
    const pc = await machine();
    await pc.executeCommand("ssh-keygen -t rsa -b 2048 -N '' -C 'bob@PC1' -f /tmp/r -q");

    expect(await pc.executeCommand('ssh-keygen -l -f /tmp/r.pub')).toMatch(/^2048 SHA256:\S+ bob@PC1 \(RSA\)$/);
  }, 60_000);
});
