/**
 * Sonde : le fichier de cache d'identifiants (FILE ccache, format v4 de
 * MIT Kerberos, `fcc_*` de lib/krb5/ccache/cc_file.c) que le poste Linux
 * ecrit et relit est celui du vrai `kinit`.
 *
 * Autorite : un cache ecrit par le vrai `kinit -k -t` (krb5 1.20.1) face a
 * un vrai krb5kdc, relu par le vrai `klist -C -f` qui y trouve l'entree de
 * configuration `fast_avail(krbtgt/CORP.LOCAL@CORP.LOCAL) = yes` et un TGT
 * `Flags: RI` valable du 06/10/26 14:56:42 au 07/10/26 00:56:42 (UTC),
 * renouvelable jusqu'au 07/10/26 14:56:42. Les 863 octets du fichier sont
 * recopies ci-dessous.
 *
 * Mesure avant la creation du module : `ccache/FileCcache.ts` n'existait pas,
 * le fichier de sonde ne se charge pas et les 6 cas tombent. Aucun cas ne
 * passe avant : tous importent le module.
 */
import { describe, expect, it } from 'vitest';
import { decodeCcache, encodeCcache } from '@/network/kerberos/ccache/FileCcache';

const REAL_CCACHE_HEX = [
  '0504000c00010008000000000000000000000001000000020000000a434f52502e4c4f43414c000000046c6461700000',
  '00096c6f63616c686f737400000001000000020000000a434f52502e4c4f43414c000000046c646170000000096c6f63',
  '616c686f737400000001000000030000000c582d4341434845434f4e463a000000156b7262355f6363616368655f636f',
  '6e665f646174610000000a666173745f617661696c0000001c6b72627467742f434f52502e4c4f43414c40434f52502e',
  '4c4f43414c00000000000000000000000000000000000000000000000000000000000000000000000000000379657300',
  '00000000000001000000020000000a434f52502e4c4f43414c000000046c646170000000096c6f63616c686f73740000',
  '0002000000020000000a434f52502e4c4f43414c000000066b72627467740000000a434f52502e4c4f43414c00120000',
  '00205ff74fefe6e35cd0da95fad864758b70d927acd1ae124ffb61d67714b018f6b76ac50c2a6ac50c2a6ac598ca6ac6',
  '5daa0000c100000000000000000000000001c8618201c4308201c0a003020105a10c1b0a434f52502e4c4f43414ca21f',
  '301da003020102a11630141b066b72627467741b0a434f52502e4c4f43414ca382018830820184a003020112a1030201',
  '01a282017604820172f0fc72fe8c47e2ba33eb8b74085d4db7df37cc99fce62952aebc67b377d1198b94813cf0bdef92',
  '56a64009b9e7c2f38823e82ae3844bc19aeca6e42dc7799959c23a13d5871628d7e2611eb516ae69a20452bbde4a8894',
  'dcb6b346af4a4088d1eb8da078ec2680b2bc1c318e6574654f905a93e4d26ad36b9650e607ca8f4fc73c1f539dc330f2',
  '2fb13a5a24c54116e6dd68d8a45e654b721e4f355d8fd759dc675819a1ed4faad46e4c4e4a381180a285e1c44ebe243e',
  '45c667f0e7dc967c8b25601fde87e844b63ebb0372df9b11474f3d280a31cfb61dfc7a4ad7eec4c6b3a1b3a7e2d70f43',
  '68ec0ffd47984219e5ad3c3f274649a875259e7b36d0fc399fc17e5cf4246eb2d22d8f2c389c857d948e3f9bc15f4852',
  '36347fb98fc9b5b6147f8e2eb78b22cac980640553d40ded7476c666f285abf94257303cf19ac0c04c6b84ee53d40274',
  '5d77d84454d53615071a0e4827ae24c8a9f2a506559f4fe792cec2ebd958d9f3e53a9b1935857c82ed723700000000'
].join('');

const REAL_CCACHE = Uint8Array.from(Buffer.from(REAL_CCACHE_HEX, 'hex'));
const START = Date.UTC(2026, 9, 6, 14, 56, 42) / 1000;
const TICKET_RENEWABLE = 1 << 23;
const TICKET_INITIAL = 1 << 22;
const TICKET_ENC_PA_REP = 1 << 16;

describe('the credential cache file is the one the real kinit writes', () => {
  it('the recorded file has the version 4 magic', () => {
    expect(REAL_CCACHE.length).toBe(863);
    expect([REAL_CCACHE[0], REAL_CCACHE[1]]).toEqual([0x05, 0x04]);
  });

  it('reads the default principal', () => {
    const cache = decodeCcache(REAL_CCACHE)!;
    expect(cache.defaultPrincipal.realm).toBe('CORP.LOCAL');
    expect(cache.defaultPrincipal.components).toEqual(['ldap', 'localhost']);
    expect(cache.defaultPrincipal.nameType).toBe(1);
  });

  it('reads the configuration entry the real client stores beside the tickets', () => {
    const cache = decodeCcache(REAL_CCACHE)!;
    expect(cache.credentials).toHaveLength(2);
    const configuration = cache.credentials[0];
    expect(configuration.server.realm).toBe('X-CACHECONF:');
    expect(configuration.server.components).toEqual(['krb5_ccache_conf_data', 'fast_avail', 'krbtgt/CORP.LOCAL@CORP.LOCAL']);
    expect(Buffer.from(configuration.ticket).toString('latin1')).toBe('yes');
  });

  it('reads the ticket-granting ticket with its times, flags and key type', () => {
    const credential = decodeCcache(REAL_CCACHE)!.credentials[1];
    expect(credential.server.components).toEqual(['krbtgt', 'CORP.LOCAL']);
    expect(credential.keyType).toBe(18);
    expect(credential.key).toHaveLength(32);
    expect(credential.startTime).toBe(START);
    expect(credential.endTime - credential.startTime).toBe(10 * 3600);
    expect(credential.renewTill - credential.startTime).toBe(24 * 3600);
    expect(credential.flags).toBe(TICKET_RENEWABLE | TICKET_INITIAL | TICKET_ENC_PA_REP);
    expect(credential.addresses).toEqual([]);
  });

  it('writes back the same 863 bytes it read', () => {
    expect(Buffer.from(encodeCcache(decodeCcache(REAL_CCACHE)!)).toString('hex')).toBe(REAL_CCACHE_HEX);
  });

  it('refuses a file that is not a credential cache', () => {
    expect(decodeCcache(Uint8Array.from([0x05, 0x01, 0x00, 0x00]))).toBeNull();
  });
});
