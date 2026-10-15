/**
 * Cisco IOS Security Command Reference: `crypto pki export trustpoint pem {terminal | url} {3des | des}
 * password phrase` and `crypto pki import trustpoint pem [exportable] {terminal | url} [password phrase]`.
 * The export writes the CA certificate, the router certificate and the private key encrypted with the
 * password phrase (at least eight characters); only a key generated `exportable` can leave the router; the
 * import restores the identity into a trustpoint, so IKE authenticates with it again.
 *
 * Lab: the PKI lab of crypto-pki-crl (R1 - R2 with IKEv2 RSA certificates, CA router with the IOS certificate
 * server) plus a real TFTP server cabled to R2. R2 is enrolled with an exportable key; R1 with a default
 * (non-exportable) one. The tunnel is the proof that an imported identity is usable: removing the trustpoint
 * removes the credential from IKE, and the PEM import brings it back.
 *
 * Ours, not in the reference: the terminal export prefixes each block with "% CA certificate:", "% Key name:"
 * and "% General Purpose Certificate:", and the refusal wordings for a short phrase, a non-exportable key and a
 * wrong phrase are this simulator's own. `des` is single DES in CBC (DEK-Info DES-CBC), `3des` is DES-EDE3-CBC.
 *
 * Measured with src stashed to HEAD: every case but the witnesses falls (the commands were refused or stored a
 * marker without reading any PEM). Witnesses: the tunnel works before the trustpoint is removed; the
 * non-exportable key stays on R1 after the refusals.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
import { buildLab, configureBase, buildCa, enrollTrustpoint, configureX509Profile, seedPcs } from './_helpers/pkiIpsecLab';
import { run } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const PHRASE = 'phrase12345';

async function pemLab() {
  const l = await buildLab();
  await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
  await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
  const ca = await buildCa('CA', [
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
  return { ...l, ca, vfs, cable };
}

type Lab = Awaited<ReturnType<typeof pemLab>>;
const ping = (l: Lab) => clock.advanceUntilSettled(l.pc1.executeCommand('ping -c 2 192.168.2.10'));
const exportPem = async (l: Lab, tail: string) => (await run(l.r2, [`crypto pki export TP pem ${tail}`])).at(-2)!;

async function resetTunnel(l: Lab): Promise<void> {
  for (const router of [l.r1, l.r2]) {
    await run(router, []);
    await router.executeCommand('clear crypto sa');
    await router.executeCommand('clear crypto ikev2 sa');
  }
}

describe('crypto pki export … pem', () => {
  it('witness (passes either way): the tunnel works with the enrolled certificates', async () => {
    const l = await pemLab();
    expect(await ping(l)).toContain('2 received');
  });

  it('terminal export prints the CA certificate, the encrypted key and the router certificate', async () => {
    const l = await pemLab();
    const out = await exportPem(l, `terminal 3des password ${PHRASE}`);
    expect(out).toContain('% CA certificate:');
    expect(out).toContain('% General Purpose Certificate:');
    expect(out.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
    expect(out).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(out).toContain('Proc-Type: 4,ENCRYPTED');
    expect(out).toContain('DEK-Info: DES-EDE3-CBC,');
    expect(out).not.toContain(getSecurityConfig(l.r2).pkiTrustpoints.get('TP')!.localKey!.material);
  });

  it('des is single DES in CBC', async () => {
    const l = await pemLab();
    expect(await exportPem(l, `terminal des password ${PHRASE}`)).toContain('DEK-Info: DES-CBC,');
  });

  it('a password phrase under eight characters is refused', async () => {
    const l = await pemLab();
    const out = await exportPem(l, 'terminal 3des password short');
    expect(out).toContain('at least 8 characters');
    expect(out).not.toContain('BEGIN');
  });

  it('a key not generated exportable does not leave the router', async () => {
    const l = await pemLab();
    await l.r1.executeCommand('enable');
    await l.r1.executeCommand('configure terminal');
    const out = await l.r1.executeCommand(`crypto pki export TP pem terminal 3des password ${PHRASE}`);
    expect(out).toContain('not exportable');
    expect(out).not.toContain('PRIVATE KEY');
  });

  it('show crypto key mypubkey rsa says which keys are exportable', async () => {
    const l = await pemLab();
    await l.r2.executeCommand('end');
    expect(await l.r2.executeCommand('show crypto key mypubkey rsa')).toContain('Key is exportable.');
  });

  it('export to tftp: lands on the server through real frames', async () => {
    const l = await pemLab();
    const before = l.cable.getStats().framesTransmitted;
    const out = await exportPem(l, `url tftp://10.7.1.2/r2.pem 3des password ${PHRASE}`);
    expect(out).toContain('bytes copied');
    expect(l.cable.getStats().framesTransmitted).toBeGreaterThan(before);
    const stored = l.vfs.readFile('/srv/tftp/r2.pem')!;
    expect(stored).toContain('DEK-Info: DES-EDE3-CBC,');
    expect(stored.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
  });
});

describe('crypto pki import … pem', () => {
  it('restores the identity: IKE has no credential without the trustpoint and has it back after the import', async () => {
    const l = await pemLab();
    await exportPem(l, `url flash:r2.pem 3des password ${PHRASE}`);
    await run(l.r2, ['no crypto pki trustpoint TP']);
    await resetTunnel(l);
    expect(await ping(l)).toContain('0 received');
    const out = await run(l.r2, ['crypto pki trustpoint TP', 'exit', `crypto pki import TP pem url flash:r2.pem password ${PHRASE}`]);
    await clock.advanceUntilSettled(Promise.resolve());
    expect(out.at(-2)).toContain('PEM files import succeeded');
    await resetTunnel(l);
    expect(await ping(l)).toContain('2 received');
  });

  it('a wrong password phrase installs nothing', async () => {
    const l = await pemLab();
    await exportPem(l, `url flash:r2.pem 3des password ${PHRASE}`);
    await run(l.r2, ['no crypto pki trustpoint TP']);
    const out = await run(l.r2, ['crypto pki trustpoint TP', 'exit', 'crypto pki import TP pem url flash:r2.pem password wrongphrase1']);
    expect(out.at(-2)).toContain('Unable to decrypt');
    expect(getSecurityConfig(l.r2).pkiTrustpoints.get('TP')!.localKey).toBeUndefined();
  });

  it('a certificate that does not belong to the key is refused', async () => {
    const l = await pemLab();
    const pem = (await exportPem(l, `terminal 3des password ${PHRASE}`));
    const other = (await run(l.r1, [`crypto pki export TP pem terminal 3des password ${PHRASE}`])).at(-2)!;
    expect(other).toContain('not exportable');
    const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!;
    const key = /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/.exec(pem)![0];
    l.vfs.writeFile('/srv/tftp/mixed.pem', `${certs[0]}\n${key}\n`, 1000, 1000, 0o022);
    await run(l.r2, ['no crypto pki trustpoint TP', 'crypto pki trustpoint TP', 'exit']);
    const out = await clock.advanceUntilSettled(run(l.r2, [`crypto pki import TP pem url tftp://10.7.1.2/mixed.pem password ${PHRASE}`]));
    expect(out.at(-2)).toContain('does not match any certificate');
  });

  it('import from tftp reads the server through real frames', async () => {
    const l = await pemLab();
    await exportPem(l, `url tftp://10.7.1.2/r2.pem 3des password ${PHRASE}`);
    await run(l.r2, ['no crypto pki trustpoint TP', 'crypto pki trustpoint TP', 'exit']);
    const before = l.cable.getStats().framesTransmitted;
    const out = await clock.advanceUntilSettled(run(l.r2, [`crypto pki import TP pem url tftp://10.7.1.2/r2.pem password ${PHRASE}`]));
    expect(out.at(-2)).toContain('PEM files import succeeded');
    expect(l.cable.getStats().framesTransmitted).toBeGreaterThan(before);
  });

  it('import terminal is a dialogue that takes the pasted PEM up to quit', async () => {
    const l = await pemLab();
    const text = await exportPem(l, `terminal 3des password ${PHRASE}`);
    await run(l.r2, ['no crypto pki trustpoint TP', 'crypto pki trustpoint TP', 'exit']);
    const shell = (l.r2 as unknown as { shell: { interactionPlanFor(line: string, ctx: object): { steps: Array<{ kind: string; accept?: (line: string, all: string[]) => { done: boolean; body?: string }; run?: (rt: object) => Promise<void> }> } | null } }).shell;
    const plan = shell.interactionPlanFor(`crypto pki import TP pem terminal exportable password ${PHRASE}`, { mode: 'config', device: l.r2 })!;
    expect(plan.steps.map((s) => s.kind)).toEqual(['output', 'collect', 'run']);
    const lines: string[] = [];
    let body = '';
    for (const line of [...text.split('\n'), 'quit']) {
      const verdict = plan.steps[1].accept!(line, lines);
      if (verdict.done) { body = verdict.body ?? ''; break; }
      lines.push(line);
    }
    const printed: string[] = [];
    await plan.steps[2].run!({ values: new Map([['pem_text', body]]), output: (t: string) => printed.push(t) });
    expect(printed.join('')).toContain('PEM files import succeeded');
    const trustpoint = getSecurityConfig(l.r2).pkiTrustpoints.get('TP')!;
    expect(trustpoint.keyExportable).toBe(true);
    expect(trustpoint.localCert?.subject).toContain('r2.lab');
  });
});
