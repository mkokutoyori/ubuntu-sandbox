/**
 * Pure rendering rules for Cisco secrets/passwords in `show running-config`.
 *
 * The simulator historically printed the *plaintext* after a fake `secret 5` /
 * `password 0` prefix. These helpers route plaintext through real md5crypt
 * ($1$) and type-7 so the config no longer leaks the cleartext, while letting
 * already-encoded values pass through unchanged.
 */

import { describe, it, expect } from 'vitest';
import {
  renderSecretField,
  renderPasswordField,
} from '@/network/devices/shells/cisco/ciscoPasswordRender';
import { decryptType7, md5Crypt } from '@/crypto';

describe('renderSecretField (enable secret / username secret)', () => {
  it('hashes a plaintext md5 secret with real md5crypt', () => {
    const out = renderSecretField('cisco', 'md5');
    expect(out).toMatch(/^5 \$1\$[./0-9A-Za-z]{1,8}\$[./0-9A-Za-z]{22}$/);
    expect(out).not.toContain(' cisco'); // plaintext must not leak
  });

  it('is a valid md5crypt hash (verifiable by recomputation)', () => {
    const out = renderSecretField('cisco', 'md5');
    const [, saltAndHash] = out.split(' '); // "$1$<salt>$<hash>"
    const salt = saltAndHash.split('$')[2];
    expect(md5Crypt('cisco', salt)).toBe(saltAndHash);
  });

  it('passes an already-hashed $1$ value through unchanged', () => {
    expect(renderSecretField('$1$abcd$0123456789012345678901', 'md5')).toBe(
      '5 $1$abcd$0123456789012345678901',
    );
  });

  it('hashes a plaintext sha256 secret with real type-8 (PBKDF2)', () => {
    const out = renderSecretField('cisco', 'sha256');
    expect(out).toMatch(/^8 \$8\$[./0-9A-Za-z]{14}\$[./0-9A-Za-z]{43}$/);
    expect(out).not.toContain(' cisco');
  });

  it('preserves the type number of a pre-hashed $8$/$9$ value', () => {
    expect(renderSecretField('$8$abcdefghijklmn$0123', 'sha256')).toBe('8 $8$abcdefghijklmn$0123');
    expect(renderSecretField('$9$abcdefghijklmn$0123', 'sha256')).toBe('9 $9$abcdefghijklmn$0123');
  });

  it('renders a plaintext (type 0) secret verbatim', () => {
    expect(renderSecretField('cisco', 'plain')).toBe('0 cisco');
  });

  it('is deterministic', () => {
    expect(renderSecretField('cisco', 'md5')).toBe(renderSecretField('cisco', 'md5'));
  });
});

describe('renderPasswordField (enable password / line password)', () => {
  it('leaves plaintext as type 0 when service password-encryption is off', () => {
    expect(renderPasswordField('cisco', 'plain', false)).toBe('0 cisco');
  });

  it('type-7 encodes plaintext when service password-encryption is on', () => {
    const out = renderPasswordField('cisco', 'plain', true);
    expect(out.startsWith('7 ')).toBe(true);
    expect(out).not.toContain('cisco');
    expect(decryptType7(out.slice(2))).toBe('cisco');
  });

  it('passes an already type-7 value through unchanged', () => {
    expect(renderPasswordField('070C285F4D06', 'type-7', true)).toBe('7 070C285F4D06');
  });

  it('is deterministic', () => {
    expect(renderPasswordField('cisco', 'plain', true)).toBe(
      renderPasswordField('cisco', 'plain', true),
    );
  });
});
