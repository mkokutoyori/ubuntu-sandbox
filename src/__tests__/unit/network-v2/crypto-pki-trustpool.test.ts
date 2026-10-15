/**
 * Cisco IOS Security Command Reference: `crypto pki trustpool import {url URL | terminal | clean [terminal | url
 * URL]}`, `crypto pki trustpool policy` (`cabundle url`, `chain-validation`) and `show crypto pki trustpool
 * [policy]`. The trustpool is a set of CA certificates the router trusts beside the CA of its own trustpoints;
 * "if chain-validation is not configured, the validation stops at the peer certificate's issuer".
 *
 * Lab: R1 and R2 enrolled by hand (enrollment terminal) with offline authorities that do not know each other, so
 * the IKEv2 tunnel between them is refused for lack of a common trust anchor. The trustpool is what makes it
 * work: the bundle comes from a real TFTP server, from the terminal, or from the nginx of a LinuxServer.
 *
 * Ours, not in the reference: the policy stays in the router (no storage: directory), the bundle is a
 * concatenation of PEM certificates rather than a PKCS#7 file, and `cabundle url` downloads the bundle once, when
 * it is configured, and not on a timer.
 *
 * Measured with src stashed to HEAD: every case but the first falls (no trustpool commands existed).
 * Witness: the first case (no pool, the tunnel is refused) proves the lab itself needs the pool.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

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
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { simulationNowMs } from '@/network/core/SystemClock';
import { buildLab, configureBase, configureX509Profile, seedPcs } from './_helpers/pkiIpsecLab';
import { paste, manualEnroll } from './_helpers/manualPki';
import { run } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const DAY = 86_400_000;

async function lab() {
  const l = await buildLab();
  await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
  await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
  const now = simulationNowMs();
  const rootX = CertificateAuthority.generate('CN=RootX', { now });
  const rootY = CertificateAuthority.generate('CN=RootY', { now });
  const subY = rootY.issueSubordinateCA({ subject: 'CN=SubY', notBefore: now, notAfter: now + 30 * DAY });
  for (const [router, authority, name] of [[l.r1, rootX, 'r1.lab'], [l.r2, subY, 'r2.lab']] as const) {
    const { issued } = await manualEnroll(router, authority, `CN=${name}`);
    await paste(router, 'crypto pki import TP certificate', certToPem(issued!));
  }
  await configureX509Profile(l.r1, '10.0.12.2');
  await configureX509Profile(l.r2, '10.0.12.1');
  await seedPcs(l.pc1, l.pc2);
  const server = new LinuxServer('linux-server', 'FILES');
  server.configureInterface('eth0', new IPAddress('10.7.1.2'), new SubnetMask('255.255.255.0'));
  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
  new TftpServer(server, { fs: new LinuxSftpFSAdapter(vfs, 1000, 1000), rootPath: '/srv/tftp' }).start();
  new Cable('files').connect(l.r1.getPort('GigabitEthernet0/3')!, server.getPort('eth0')!);
  await run(l.r1, ['interface GigabitEthernet0/3', 'ip address 10.7.1.1 255.255.255.0', 'no shutdown', 'exit']);
  await run(l.r1, ['ping 10.7.1.2']);
  return { ...l, rootX, subY, vfs, server };
}

type Lab = Awaited<ReturnType<typeof lab>>;
const ping = (l: Lab) => clock.advanceUntilSettled(l.pc1.executeCommand('ping -c 2 192.168.2.10'));
const last = async (router: Lab['r1'], lines: string[]) => (await clock.advanceUntilSettled(run(router, lines))).at(-2)!;

async function resetTunnel(l: Lab): Promise<void> {
  for (const router of [l.r1, l.r2]) {
    await run(router, []);
    await router.executeCommand('clear crypto sa');
    await router.executeCommand('clear crypto ikev2 sa');
  }
}

async function trustEachOther(l: Lab): Promise<void> {
  l.vfs.writeFile('/srv/tftp/suby.pem', certToPem(l.subY.rootCertificate), 1000, 1000, 0o022);
  expect(await last(l.r1, ['crypto pki trustpool import url tftp://10.7.1.2/suby.pem'])).toContain('import succeeded');
  expect(await paste(l.r2, 'crypto pki trustpool import terminal', certToPem(l.rootX.rootCertificate))).toContain('import succeeded');
  await resetTunnel(l);
}

describe('crypto pki trustpool', () => {
  it('witness: without the pool the two routers have no common trust anchor and the tunnel is refused', async () => {
    const l = await lab();
    expect(await ping(l)).toContain('0 received');
  });

  it('the imported bundles (tftp on one side, the terminal on the other) bring the tunnel up', async () => {
    const l = await lab();
    await trustEachOther(l);
    expect(await ping(l)).toContain('2 received');
  });

  it('show crypto pki trustpool lists what was imported', async () => {
    const l = await lab();
    await trustEachOther(l);
    await l.r1.executeCommand('enable');
    const out = await l.r1.executeCommand('show crypto pki trustpool');
    expect(out).toContain('Associated Trustpoints: Trustpool');
    expect(out).toMatch(/cn=suby/i);
    expect(await l.r1.executeCommand('show crypto pki trustpool policy')).toContain('Chain validation: stops at the issuer');
  });

  it('import clean empties the pool and the tunnel is refused again', async () => {
    const l = await lab();
    await trustEachOther(l);
    expect(await last(l.r1, ['crypto pki trustpool import clean'])).toBe('');
    await resetTunnel(l);
    expect(await ping(l)).toContain('0 received');
  });

  it('chain-validation requires a root of the pool: an intermediate alone no longer anchors the peer', async () => {
    const l = await lab();
    await trustEachOther(l);
    await run(l.r1, ['crypto pki trustpool policy', 'chain-validation']);
    await resetTunnel(l);
    expect(await ping(l)).toContain('0 received');
    expect(await l.r1.executeCommand('show running-config')).toContain('chain-validation');
    await run(l.r1, ['crypto pki trustpool policy', 'no chain-validation']);
    await resetTunnel(l);
    expect(await ping(l)).toContain('2 received');
  });

  it('cabundle url downloads the bundle from a web server through real frames', async () => {
    const l = await lab();
    await l.server.executeCommand('mkdir -p /var/www/html');
    await l.server.executeCommand(`sh -c 'printf "${certToPem(l.subY.rootCertificate).replace(/\n/g, '\\n')}" > /var/www/html/bundle.pem'`);
    await l.server.executeCommand('systemctl start nginx');
    expect(await last(l.r1, ['crypto pki trustpool policy', 'cabundle url http://10.7.1.2/bundle.pem'])).toContain('import succeeded');
    expect(await paste(l.r2, 'crypto pki trustpool import terminal', certToPem(l.rootX.rootCertificate))).toContain('import succeeded');
    await resetTunnel(l);
    expect(await ping(l)).toContain('2 received');
    expect(await l.r1.executeCommand('show running-config')).toContain('cabundle url http://10.7.1.2/bundle.pem');
  });

  it('a bundle without certificate is refused', async () => {
    const l = await lab();
    l.vfs.writeFile('/srv/tftp/junk.pem', 'nothing here', 1000, 1000, 0o022);
    expect(await last(l.r1, ['crypto pki trustpool import url tftp://10.7.1.2/junk.pem'])).toContain('holds no PEM certificate');
  });
});
