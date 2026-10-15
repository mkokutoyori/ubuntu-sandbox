/**
 * Cisco IOS Security Command Reference: `crypto pki export TP pkcs12 destination-url password phrase` and
 * `crypto pki import TP pkcs12 source-url password phrase`. The file is a PKCS#12 container (RFC 7292) holding
 * the router certificate, the CA certificate and the private key, protected by the password phrase (at least
 * eight characters); only an exportable key can be exported.
 *
 * Lab: the PEM lab of crypto-pki-export-import-pem (R2 enrolled at the IOS certificate server with an
 * exportable key, a TFTP server on a real cable). The container is built by the new Pkcs12Der codec
 * (PBES2/AES-256-CBC with PBKDF2-SHA256, HMAC-SHA256 under the RFC 7292 appendix B key derivation) and the
 * probe reads what R2 wrote back from the TFTP server; when an `openssl` binary exists on the machine running
 * the test, the file is also opened by it, which is the interoperability witness.
 *
 * Ours, not in the reference: the refusal wordings. Single-DES/RC2 legacy PKCS12 profiles are not produced.
 *
 * Measured with src stashed to HEAD: every case falls (no pkcs12 form existed). Witness: the container
 * decodes back to the very certificate and key of the trustpoint, which the tunnel case then relies on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { execSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { TftpServer } from '@/network/tftp/TftpSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';
import { decodePkcs12 } from '@/network/pki/der/Pkcs12Der';
import { binaryStringToBytes } from '@/crypto/encoding';
import { buildLab, configureBase, buildCa, enrollTrustpoint, configureX509Profile, seedPcs } from './_helpers/pkiIpsecLab';
import { run } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const PHRASE = 'phrase12345';

async function lab() {
  const l = await buildLab();
  await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
  await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
  await buildCa('CA', [
    { peer: l.r1, caIp: '10.9.1.1', peerIp: '10.9.1.2', caPort: 'GigabitEthernet0/0' },
    { peer: l.r2, caIp: '10.9.2.1', peerIp: '10.9.2.2', caPort: 'GigabitEthernet0/1' },
  ]);
  await clock.advanceUntilSettled(enrollTrustpoint(l.r1, 'http://10.9.1.1', 'CN=r1.lab'));
  await run(l.r2, ['ip domain-name lab', 'crypto key generate rsa label K2 exportable']);
  await clock.advanceUntilSettled(run(l.r2, [
    'crypto pki trustpoint TP', 'enrollment url http://10.9.2.1', 'subject-name CN=r2.lab', 'revocation-check none', 'rsakeypair K2', 'exit',
    'crypto pki authenticate TP', 'crypto pki enroll TP',
  ]));
  await configureX509Profile(l.r1, '10.0.12.2');
  await configureX509Profile(l.r2, '10.0.12.1');
  await seedPcs(l.pc1, l.pc2);
  const server = new LinuxServer('linux-server', 'TFTP1');
  server.configureInterface('eth0', new IPAddress('10.7.1.2'), new SubnetMask('255.255.255.0'));
  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
  new TftpServer(server, { fs: new LinuxSftpFSAdapter(vfs, 1000, 1000), rootPath: '/srv/tftp' }).start();
  const cable = new Cable('tftp');
  cable.connect(l.r2.getPort('GigabitEthernet0/3')!, server.getPort('eth0')!);
  await run(l.r2, ['interface GigabitEthernet0/3', 'ip address 10.7.1.1 255.255.255.0', 'no shutdown', 'exit']);
  await run(l.r2, ['ping 10.7.1.2']);
  return { ...l, vfs, cable };
}

type Lab = Awaited<ReturnType<typeof lab>>;
const ping = (l: Lab) => clock.advanceUntilSettled(l.pc1.executeCommand('ping -c 2 192.168.2.10'));
const last = async (router: Lab['r2'], line: string) => (await clock.advanceUntilSettled(run(router, [line]))).at(-2)!;

async function resetTunnel(l: Lab): Promise<void> {
  for (const router of [l.r1, l.r2]) {
    await run(router, []);
    await router.executeCommand('clear crypto sa');
    await router.executeCommand('clear crypto ikev2 sa');
  }
}

describe('crypto pki export/import … pkcs12', () => {
  it('export to tftp writes a PKCS12 container on the server that holds the certificates and the key', async () => {
    const l = await lab();
    const before = l.cable.getStats().framesTransmitted;
    expect(await last(l.r2, `crypto pki export TP pkcs12 tftp://10.7.1.2/r2.p12 password ${PHRASE}`)).toContain('bytes copied');
    expect(l.cable.getStats().framesTransmitted).toBeGreaterThan(before);
    const trustpoint = getSecurityConfig(l.r2).pkiTrustpoints.get('TP')!;
    const decoded = decodePkcs12(binaryStringToBytes(l.vfs.readFile('/srv/tftp/r2.p12')!), PHRASE);
    expect('contents' in decoded).toBe(true);
    if ('contents' in decoded) {
      expect(decoded.contents.certificates.map((c) => c.serialNumber)).toEqual([trustpoint.localCert!.serialNumber, trustpoint.caCert!.serialNumber]);
      expect(decoded.contents.key).toEqual(trustpoint.localKey);
    }
  });

  it('a wrong password phrase cannot open the container', async () => {
    const l = await lab();
    await last(l.r2, `crypto pki export TP pkcs12 tftp://10.7.1.2/r2.p12 password ${PHRASE}`);
    expect(decodePkcs12(binaryStringToBytes(l.vfs.readFile('/srv/tftp/r2.p12')!), 'wrongphrase1')).toEqual({ error: 'bad-password' });
  });

  it('a phrase under eight characters and a non-exportable key are refused', async () => {
    const l = await lab();
    expect(await last(l.r2, 'crypto pki export TP pkcs12 flash:x.p12 password short')).toContain('at least 8 characters');
    expect(await last(l.r1, `crypto pki export TP pkcs12 flash:x.p12 password ${PHRASE}`)).toContain('not exportable');
  });

  it('import restores the identity: no credential once the trustpoint is gone, a working tunnel after the import', async () => {
    const l = await lab();
    await last(l.r2, `crypto pki export TP pkcs12 flash:r2.p12 password ${PHRASE}`);
    await run(l.r2, ['no crypto pki trustpoint TP']);
    await resetTunnel(l);
    expect(await ping(l)).toContain('0 received');
    await run(l.r2, ['crypto pki trustpoint TP', 'exit']);
    expect(await last(l.r2, `crypto pki import TP pkcs12 flash:r2.p12 password ${PHRASE}`)).toContain('PKCS12 import succeeded');
    await resetTunnel(l);
    expect(await ping(l)).toContain('2 received');
  });

  it('import with the wrong phrase installs nothing', async () => {
    const l = await lab();
    await last(l.r2, `crypto pki export TP pkcs12 flash:r2.p12 password ${PHRASE}`);
    await run(l.r2, ['no crypto pki trustpoint TP', 'crypto pki trustpoint TP', 'exit']);
    expect(await last(l.r2, 'crypto pki import TP pkcs12 flash:r2.p12 password wrongphrase1')).toContain('wrong password phrase');
    expect(getSecurityConfig(l.r2).pkiTrustpoints.get('TP')!.localKey).toBeUndefined();
  });

  it('a file that is not PKCS12 is refused', async () => {
    const l = await lab();
    l.vfs.writeFile('/srv/tftp/junk.p12', 'not a container', 1000, 1000, 0o022);
    await run(l.r2, ['no crypto pki trustpoint TP', 'crypto pki trustpoint TP', 'exit']);
    expect(await last(l.r2, `crypto pki import TP pkcs12 tftp://10.7.1.2/junk.p12 password ${PHRASE}`)).toContain('not a valid PKCS12');
  });

  const hasOpenssl = (() => { try { execSync('openssl version', { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasOpenssl)('interoperability witness: the real openssl opens the exported container and the MAC verifies', async () => {
    const l = await lab();
    await last(l.r2, `crypto pki export TP pkcs12 tftp://10.7.1.2/r2.p12 password ${PHRASE}`);
    const dir = mkdtempSync(join(tmpdir(), 'p12-'));
    const file = join(dir, 'r2.p12');
    writeFileSync(file, Buffer.from(binaryStringToBytes(l.vfs.readFile('/srv/tftp/r2.p12')!)));
    const info = execSync(`openssl pkcs12 -info -in ${file} -passin pass:${PHRASE} -nodes 2>&1`).toString();
    expect(info).toContain('MAC: sha256');
    expect(info.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(info).toContain('BEGIN PRIVATE KEY');
  });
});
