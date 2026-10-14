/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `crypto key pubkey-chain
 * rsa` with `named-key` / `addressed-key` / `key-string` / `quit`, `show crypto key pubkey-chain rsa`,
 * `crypto key zeroize pubkey-chain`, `show crypto key mypubkey rsa`, and the IKE policy method
 * `authentication rsa-encr` (RFC 2409 §5.3, authentication with public key encryption).
 *
 * With rsa-encr each side encrypts its nonce with the PEER'S public key taken from its pubkey-chain
 * and decrypts the peer's nonce with its OWN private key; the IPsec keys derive from both nonces, so
 * a wrong or missing key means no tunnel. The key a router prints with `show crypto key mypubkey rsa`
 * is its real RSA key - the same one its SSH server presents - in X.509 SubjectPublicKeyInfo form,
 * which is what `key-string` accepts.
 *
 * Lab: ipsecLab with `authentication rsa-encr` and no pre-shared key. The nonces are read on the wire:
 * the tap on R1's WAN port decodes the IKE offer/accept payloads that cross UDP/500.
 *
 * Measured with src stashed to HEAD: `crypto key pubkey-chain rsa` is refused, rsa-encr was ignored
 * and the key data printed by `show crypto key mypubkey rsa` was a hash of the label: all 9 cases fall.
 * The refusal cases also fail the tunnel before the change, so each one asserts the reason the
 * refusing side records, not only the absence of a tunnel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import type { EthernetFrame, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { SshHostKey } from '@/network/protocols/ssh/SshHostKey';
import { sshPublicKeyFromBlob } from '@/network/devices/linux/network/SshKeygenMaterial';
import { base64ToBytes } from '@/crypto/encoding';
import { decodeRsaPublicKey, parseHexKeyString } from '@/network/ipsec/RsaPublicKeyDer';
import { ipsecLab, type IpsecLab } from './_helpers/ipsecLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const MODULUS = 1024;

async function generateKeys(lab: IpsecLab): Promise<void> {
  for (const [router, name] of [[lab.r1, 'r1'], [lab.r2, 'r2']] as const) {
    for (const line of ['enable', 'configure terminal', `ip domain-name ${name}.lab`,
      `crypto key generate rsa modulus ${MODULUS}`, 'end']) await router.executeCommand(line);
  }
}

function keyHex(output: string): string {
  const after = output.slice(output.indexOf('Key Data:') + 'Key Data:'.length);
  return after.split('\n').map((l) => l.trim()).filter((l) => /^[0-9A-F ]+$/.test(l)).join('');
}

async function install(on: IpsecLab['r1'], address: string, hex: string, kind = 'addressed-key', usage = ''): Promise<void> {
  const rows = hex.match(/.{1,64}/g)!;
  for (const line of ['configure terminal', 'crypto key pubkey-chain rsa', `${kind} ${address}${usage}`,
    'key-string', ...rows, 'quit', 'exit', 'exit', 'end']) await on.executeCommand(line);
}

async function exchange(lab: IpsecLab): Promise<void> {
  await generateKeys(lab);
  const r1Key = keyHex(await lab.r1.executeCommand('show crypto key mypubkey rsa'));
  const r2Key = keyHex(await lab.r2.executeCommand('show crypto key mypubkey rsa'));
  await install(lab.r1, '10.0.12.2', r2Key);
  await install(lab.r2, '10.0.12.1', r1Key);
}

function ikeOnWire(lab: IpsecLab): Array<{ step: string; rsaNonce?: string; authMode?: string }> {
  const seen: Array<{ step: string; rsaNonce?: string; authMode?: string }> = [];
  for (const router of [lab.r1, lab.r2]) {
    router.getPort('GigabitEthernet0/1')!.attachTap(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
      if (direction !== 'out') return;
      const packet = frame.payload as IPv4Packet | undefined;
      const udp = packet?.type === 'ipv4' ? packet.payload as { type?: string; destinationPort?: number; payload?: { type?: string; step?: string; rsaNonce?: string; authMode?: string } } : undefined;
      if (udp?.type === 'udp' && udp.destinationPort === 500 && udp.payload?.type === 'ike') {
        seen.push({ step: udp.payload.step ?? '', rsaNonce: udp.payload.rsaNonce, authMode: udp.payload.authMode });
      }
    });
  }
  return seen;
}

const ping = (lab: IpsecLab) => clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 2 192.168.2.10'));

describe('crypto key mypubkey rsa', () => {
  it('prints the router\'s real RSA key: the one its SSH server presents', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    await generateKeys(lab);
    const shown = parseHexKeyString([keyHex(await lab.r1.executeCommand('show crypto key mypubkey rsa'))]);
    const decoded = decodeRsaPublicKey(shown!);
    const ssh = sshPublicKeyFromBlob(base64ToBytes(SshHostKey.generate('R1', 'ssh-rsa', MODULUS).publicKey));
    expect(decoded).not.toBeNull();
    expect(ssh && ssh.algorithm === 'ssh-rsa' ? ssh.n : null).toBe(decoded!.n);
    expect(decoded!.n.toString(2).length).toBe(MODULUS);
  });
});

