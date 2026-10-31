/**
 * crypt(3) $5$ et $6$ (Drepper, SHA-crypt) : sha256Crypt et sha512Crypt reproduisent « openssl passwd -5|-6 -salt » de l'OpenSSL installé, au caractère près.
 * Mesure de départ : le module n'existait pas ; les 8 cas tombent avant (import absent).
 */

import { describe, it, expect } from 'vitest';
import { sha256Crypt, sha512Crypt, verifySha512Crypt, verifyCrypt } from '@/crypto/passwords';

describe('sha512Crypt', () => {
  it('admin', () => { expect(sha512Crypt('admin', 'saltsalt')).toBe('$6$saltsalt$ZxoUf1bJzACFdk9GZkBGmxXd3Rq8nUoGjgon4GVoI91SlW41Ew2djlh60PmWr4flwags.7ULrKVSSmnCEsIOj1'); });
  it('Secret123', () => { expect(sha512Crypt('Secret123', 'saltsalt')).toBe('$6$saltsalt$596V/oWeqDUXikIcakwaVX6pWhdXYIaQpIw8X3rtkywYRQfVfT70YEfXA4yOmR83SMYxs3GVnB5Ma856rkf9Q1'); });
  it('mot de passe plus long que 64 octets', () => {
    expect(sha512Crypt('a very long password that goes beyond sixty-four characters in total length ok yes', 'saltsalt'))
      .toBe('$6$saltsalt$3gEaD8uI.MHT3OPwfLOZm1skvB.E6c3FarmZDHXdRPQ9u4kOYRbkWEexeUTCjo5Qlv6cH61tbZy820UmttrG1/');
  });
  it('sel de seize caractères', () => {
    expect(sha512Crypt('x', 'abcdefghijklmnop')).toBe('$6$abcdefghijklmnop$4MjOne1jVRKP4IuHRPFedC4vlQHNjvcBfQJVlfB8ciQ5YUzW2g81Pyw4sptw4femJ071/eApI0WDsBAOOCmTl0');
  });
  it('vérification', () => {
    const secret = sha512Crypt('admin', 'saltsalt');
    expect(verifySha512Crypt(secret, 'admin')).toBe(true);
    expect(verifySha512Crypt(secret, 'Admin')).toBe(false);
  });
  it('$5$ admin', () => { expect(sha256Crypt('admin', 'saltsalt')).toBe('$5$saltsalt$ajilCybiF3oQBEfeTHO1rkbsmz9HcJplt.gHWXkRfD4'); });
  it('$5$ mot de passe long', () => {
    expect(sha256Crypt('a very long password that goes beyond sixty-four characters in total length ok yes', 'saltsalt'))
      .toBe('$5$saltsalt$jH47rr6pdKRquJPbDPISWkY1kBzFg2.7W8r5f.reqYC');
  });
  it('verifyCrypt reconnaît $5$, $6$ et refuse le reste', () => {
    expect(verifyCrypt('$5$saltsalt$ajilCybiF3oQBEfeTHO1rkbsmz9HcJplt.gHWXkRfD4', 'admin')).toBe(true);
    expect(verifyCrypt('!', 'admin')).toBe(false);
  });
});
