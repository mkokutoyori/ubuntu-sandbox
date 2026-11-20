/*
 * Probe: the users file honoured Cleartext-Password only. FreeRADIUS v3.2.x src/modules/rlm_pap/rlm_pap.c verifies PAP
 * against the first known-good attribute of the control list: MD5-Password, SMD5-Password, SHA-Password, SSHA-Password,
 * NT-Password, SHA2-Password, Crypt-Password and Password-With-Header ("{ssha}..." prefix, hex or base64 digest);
 * `Auth-Type := Accept` accepts without checking. Published vectors for "password": MD5 5f4dcc3b..., SHA-1 5baa61e4...,
 * SHA-256 5e884898..., NT 8846f7ea.... The "(0)" log wording is not exercised here.
 *
 * Discriminated with git stash on src/network and the new module: 11 of 12 fall before the fix (the base parser refuses the whole file at the first hashed password attribute); the witness, built in a lab holding only a Cleartext-Password user, passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

import { md5, sha1, sha256, sha512 } from '@/crypto/hash';
import { bytesToBase64, bytesToHex, utf8ToBytes } from '@/crypto/encoding';
import { md5Crypt } from '@/crypto/passwords/md5Crypt';

const salt = utf8ToBytes('NaCl');
const cat = (a: Uint8Array, b: Uint8Array) => Uint8Array.from([...a, ...b]);
const hex = (b: Uint8Array) => bytesToHex(b);
const USERS = [
  'clear Cleartext-Password := "password"',
  'md5hex MD5-Password := "5f4dcc3b5aa765d61d8327deb882cf99"',
  `md5b64 MD5-Password := "${bytesToBase64(md5(utf8ToBytes('password')))}"`,
  'sha1hex SHA-Password := "5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8"',
  `ssha SSHA-Password := "${bytesToBase64(cat(sha1(cat(utf8ToBytes('password'), salt)), salt))}"`,
  `smd5 SMD5-Password := "${hex(cat(md5(cat(utf8ToBytes('password'), salt)), salt))}"`,
  'nt NT-Password := "8846f7eaee8fb117ad06bdd830b7586c"',
  `sha2 SHA2-Password := "${hex(sha256(utf8ToBytes('password')))}"`,
  `sha512 SHA2-Password := "${hex(sha512(utf8ToBytes('password')))}"`,
  `crypt Crypt-Password := "${md5Crypt('password', 'abcdefgh')}"`,
  `header Password-With-Header := "{sha}${bytesToBase64(sha1(utf8ToBytes('password')))}"`,
  'anyone Auth-Type := Accept',
  '',
].join('\n');

function write(server: LinuxServer, path: string, content: string): void {
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(path, content, 0, 0, 0o022);
}

async function lab(users = USERS) {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(target, USERS_FILE_PATH, users);
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

const radtest = (client: LinuxServer, args: string) => client.executeCommand(`radtest ${args} 10.0.0.2 0 shared`);

describe('freeradius users file known-good password types', () => {
  it('witness: Cleartext-Password is accepted and a wrong password refused', async () => {
    const { client } = await lab('clear Cleartext-Password := "password"\n');
    expect(await radtest(client, 'clear password')).toContain('Received Access-Accept');
    expect(await radtest(client, 'clear wrong')).toContain('Access-Reject');
  });

  for (const name of ['md5hex', 'md5b64', 'sha1hex', 'ssha', 'smd5', 'nt', 'sha2', 'sha512', 'crypt', 'header']) {
    it(`${name}: right password accepted, wrong refused`, async () => {
      const { client } = await lab(USERS);
      expect(await radtest(client, `${name} password`)).toContain('Received Access-Accept');
      expect(await radtest(client, `${name} passw0rd`)).toContain('Access-Reject');
    });
  }

  it('Auth-Type := Accept accepts any password', async () => {
    const { client } = await lab(USERS);
    expect(await radtest(client, 'anyone whatever')).toContain('Received Access-Accept');
  });
});
