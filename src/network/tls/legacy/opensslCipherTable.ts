export type OpensslKeyExchange = 'RSA' | 'DHE' | 'ECDHE';
export type OpensslAuth = 'RSA' | 'ECDSA';
export type OpensslEnc =
  | '3DES' | 'AES128' | 'AES256' | 'AES128GCM' | 'AES256GCM' | 'AES128CCM' | 'AES256CCM'
  | 'AES128CCM8' | 'AES256CCM8' | 'CHACHA20' | 'CAMELLIA128' | 'CAMELLIA256' | 'ARIA128GCM' | 'ARIA256GCM';
export type OpensslMac = 'SHA1' | 'SHA256' | 'SHA384' | 'AEAD';
export type OpensslMinTls = 'SSL3' | 'TLS1' | 'TLS1_2';
export type OpensslStrengthFlag = 'HIGH' | 'MEDIUM' | 'LOW' | 'FIPS' | 'NOT_DEFAULT';

export interface OpensslCipherEntry {
  readonly openssl: string;
  readonly standard: string;
  readonly code: number;
  readonly mkey: OpensslKeyExchange;
  readonly auth: OpensslAuth;
  readonly enc: OpensslEnc;
  readonly mac: OpensslMac;
  readonly minTls: OpensslMinTls;
  readonly flags: readonly OpensslStrengthFlag[];
  readonly prf: 'DEFAULT' | 'SHA256' | 'SHA384';
  readonly strengthBits: number;
}

