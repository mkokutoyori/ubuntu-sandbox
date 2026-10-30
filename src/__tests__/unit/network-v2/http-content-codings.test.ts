/**
 * Décodage des codages de contenu HTTP, tel que libcurl 8.5.0 le fait
 * (lib/content_encoding.c : `encodings[]`, `Curl_build_unencoding_stack`,
 * `Curl_all_content_encodings`, `error_do_write`, `process_zlib_error`).
 *
 * Mesuré avant le correctif : aucun module ne décodait `Content-Encoding`
 * (`grep -i content-encoding src/network/http` : deux tables HPACK/QPACK
 * et rien d'autre), et `curl --compressed` était refusé comme par un curl
 * sans libz alors que `rsyslog/Zlib.ts` porte tout le codec.
 *
 * Ce que la source fixe, et que ces cas reprennent :
 *  - les noms connus sont `identity` (alias `none`), `deflate`, `gzip`
 *    (alias `x-gzip`), comparés sans casse ; la liste annoncée est donc
 *    `deflate, gzip` (identity est le nom par défaut, il est exclu) ;
 *  - la liste est celle des codages APPLIQUÉS dans l'ordre (RFC 9110
 *    §8.4.1) : le dernier cité se décode en premier
 *    (`Curl_cwriter_add` insère « first in its phase ») ;
 *  - le cinquième codage est refusé (`MAX_ENCODE_STACK` = 5 et le test
 *    est `count + 1 >= 5`) ;
 *  - un nom inconnu n'échoue qu'à l'écriture d'un CORPS (`error_do_write`
 *    ne refuse que `CLIENTWRITE_BODY`) : sans octet de corps, pas d'erreur ;
 *  - `deflate` accepte le format zlib ET le flux brut (repli sur
 *    `Z_DATA_ERROR`).
 *
 * Discrimination par `git stash` : tous les cas tombent (le module
 * n'existe pas) ; le témoin qui passe malgré tout est « sans en-tête, le
 * corps traverse inchangé ».
 */

import { describe, it, expect } from 'vitest';
import { gzipCompress, zlibCompress } from '@/network/rsyslog/Zlib';
import {
  decodeContentCodings, ACCEPT_ENCODING_VALUE, MAX_DECODED_BYTES,
} from '@/network/http/ContentCodings';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const show = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const SAMPLE = 'compressible '.repeat(64);

function rawDeflate(data: Uint8Array): Uint8Array {
  const wrapped = zlibCompress(data, 6);
  return wrapped.subarray(2, wrapped.length - 4);
}

function ok(body: Uint8Array, header: string | undefined): string {
  const out = decodeContentCodings(body, header);
  if (out.ok === false) throw new Error(out.message);
  return show(out.body);
}

describe('ce que curl annonce', () => {
  it('Accept-Encoding vaut « deflate, gzip » (identity exclu, ni br ni zstd sans leurs bibliothèques)', () => {
    expect(ACCEPT_ENCODING_VALUE).toBe('deflate, gzip');
  });
});

describe('noms connus', () => {
  const gz = gzipCompress(text(SAMPLE), 6);
  for (const name of ['gzip', 'GZIP', 'x-gzip', 'X-Gzip', '  gzip  ']) {
    it(`« ${name} » décode un flux gzip`, () => {
      expect(ok(gz, name)).toBe(SAMPLE);
    });
  }
  it('deflate décode le format zlib', () => {
    expect(ok(zlibCompress(text(SAMPLE), 6), 'deflate')).toBe(SAMPLE);
  });
  it('deflate décode aussi un flux brut (repli de libcurl)', () => {
    expect(ok(rawDeflate(text(SAMPLE)), 'deflate')).toBe(SAMPLE);
  });
  for (const name of ['identity', 'none', 'IDENTITY']) {
    it(`« ${name} » laisse passer le corps tel quel`, () => {
      expect(ok(text('abc'), name)).toBe('abc');
    });
  }
  it('WITNESS : sans en-tête, le corps traverse inchangé', () => {
    const body = text('abc');
    const out = decodeContentCodings(body, undefined);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.body).toBe(body);
  });
});

describe('plusieurs codages : l\'ordre d\'application, lu à l\'envers', () => {
  it('« deflate, gzip » : deflate appliqué d\'abord, donc gzip se retire d\'abord', () => {
    const body = gzipCompress(zlibCompress(text(SAMPLE), 6), 6);
    expect(ok(body, 'deflate, gzip')).toBe(SAMPLE);
  });
  it('« gzip, deflate » n\'est pas « deflate, gzip »', () => {
    const body = gzipCompress(zlibCompress(text(SAMPLE), 6), 6);
    const out = decodeContentCodings(body, 'gzip, deflate');
    expect(out.ok).toBe(false);
  });
  it('« gzip, identity » : identity ne change rien', () => {
    expect(ok(gzipCompress(text(SAMPLE), 6), 'gzip, identity')).toBe(SAMPLE);
  });
  it('des virgules et des blancs en trop sont ignorés', () => {
    expect(ok(gzipCompress(text(SAMPLE), 6), ' , gzip ,, ')).toBe(SAMPLE);
  });
  it('quatre codages passent, le cinquième est refusé', () => {
    const four = decodeContentCodings(text('abc'), 'identity, identity, identity, identity');
    expect(four.ok).toBe(true);
    const five = decodeContentCodings(text('abc'), 'identity, identity, identity, identity, identity');
    expect(five).toEqual({ ok: false, message: 'Reject response due to more than 5 content encodings' });
  });
});

describe('ce qui échoue, avec les mots de libcurl', () => {
  it('un codage inconnu : « Unrecognized content encoding type… »', () => {
    expect(decodeContentCodings(text('abc'), 'br')).toEqual({
      ok: false,
      message: 'Unrecognized content encoding type. libcurl understands deflate, gzip content encodings.',
    });
  });
  it('un inconnu parmi des connus fait échouer toute la liste', () => {
    expect(decodeContentCodings(gzipCompress(text(SAMPLE), 6), 'gzip, zstd').ok).toBe(false);
  });
  it('sans octet de corps, un codage inconnu n\'échoue pas (erreur différée à l\'écriture)', () => {
    expect(decodeContentCodings(new Uint8Array(0), 'br').ok).toBe(true);
  });
  it('un gzip corrompu : « Error while processing content unencoding: … »', () => {
    const bad = gzipCompress(text(SAMPLE), 6);
    bad[bad.length - 6] ^= 0xff;
    const out = decodeContentCodings(bad, 'gzip');
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.message).toMatch(/^Error while processing content unencoding: /);
  });
  it('des octets quelconques déclarés gzip échouent de même', () => {
    const out = decodeContentCodings(text('not a gzip stream at all'), 'gzip');
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.message).toMatch(/^Error while processing content unencoding: /);
  });
  it('un flux tronqué échoue', () => {
    const cut = gzipCompress(text(SAMPLE), 6).subarray(0, 30);
    expect(decodeContentCodings(cut, 'gzip').ok).toBe(false);
  });
  it('la sortie est bornée : au-delà du plafond, échec plutôt que mémoire illimitée', () => {
    const body = zlibCompress(text(SAMPLE), 6);
    expect(decodeContentCodings(body, 'deflate', SAMPLE.length).ok).toBe(true);
    const out = decodeContentCodings(body, 'deflate', SAMPLE.length - 1);
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.message).toMatch(/^Error while processing content unencoding: /);
  });
  it('le plafond par défaut est de 16 Mio', () => {
    expect(MAX_DECODED_BYTES).toBe(16 * 1024 * 1024);
  });
});
