import { describe, it, expect } from 'vitest';
import { attr, type RadiusPacket } from '@/network/radius/types';
import {
  randomRequestAuthenticator,
  computeResponseAuthenticator, withResponseAuthenticator, verifyResponseAuthenticator,
  computeMessageAuthenticator, withMessageAuthenticator, verifyMessageAuthenticator,
} from '@/network/radius/authenticators';

const REQUEST_AUTH = 'ab'.repeat(16);
const SECRET = 'shared-secret';

function baseResponse(): RadiusPacket {
  return {
    type: 'radius', code: 'access-accept', identifier: 7,
    authenticator: '00'.repeat(16),
    attributes: [attr('reply-message', 'Welcome')],
  };
}

describe('RADIUS integrity — randomRequestAuthenticator', () => {
  it('produces a 16-byte (32 hex char) value', () => {
    expect(randomRequestAuthenticator()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is not constant across calls', () => {
    const values = new Set(Array.from({ length: 20 }, () => randomRequestAuthenticator()));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('RADIUS integrity — Response Authenticator (RFC 2865 §3)', () => {
  it('a response signed with withResponseAuthenticator verifies with the same secret', () => {
    const signed = withResponseAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    expect(verifyResponseAuthenticator(signed, REQUEST_AUTH, SECRET)).toBe(true);
  });

  it('fails verification under a different shared secret', () => {
    const signed = withResponseAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    expect(verifyResponseAuthenticator(signed, REQUEST_AUTH, 'wrong-secret')).toBe(false);
  });

  it('fails verification if the request authenticator used differs', () => {
    const signed = withResponseAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    expect(verifyResponseAuthenticator(signed, 'ff'.repeat(16), SECRET)).toBe(false);
  });

  it('fails verification if an attribute is tampered with after signing', () => {
    const signed = withResponseAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    const tampered: RadiusPacket = {
      ...signed,
      attributes: [attr('reply-message', 'Tampered!')],
    };
    expect(verifyResponseAuthenticator(tampered, REQUEST_AUTH, SECRET)).toBe(false);
  });

  it('is deterministic: computing twice over the same inputs gives the same authenticator', () => {
    const a = computeResponseAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    const b = computeResponseAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('RADIUS integrity — Message-Authenticator (RFC 2869 §5.14)', () => {
  it('withMessageAuthenticator adds the attribute and it verifies', () => {
    const signed = withMessageAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    const maAttr = signed.attributes.find((a) => a.type === 'message-authenticator');
    expect(maAttr?.value).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyMessageAuthenticator(signed, REQUEST_AUTH, SECRET)).toBe(true);
  });

  it('replaces an existing placeholder rather than duplicating the attribute', () => {
    const withPlaceholder: RadiusPacket = {
      ...baseResponse(),
      attributes: [...baseResponse().attributes, attr('message-authenticator', '00'.repeat(16))],
    };
    const signed = withMessageAuthenticator(withPlaceholder, REQUEST_AUTH, SECRET);
    const maAttrs = signed.attributes.filter((a) => a.type === 'message-authenticator');
    expect(maAttrs.length).toBe(1);
    expect(maAttrs[0].value).not.toBe('00'.repeat(16));
  });

  it('fails verification under a different shared secret', () => {
    const signed = withMessageAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    expect(verifyMessageAuthenticator(signed, REQUEST_AUTH, 'wrong-secret')).toBe(false);
  });

  it('fails verification if the packet is tampered with after signing', () => {
    const signed = withMessageAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    const tampered: RadiusPacket = { ...signed, identifier: 99 };
    expect(verifyMessageAuthenticator(tampered, REQUEST_AUTH, SECRET)).toBe(false);
  });

  it('treats an absent Message-Authenticator as verified (RFC 3579 §3.2: only mandatory for EAP)', () => {
    expect(verifyMessageAuthenticator(baseResponse(), REQUEST_AUTH, SECRET)).toBe(true);
  });

  it('computeMessageAuthenticator is deterministic over the same inputs', () => {
    const a = computeMessageAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    const b = computeMessageAuthenticator(baseResponse(), REQUEST_AUTH, SECRET);
    expect(a).toBe(b);
  });
});