export const OPENSSL_CIPHER_TABLE: readonly OpensslCipherEntry[] = [
  { openssl: 'DES-CBC3-SHA', standard: 'TLS_RSA_WITH_3DES_EDE_CBC_SHA', code: 0x000a, mkey: 'RSA', auth: 'RSA', enc: '3DES', mac: 'SHA1', minTls: 'SSL3', flags: ['NOT_DEFAULT', 'MEDIUM', 'FIPS'], prf: 'DEFAULT', strengthBits: 112 },
  { openssl: 'DHE-RSA-DES-CBC3-SHA', standard: 'TLS_DHE_RSA_WITH_3DES_EDE_CBC_SHA', code: 0x0016, mkey: 'DHE', auth: 'RSA', enc: '3DES', mac: 'SHA1', minTls: 'SSL3', flags: ['NOT_DEFAULT', 'MEDIUM', 'FIPS'], prf: 'DEFAULT', strengthBits: 112 },
  { openssl: 'AES128-SHA', standard: 'TLS_RSA_WITH_AES_128_CBC_SHA', code: 0x002f, mkey: 'RSA', auth: 'RSA', enc: 'AES128', mac: 'SHA1', minTls: 'SSL3', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 128 },
  { openssl: 'DHE-RSA-AES128-SHA', standard: 'TLS_DHE_RSA_WITH_AES_128_CBC_SHA', code: 0x0033, mkey: 'DHE', auth: 'RSA', enc: 'AES128', mac: 'SHA1', minTls: 'SSL3', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 128 },
  { openssl: 'AES256-SHA', standard: 'TLS_RSA_WITH_AES_256_CBC_SHA', code: 0x0035, mkey: 'RSA', auth: 'RSA', enc: 'AES256', mac: 'SHA1', minTls: 'SSL3', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 256 },
  { openssl: 'DHE-RSA-AES256-SHA', standard: 'TLS_DHE_RSA_WITH_AES_256_CBC_SHA', code: 0x0039, mkey: 'DHE', auth: 'RSA', enc: 'AES256', mac: 'SHA1', minTls: 'SSL3', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 256 },
  { openssl: 'AES128-SHA256', standard: 'TLS_RSA_WITH_AES_128_CBC_SHA256', code: 0x003c, mkey: 'RSA', auth: 'RSA', enc: 'AES128', mac: 'SHA256', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 128 },
  { openssl: 'AES256-SHA256', standard: 'TLS_RSA_WITH_AES_256_CBC_SHA256', code: 0x003d, mkey: 'RSA', auth: 'RSA', enc: 'AES256', mac: 'SHA256', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 256 },
  { openssl: 'DHE-RSA-AES128-SHA256', standard: 'TLS_DHE_RSA_WITH_AES_128_CBC_SHA256', code: 0x0067, mkey: 'DHE', auth: 'RSA', enc: 'AES128', mac: 'SHA256', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 128 },
  { openssl: 'DHE-RSA-AES256-SHA256', standard: 'TLS_DHE_RSA_WITH_AES_256_CBC_SHA256', code: 0x006b, mkey: 'DHE', auth: 'RSA', enc: 'AES256', mac: 'SHA256', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 256 },
  { openssl: 'AES128-GCM-SHA256', standard: 'TLS_RSA_WITH_AES_128_GCM_SHA256', code: 0x009c, mkey: 'RSA', auth: 'RSA', enc: 'AES128GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'AES256-GCM-SHA384', standard: 'TLS_RSA_WITH_AES_256_GCM_SHA384', code: 0x009d, mkey: 'RSA', auth: 'RSA', enc: 'AES256GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'DHE-RSA-AES128-GCM-SHA256', standard: 'TLS_DHE_RSA_WITH_AES_128_GCM_SHA256', code: 0x009e, mkey: 'DHE', auth: 'RSA', enc: 'AES128GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'DHE-RSA-AES256-GCM-SHA384', standard: 'TLS_DHE_RSA_WITH_AES_256_GCM_SHA384', code: 0x009f, mkey: 'DHE', auth: 'RSA', enc: 'AES256GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'AES128-CCM', standard: 'TLS_RSA_WITH_AES_128_CCM', code: 0xc09c, mkey: 'RSA', auth: 'RSA', enc: 'AES128CCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'AES256-CCM', standard: 'TLS_RSA_WITH_AES_256_CCM', code: 0xc09d, mkey: 'RSA', auth: 'RSA', enc: 'AES256CCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'DHE-RSA-AES128-CCM', standard: 'TLS_DHE_RSA_WITH_AES_128_CCM', code: 0xc09e, mkey: 'DHE', auth: 'RSA', enc: 'AES128CCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'DHE-RSA-AES256-CCM', standard: 'TLS_DHE_RSA_WITH_AES_256_CCM', code: 0xc09f, mkey: 'DHE', auth: 'RSA', enc: 'AES256CCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'AES128-CCM8', standard: 'TLS_RSA_WITH_AES_128_CCM_8', code: 0xc0a0, mkey: 'RSA', auth: 'RSA', enc: 'AES128CCM8', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'AES256-CCM8', standard: 'TLS_RSA_WITH_AES_256_CCM_8', code: 0xc0a1, mkey: 'RSA', auth: 'RSA', enc: 'AES256CCM8', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'DHE-RSA-AES128-CCM8', standard: 'TLS_DHE_RSA_WITH_AES_128_CCM_8', code: 0xc0a2, mkey: 'DHE', auth: 'RSA', enc: 'AES128CCM8', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'DHE-RSA-AES256-CCM8', standard: 'TLS_DHE_RSA_WITH_AES_256_CCM_8', code: 0xc0a3, mkey: 'DHE', auth: 'RSA', enc: 'AES256CCM8', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-AES128-CCM', standard: 'TLS_ECDHE_ECDSA_WITH_AES_128_CCM', code: 0xc0ac, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES128CCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ECDHE-ECDSA-AES256-CCM', standard: 'TLS_ECDHE_ECDSA_WITH_AES_256_CCM', code: 0xc0ad, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES256CCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-AES128-CCM8', standard: 'TLS_ECDHE_ECDSA_WITH_AES_128_CCM_8', code: 0xc0ae, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES128CCM8', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ECDHE-ECDSA-AES256-CCM8', standard: 'TLS_ECDHE_ECDSA_WITH_AES_256_CCM_8', code: 0xc0af, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES256CCM8', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-DES-CBC3-SHA', standard: 'TLS_ECDHE_ECDSA_WITH_3DES_EDE_CBC_SHA', code: 0xc008, mkey: 'ECDHE', auth: 'ECDSA', enc: '3DES', mac: 'SHA1', minTls: 'TLS1', flags: ['NOT_DEFAULT', 'MEDIUM', 'FIPS'], prf: 'DEFAULT', strengthBits: 112 },
  { openssl: 'ECDHE-ECDSA-AES128-SHA', standard: 'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA', code: 0xc009, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES128', mac: 'SHA1', minTls: 'TLS1', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 128 },
  { openssl: 'ECDHE-ECDSA-AES256-SHA', standard: 'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA', code: 0xc00a, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES256', mac: 'SHA1', minTls: 'TLS1', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 256 },
  { openssl: 'ECDHE-RSA-DES-CBC3-SHA', standard: 'TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA', code: 0xc012, mkey: 'ECDHE', auth: 'RSA', enc: '3DES', mac: 'SHA1', minTls: 'TLS1', flags: ['NOT_DEFAULT', 'MEDIUM', 'FIPS'], prf: 'DEFAULT', strengthBits: 112 },
  { openssl: 'ECDHE-RSA-AES128-SHA', standard: 'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA', code: 0xc013, mkey: 'ECDHE', auth: 'RSA', enc: 'AES128', mac: 'SHA1', minTls: 'TLS1', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 128 },
  { openssl: 'ECDHE-RSA-AES256-SHA', standard: 'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA', code: 0xc014, mkey: 'ECDHE', auth: 'RSA', enc: 'AES256', mac: 'SHA1', minTls: 'TLS1', flags: ['HIGH', 'FIPS'], prf: 'DEFAULT', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-AES128-SHA256', standard: 'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256', code: 0xc023, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES128', mac: 'SHA256', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ECDHE-ECDSA-AES256-SHA384', standard: 'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA384', code: 0xc024, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES256', mac: 'SHA384', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'ECDHE-RSA-AES128-SHA256', standard: 'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256', code: 0xc027, mkey: 'ECDHE', auth: 'RSA', enc: 'AES128', mac: 'SHA256', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ECDHE-RSA-AES256-SHA384', standard: 'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384', code: 0xc028, mkey: 'ECDHE', auth: 'RSA', enc: 'AES256', mac: 'SHA384', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-AES128-GCM-SHA256', standard: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', code: 0xc02b, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES128GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ECDHE-ECDSA-AES256-GCM-SHA384', standard: 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', code: 0xc02c, mkey: 'ECDHE', auth: 'ECDSA', enc: 'AES256GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'ECDHE-RSA-AES128-GCM-SHA256', standard: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', code: 0xc02f, mkey: 'ECDHE', auth: 'RSA', enc: 'AES128GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ECDHE-RSA-AES256-GCM-SHA384', standard: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384', code: 0xc030, mkey: 'ECDHE', auth: 'RSA', enc: 'AES256GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH', 'FIPS'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'DHE-RSA-CHACHA20-POLY1305', standard: 'TLS_DHE_RSA_WITH_CHACHA20_POLY1305_SHA256', code: 0xccaa, mkey: 'DHE', auth: 'RSA', enc: 'CHACHA20', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'ECDHE-RSA-CHACHA20-POLY1305', standard: 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256', code: 0xcca8, mkey: 'ECDHE', auth: 'RSA', enc: 'CHACHA20', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-CHACHA20-POLY1305', standard: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256', code: 0xcca9, mkey: 'ECDHE', auth: 'ECDSA', enc: 'CHACHA20', mac: 'AEAD', minTls: 'TLS1_2', flags: ['HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-CAMELLIA256-SHA384', standard: 'TLS_ECDHE_ECDSA_WITH_CAMELLIA_256_CBC_SHA384', code: 0xc073, mkey: 'ECDHE', auth: 'ECDSA', enc: 'CAMELLIA256', mac: 'SHA384', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'ECDHE-RSA-CAMELLIA256-SHA384', standard: 'TLS_ECDHE_RSA_WITH_CAMELLIA_256_CBC_SHA384', code: 0xc077, mkey: 'ECDHE', auth: 'RSA', enc: 'CAMELLIA256', mac: 'SHA384', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'DHE-RSA-CAMELLIA256-SHA256', standard: 'TLS_DHE_RSA_WITH_CAMELLIA_256_CBC_SHA256', code: 0x00c4, mkey: 'DHE', auth: 'RSA', enc: 'CAMELLIA256', mac: 'SHA256', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-CAMELLIA128-SHA256', standard: 'TLS_ECDHE_ECDSA_WITH_CAMELLIA_128_CBC_SHA256', code: 0xc072, mkey: 'ECDHE', auth: 'ECDSA', enc: 'CAMELLIA128', mac: 'SHA256', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ECDHE-RSA-CAMELLIA128-SHA256', standard: 'TLS_ECDHE_RSA_WITH_CAMELLIA_128_CBC_SHA256', code: 0xc076, mkey: 'ECDHE', auth: 'RSA', enc: 'CAMELLIA128', mac: 'SHA256', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'DHE-RSA-CAMELLIA128-SHA256', standard: 'TLS_DHE_RSA_WITH_CAMELLIA_128_CBC_SHA256', code: 0x00be, mkey: 'DHE', auth: 'RSA', enc: 'CAMELLIA128', mac: 'SHA256', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'DHE-RSA-CAMELLIA256-SHA', standard: 'TLS_DHE_RSA_WITH_CAMELLIA_256_CBC_SHA', code: 0x0088, mkey: 'DHE', auth: 'RSA', enc: 'CAMELLIA256', mac: 'SHA1', minTls: 'SSL3', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'DEFAULT', strengthBits: 256 },
  { openssl: 'DHE-RSA-CAMELLIA128-SHA', standard: 'TLS_DHE_RSA_WITH_CAMELLIA_128_CBC_SHA', code: 0x0045, mkey: 'DHE', auth: 'RSA', enc: 'CAMELLIA128', mac: 'SHA1', minTls: 'SSL3', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'DEFAULT', strengthBits: 128 },
  { openssl: 'CAMELLIA256-SHA256', standard: 'TLS_RSA_WITH_CAMELLIA_256_CBC_SHA256', code: 0x00c0, mkey: 'RSA', auth: 'RSA', enc: 'CAMELLIA256', mac: 'SHA256', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 256 },
  { openssl: 'CAMELLIA128-SHA256', standard: 'TLS_RSA_WITH_CAMELLIA_128_CBC_SHA256', code: 0x00ba, mkey: 'RSA', auth: 'RSA', enc: 'CAMELLIA128', mac: 'SHA256', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'CAMELLIA256-SHA', standard: 'TLS_RSA_WITH_CAMELLIA_256_CBC_SHA', code: 0x0084, mkey: 'RSA', auth: 'RSA', enc: 'CAMELLIA256', mac: 'SHA1', minTls: 'SSL3', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'DEFAULT', strengthBits: 256 },
  { openssl: 'CAMELLIA128-SHA', standard: 'TLS_RSA_WITH_CAMELLIA_128_CBC_SHA', code: 0x0041, mkey: 'RSA', auth: 'RSA', enc: 'CAMELLIA128', mac: 'SHA1', minTls: 'SSL3', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'DEFAULT', strengthBits: 128 },
  { openssl: 'ECDHE-ECDSA-ARIA256-GCM-SHA384', standard: 'TLS_ECDHE_ECDSA_WITH_ARIA_256_GCM_SHA384', code: 0xc05d, mkey: 'ECDHE', auth: 'ECDSA', enc: 'ARIA256GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'ECDHE-ARIA256-GCM-SHA384', standard: 'TLS_ECDHE_RSA_WITH_ARIA_256_GCM_SHA384', code: 0xc061, mkey: 'ECDHE', auth: 'RSA', enc: 'ARIA256GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'DHE-RSA-ARIA256-GCM-SHA384', standard: 'TLS_DHE_RSA_WITH_ARIA_256_GCM_SHA384', code: 0xc053, mkey: 'DHE', auth: 'RSA', enc: 'ARIA256GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'ECDHE-ECDSA-ARIA128-GCM-SHA256', standard: 'TLS_ECDHE_ECDSA_WITH_ARIA_128_GCM_SHA256', code: 0xc05c, mkey: 'ECDHE', auth: 'ECDSA', enc: 'ARIA128GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ECDHE-ARIA128-GCM-SHA256', standard: 'TLS_ECDHE_RSA_WITH_ARIA_128_GCM_SHA256', code: 0xc060, mkey: 'ECDHE', auth: 'RSA', enc: 'ARIA128GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'DHE-RSA-ARIA128-GCM-SHA256', standard: 'TLS_DHE_RSA_WITH_ARIA_128_GCM_SHA256', code: 0xc052, mkey: 'DHE', auth: 'RSA', enc: 'ARIA128GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
  { openssl: 'ARIA256-GCM-SHA384', standard: 'TLS_RSA_WITH_ARIA_256_GCM_SHA384', code: 0xc051, mkey: 'RSA', auth: 'RSA', enc: 'ARIA256GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA384', strengthBits: 256 },
  { openssl: 'ARIA128-GCM-SHA256', standard: 'TLS_RSA_WITH_ARIA_128_GCM_SHA256', code: 0xc050, mkey: 'RSA', auth: 'RSA', enc: 'ARIA128GCM', mac: 'AEAD', minTls: 'TLS1_2', flags: ['NOT_DEFAULT', 'HIGH'], prf: 'SHA256', strengthBits: 128 },
];
