import type { SshAlgorithmPreferences } from '../../../protocols/ssh/transport/SshTransport';

export type VrpSshAlgorithmFamily = 'key-exchange' | 'cipher' | 'hmac' | 'publickey';

const VRP_TO_OPENSSH: Readonly<Record<VrpSshAlgorithmFamily, Readonly<Record<string, string>>>> = {
  'key-exchange': {
    dh_group1_sha1: 'diffie-hellman-group1-sha1',
    dh_group14_sha1: 'diffie-hellman-group14-sha1',
    dh_group14_sha256: 'diffie-hellman-group14-sha256',
    dh_group15_sha512: 'diffie-hellman-group15-sha512',
    dh_group16_sha512: 'diffie-hellman-group16-sha512',
    dh_group_exchange_sha1: 'diffie-hellman-group-exchange-sha1',
    dh_group_exchange_sha256: 'diffie-hellman-group-exchange-sha256',
    ecdh_sha2_nistp256: 'ecdh-sha2-nistp256',
    curve25519_sha256: 'curve25519-sha256',
  },
  cipher: {
    '3des_cbc': '3des-cbc',
    aes128_cbc: 'aes128-cbc',
    aes256_cbc: 'aes256-cbc',
    aes128_ctr: 'aes128-ctr',
    aes192_ctr: 'aes192-ctr',
    aes256_ctr: 'aes256-ctr',
    aes128_gcm: 'aes128-gcm@openssh.com',
    aes256_gcm: 'aes256-gcm@openssh.com',
  },
  hmac: {
    md5: 'hmac-md5',
    md5_96: 'hmac-md5-96',
    sha1: 'hmac-sha1',
    sha1_96: 'hmac-sha1-96',
    sha2_256: 'hmac-sha2-256',
    sha2_512: 'hmac-sha2-512',
  },
  publickey: {
    rsa: 'ssh-rsa',
    rsa_sha2_256: 'rsa-sha2-256',
    rsa_sha2_512: 'rsa-sha2-512',
    ecc: 'ecdsa-sha2-nistp256',
    ed25519: 'ssh-ed25519',
    dsa: 'ssh-dss',
  },
};

export function vrpSshAlgorithmFamily(word: string | undefined): VrpSshAlgorithmFamily | null {
  const family = (word ?? '').toLowerCase();
  return family in VRP_TO_OPENSSH ? family as VrpSshAlgorithmFamily : null;
}

export function vrpSshAlgorithmTokens(family: VrpSshAlgorithmFamily): readonly string[] {
  return Object.keys(VRP_TO_OPENSSH[family]);
}

export function parseVrpSshAlgorithms(family: VrpSshAlgorithmFamily, words: readonly string[]): string[] | string {
  const tokens: string[] = [];
  for (const word of words) {
    const token = word.toLowerCase();
    if (!(token in VRP_TO_OPENSSH[family])) return word;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

export type VrpSshAlgorithmLists = Readonly<Record<VrpSshAlgorithmFamily, readonly string[]>>;

export function vrpSshAlgorithmPreferences(lists: VrpSshAlgorithmLists): SshAlgorithmPreferences {
  const names = (family: VrpSshAlgorithmFamily): string[] =>
    lists[family].map((token) => VRP_TO_OPENSSH[family][token]);
  return {
    ...(lists['key-exchange'].length > 0 ? { kex: names('key-exchange') } : {}),
    ...(lists.cipher.length > 0 ? { ciphers: names('cipher') } : {}),
    ...(lists.hmac.length > 0 ? { macs: names('hmac') } : {}),
    ...(lists.publickey.length > 0 ? { hostKey: names('publickey') } : {}),
  };
}