describe('crypto key pubkey-chain rsa', () => {
  it('stores a key, renders it and shows it by address and in the table', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    await exchange(lab);
    const config = await lab.r1.executeCommand('show running-config');
    expect(config).toMatch(/^crypto key pubkey-chain rsa\n addressed-key 10\.0\.12\.2\n  key-string\n/m);
    const table = await lab.r1.executeCommand('show crypto key pubkey-chain rsa');
    expect(table).toContain('Codes: M - Manually Configured, C - Extracted from certificate');
    expect(table).toMatch(/M\s+General\s+10\.0\.12\.2\s+default/);
    const detail = await lab.r1.executeCommand('show crypto key pubkey-chain rsa address 10.0.12.2');
    expect(detail).toContain('Key address: 10.0.12.2');
    expect(detail).toContain('Source: Manual');
    expect(keyHex(detail.replace('Data:', 'Key Data:'))).toBe(keyHex(await lab.r2.executeCommand('show crypto key mypubkey rsa')));
  });

  it('a key-string that is not an RSA SubjectPublicKeyInfo is refused', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    for (const line of ['configure terminal', 'crypto key pubkey-chain rsa', 'addressed-key 10.0.12.2', 'key-string']) await lab.r1.executeCommand(line);
    await lab.r1.executeCommand('DEADBEEF');
    expect(await lab.r1.executeCommand('quit')).toContain('Invalid public key');
  });

  it('zeroize pubkey-chain removes the keys, by index or all', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    await exchange(lab);
    await lab.r1.executeCommand('configure terminal');
    await lab.r1.executeCommand('crypto key zeroize pubkey-chain 1');
    await lab.r1.executeCommand('end');
    expect((await lab.r1.executeCommand('show crypto key pubkey-chain rsa')).trim()).toBe('');
    expect(await lab.r1.executeCommand('show running-config')).not.toContain('pubkey-chain');
  });
});

describe('IKE authentication rsa-encr', () => {
  it('the tunnel comes up with the peers\' public keys, and the nonces cross the wire encrypted', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    const ike = ikeOnWire(lab);
    await exchange(lab);
    expect(await ping(lab)).toContain('2 received');
    const offer = ike.find((m) => m.step === 'offer')!;
    const accept = ike.find((m) => m.step === 'accept')!;
    expect(offer.authMode).toBe('rsa-encr');
    expect(offer.rsaNonce!.length).toBe(MODULUS / 4);
    expect(accept.rsaNonce!.length).toBe(MODULUS / 4);
    expect(await lab.r1.executeCommand('show crypto isakmp policy')).toContain('Rivest-Shamir-Adleman Encryption');
  });

  it('without the responder\'s public key the initiator sends nothing and no tunnel exists', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    const ike = ikeOnWire(lab);
    await generateKeys(lab);
    const r1Key = keyHex(await lab.r1.executeCommand('show crypto key mypubkey rsa'));
    await install(lab.r2, '10.0.12.1', r1Key);
    expect(await ping(lab)).not.toContain('2 received');
    expect(ike.filter((m) => m.step === 'offer').length).toBe(0);
    expect(await lab.r1.executeCommand('show crypto isakmp sa detail')).toContain('RSA public key of the peer not found');
  });

  it('with a WRONG key for the responder, the responder cannot decrypt the nonce and refuses', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    const ike = ikeOnWire(lab);
    await generateKeys(lab);
    const r1Key = keyHex(await lab.r1.executeCommand('show crypto key mypubkey rsa'));
    await install(lab.r1, '10.0.12.2', r1Key);
    await install(lab.r2, '10.0.12.1', r1Key);
    expect(await ping(lab)).not.toContain('2 received');
    expect(ike.some((m) => m.step === 'offer')).toBe(true);
    expect(ike.some((m) => m.step === 'accept')).toBe(false);
    expect(await lab.r2.executeCommand('show crypto isakmp sa detail')).toContain('RSA nonce decryption failed');
  });

  it('without the initiator\'s public key the responder refuses', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    const ike = ikeOnWire(lab);
    await generateKeys(lab);
    const r2Key = keyHex(await lab.r2.executeCommand('show crypto key mypubkey rsa'));
    await install(lab.r1, '10.0.12.2', r2Key);
    expect(await ping(lab)).not.toContain('2 received');
    expect(ike.some((m) => m.step === 'accept')).toBe(false);
    expect(await lab.r2.executeCommand('show crypto isakmp sa detail')).toContain('RSA public key of the peer not found');
  });

  it('a responder with no RSA key pair of its own refuses', async () => {
    const lab = await ipsecLab([], 'rsa-encr');
    await generateKeys(lab);
    const r2Key = keyHex(await lab.r2.executeCommand('show crypto key mypubkey rsa'));
    await lab.r2.executeCommand('configure terminal');
    await lab.r2.executeCommand('crypto key zeroize rsa');
    await lab.r2.executeCommand('end');
    await install(lab.r1, '10.0.12.2', r2Key);
    expect(await ping(lab)).not.toContain('2 received');
    expect(await lab.r2.executeCommand('show crypto isakmp sa detail')).toContain('RSA key pair not found');
  });
});
