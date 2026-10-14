/**
 * Cisco type 4 secrets (official_docs/cisco/ios-security, `username secret`, `enable secret`,
 * Commands S to Z / D to L): `secret 4 <hash>` is SHA-256 of the password, written with the crypt
 * alphabet ("./0-9A-Za-z") and no padding, 43 characters, no salt.
 *
 * The one vector the books give is `tnhtc92DXBhelxjYk8LWJrPV36S2i4ntXrpb4RFmfqY` (in both the
 * `username secret` and the `enable secret` examples). Its clear text is not printed: it was found by
 * trying the usual lab passwords against the SHA-256 construction above, and it is `cisco`. That match
 * on a published value is what makes the construction a fact and not a guess.
 *
 * Measured with src stashed to HEAD: ciscoType4 does not exist, `enable secret 4 <hash>` stored the
 * words "4 <hash>" as a clear password, and a type 4 `username` secret never authenticated, so the
 * 8 cases that need them fall; the witness (a type 5 secret still authenticates) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { ciscoType4, isCiscoType4 } from '@/crypto';
import { ciscoPasswordMatches } from '@/network/devices/shells/cisco/ciscoPasswordVerify';

const BOOK_HASH = 'tnhtc92DXBhelxjYk8LWJrPV36S2i4ntXrpb4RFmfqY';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function configured(lines: string[]): Promise<{ router: CiscoRouter; outputs: string[] }> {
  const router = new CiscoRouter('R1');
  const outputs: string[] = [];
  for (const line of ['enable', 'configure terminal', ...lines]) outputs.push(await router.executeCommand(line));
  await router.executeCommand('end');
  return { router, outputs };
}

describe('the type 4 digest', () => {
  it("reproduces the book's published hash from the password cisco", () => {
    expect(ciscoType4('cisco')).toBe(BOOK_HASH);
  });

  it('is 43 characters of the crypt alphabet, and different passwords give different digests', () => {
    expect(isCiscoType4(ciscoType4('anything'))).toBe(true);
    expect(ciscoType4('a')).not.toBe(ciscoType4('b'));
  });

  it('verification accepts the right password and refuses the others', () => {
    expect(ciscoPasswordMatches('cisco', BOOK_HASH, 'type-4')).toBe(true);
    expect(ciscoPasswordMatches('Cisco', BOOK_HASH, 'type-4')).toBe(false);
    expect(ciscoPasswordMatches(BOOK_HASH, BOOK_HASH, 'type-4')).toBe(false);
  });
});

describe('username secret 4', () => {
  it('authenticates with the password behind the hash, not with the hash text', async () => {
    const { router } = await configured([`username demo secret 4 ${BOOK_HASH}`]);
    const store = router.getCredentialStore();
    expect(store.authenticate('demo', 'cisco')).toBe(true);
    expect(store.authenticate('demo', BOOK_HASH)).toBe(false);
    expect(store.authenticate('demo', 'wrong')).toBe(false);
  });

  it('a value that is no type 4 digest is refused', async () => {
    const { outputs } = await configured(['username demo secret 4 tooshort']);
    expect(outputs.at(-1)).toContain('The secret you entered is not a valid encrypted secret.');
    expect(outputs.at(-1)).toContain('do not specify type 4 encryption');
  });
});

describe('enable secret 4', () => {
  it("keeps the book's line, warns, and is rendered as typed", async () => {
    const { router, outputs } = await configured([`enable secret 4 ${BOOK_HASH}`]);
    expect(outputs.at(-1)).toContain('Type 4 passwords have been');
    expect(outputs.at(-1)).toContain('Migrate to a supported password type');
    expect(await router.executeCommand('show running-config')).toContain(`enable secret 4 ${BOOK_HASH}`);
  });

  it('the enable password is the one behind the hash', async () => {
    const { router } = await configured([`enable secret 4 ${BOOK_HASH}`]);
    const secret = router.getEnableSecret()!;
    expect(ciscoPasswordMatches('cisco', secret.value, secret.algo)).toBe(true);
    expect(ciscoPasswordMatches('4 ' + BOOK_HASH, secret.value, secret.algo)).toBe(false);
  });

  it('a type 5 secret that is no hash is refused instead of being taken for a password', async () => {
    const { router, outputs } = await configured(['enable secret 5 notahash']);
    expect(outputs.at(-1)).toContain('The secret you entered is not a valid encrypted secret.');
    expect(router.getEnableSecret()).toBeNull();
  });

  it('witness: a type 5 secret still authenticates', async () => {
    const { router } = await configured(['enable secret 0 cisco']);
    const secret = router.getEnableSecret()!;
    expect(ciscoPasswordMatches('cisco', secret.value, secret.algo)).toBe(true);
  });
});
