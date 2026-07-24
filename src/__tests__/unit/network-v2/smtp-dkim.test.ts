import { describe, it, expect } from 'vitest';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import {
  signDkim, verifyDkim, formatDkimSignatureHeader, parseDkimSignatureHeader,
  generateDkimSelector, type DkimKeyLookup,
} from '@/network/smtp/dkim';

function headers(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({
    From: 'alice@example.org',
    To: 'bob@example.net',
    Subject: 'Hello',
    ...overrides,
  }));
}

describe('DKIM signing and canonicalization (RFC 6376)', () => {
  it('generates a selector with a fresh RSA key pair', () => {
    const sel = generateDkimSelector('example.org');
    expect(sel.domain).toBe('example.org');
    expect(sel.selector.length).toBeGreaterThan(0);
    expect(sel.keyPair.publicKey.algorithm).toBe('rsa');
  });

  it('signs a message and produces a DKIM-Signature with the requested headers/domain/selector', () => {
    const { keyPair } = generateDkimSelector('example.org');
    const sig = signDkim(headers(), 'Hello Bob.', {
      domain: 'example.org', selector: 'sel1', privateKey: keyPair.privateKey,
      signedHeaderNames: ['From', 'To', 'Subject'],
    });
    expect(sig.domain).toBe('example.org');
    expect(sig.selector).toBe('sel1');
    expect(sig.signedHeaders).toEqual(['From', 'To', 'Subject']);
    expect(sig.canonicalization).toEqual({ header: 'relaxed', body: 'relaxed' });
    expect(sig.bodyHash.length).toBeGreaterThan(0);
    expect(sig.signature.length).toBeGreaterThan(0);
  });

  it('produces a stable body hash for relaxed canonicalization regardless of trailing blank lines', () => {
    const { keyPair } = generateDkimSelector('example.org');
    const a = signDkim(headers(), 'Body text.\r\n', { domain: 'example.org', selector: 's', privateKey: keyPair.privateKey });
    const b = signDkim(headers(), 'Body text.\r\n\r\n\r\n', { domain: 'example.org', selector: 's', privateKey: keyPair.privateKey });
    expect(a.bodyHash).toBe(b.bodyHash);
  });
});

function lookupFor(domain: string, selector: string, publicKey: ReturnType<typeof PkiKeyPair.generate>['publicKey']): DkimKeyLookup {
  return {
    resolvePublicKey: async (s, d) => (s === selector && d === domain ? publicKey : null),
  };
}

describe('verifyDkim() — real signature verification, not a simulated boolean', () => {
  it('passes for an unmodified message signed with the matching private key', async () => {
    const { keyPair } = generateDkimSelector('example.org');
    const h = headers();
    const body = 'Hello Bob.\r\n';
    const sig = signDkim(h, body, { domain: 'example.org', selector: 'sel1', privateKey: keyPair.privateKey, signedHeaderNames: ['From', 'To', 'Subject'] });
    const result = await verifyDkim(lookupFor('example.org', 'sel1', keyPair.publicKey), h, body, sig);
    expect(result).toBe('pass');
  });

  it('fails when the body is altered after signing', async () => {
    const { keyPair } = generateDkimSelector('example.org');
    const h = headers();
    const sig = signDkim(h, 'Hello Bob.\r\n', { domain: 'example.org', selector: 'sel1', privateKey: keyPair.privateKey, signedHeaderNames: ['From', 'To', 'Subject'] });
    const result = await verifyDkim(lookupFor('example.org', 'sel1', keyPair.publicKey), h, 'Hello Bob! Tampered.\r\n', sig);
    expect(result).toBe('fail');
  });

  it('fails when a signed header is altered after signing', async () => {
    const { keyPair } = generateDkimSelector('example.org');
    const h = headers();
    const body = 'Hello Bob.\r\n';
    const sig = signDkim(h, body, { domain: 'example.org', selector: 'sel1', privateKey: keyPair.privateKey, signedHeaderNames: ['From', 'To', 'Subject'] });
    const tampered = headers({ Subject: 'Wire me money' });
    const result = await verifyDkim(lookupFor('example.org', 'sel1', keyPair.publicKey), tampered, body, sig);
    expect(result).toBe('fail');
  });

  it('does not fail when an unsigned header is altered', async () => {
    const { keyPair } = generateDkimSelector('example.org');
    const h = headers({ 'X-Mailer': 'v1' });
    const body = 'Hello Bob.\r\n';
    const sig = signDkim(h, body, { domain: 'example.org', selector: 'sel1', privateKey: keyPair.privateKey, signedHeaderNames: ['From', 'To', 'Subject'] });
    const tampered = headers({ 'X-Mailer': 'v2' });
    const result = await verifyDkim(lookupFor('example.org', 'sel1', keyPair.publicKey), tampered, body, sig);
    expect(result).toBe('pass');
  });

  it('permerror when the selector key cannot be retrieved', async () => {
    const { keyPair } = generateDkimSelector('example.org');
    const h = headers();
    const body = 'Hello Bob.\r\n';
    const sig = signDkim(h, body, { domain: 'example.org', selector: 'missing', privateKey: keyPair.privateKey });
    const result = await verifyDkim(lookupFor('example.org', 'sel1', keyPair.publicKey), h, body, sig);
    expect(result).toBe('permerror');
  });

  it('fails when signed with a different key than the one published', async () => {
    const a = generateDkimSelector('example.org');
    const b = generateDkimSelector('example.org');
    const h = headers();
    const body = 'Hello Bob.\r\n';
    const sig = signDkim(h, body, { domain: 'example.org', selector: 'sel1', privateKey: a.keyPair.privateKey });
    const result = await verifyDkim(lookupFor('example.org', 'sel1', b.keyPair.publicKey), h, body, sig);
    expect(result).toBe('fail');
  });
});

