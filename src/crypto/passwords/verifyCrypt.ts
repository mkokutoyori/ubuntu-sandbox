import { md5Crypt } from './md5Crypt';
import { verifySha256Crypt, verifySha512Crypt } from './sha512Crypt';

export function verifyCrypt(secret: string, password: string): boolean {
  if (secret.startsWith('$6$')) return verifySha512Crypt(secret, password);
  if (secret.startsWith('$5$')) return verifySha256Crypt(secret, password);
  const md5 = /^\$1\$([^$]{0,8})\$/.exec(secret);
  return md5 !== null && md5Crypt(password, md5[1]) === secret;
}