describe('DKIM-Signature header formatting/parsing round-trip', () => {
  it('formats then parses back an equivalent signature', () => {
    const { keyPair } = generateDkimSelector('example.org');
    const sig = signDkim(headers(), 'Hello Bob.\r\n', {
      domain: 'example.org', selector: 'sel1', privateKey: keyPair.privateKey, signedHeaderNames: ['From', 'To', 'Subject'],
    });
    const line = formatDkimSignatureHeader(sig);
    expect(line.startsWith('DKIM-Signature: ')).toBe(true);
    expect(line).toContain('d=example.org');
    expect(line).toContain('s=sel1');
    expect(line).toContain('h=From:To:Subject');

    const parsed = parseDkimSignatureHeader(line.slice('DKIM-Signature: '.length));
    expect(parsed).toEqual(sig);
  });

  it('returns null for a malformed tag list missing required fields', () => {
    expect(parseDkimSignatureHeader('v=1; a=rsa-sha256')).toBeNull();
  });

  it('a parsed-then-verified signature still passes end to end', async () => {
    const { keyPair } = generateDkimSelector('example.org');
    const h = headers();
    const body = 'Hello Bob.\r\n';
    const sig = signDkim(h, body, { domain: 'example.org', selector: 'sel1', privateKey: keyPair.privateKey, signedHeaderNames: ['From', 'To', 'Subject'] });
    const line = formatDkimSignatureHeader(sig);
    const parsed = parseDkimSignatureHeader(line.slice('DKIM-Signature: '.length))!;
    const result = await verifyDkim(lookupFor('example.org', 'sel1', keyPair.publicKey), h, body, parsed);
    expect(result).toBe('pass');
  });
});

describe('simple canonicalization mode', () => {
  it('is sensitive to header casing/whitespace changes that relaxed would ignore', async () => {
    const { keyPair } = generateDkimSelector('example.org');
    const h = headers();
    const body = 'Hello Bob.\r\n';
    const sig = signDkim(h, body, {
      domain: 'example.org', selector: 'sel1', privateKey: keyPair.privateKey,
      signedHeaderNames: ['From', 'To', 'Subject'], headerCanon: 'simple', bodyCanon: 'simple',
    });
    expect(sig.canonicalization).toEqual({ header: 'simple', body: 'simple' });
    const okResult = await verifyDkim(lookupFor('example.org', 'sel1', keyPair.publicKey), h, body, sig);
    expect(okResult).toBe('pass');

    const reformatted = headers({ Subject: ' Hello ' });
    const failResult = await verifyDkim(lookupFor('example.org', 'sel1', keyPair.publicKey), reformatted, body, sig);
    expect(failResult).toBe('fail');
  });
});
