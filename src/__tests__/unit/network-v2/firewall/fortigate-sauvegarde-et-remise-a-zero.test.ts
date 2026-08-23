import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TftpServer } from '@/network/tftp/TftpSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { openFortiConsole, answerPrompt, runCommand } from './fortiConsoleHarness';
import type { FortiTerminalSession } from '@/terminal/sessions';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);
const seen = (s: FortiTerminalSession) => s.lines.map(l => l.text).join('\n');
const prompted = (s: FortiTerminalSession) =>
  (s.currentInputMode as { promptText?: string }).promptText ?? '';

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const srv = new LinuxServer('linux-server', 'TFTP1', -200, 0);
  new Cable('lan').connect(srv.getPort('eth0')!, fgt.getPort('port2')!);
  srv.configureInterface('eth0', new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
  const server = new TftpServer(srv, {
    fs: new LinuxSftpFSAdapter(vfs, 1000, 1000), rootPath: '/srv/tftp',
  });
  server.start();

  for (const c of ['config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system console', 'set output standard', 'end']) await run(fgt, c);
  await run(fgt, 'execute ping 192.168.10.10');
  return { fgt, vfs };
}

describe('`execute backup config` DEPOSE un fichier sur le serveur', () => {
  it('le fichier existe apres la sauvegarde', async () => {
    const { fgt, vfs } = await laboratoire();
    await run(fgt, 'execute backup config tftp sauvegarde.conf 192.168.10.10');
    expect(vfs.readFile('/srv/tftp/sauvegarde.conf')).not.toBeNull();
  });

  it('ce qu il contient est la configuration de CETTE machine', async () => {
    const { fgt, vfs } = await laboratoire();
    await run(fgt, 'config system global');
    await run(fgt, 'set hostname PARE-FEU-A');
    await run(fgt, 'end');

    await run(fgt, 'execute backup config tftp sauvegarde.conf 192.168.10.10');
    const texte = vfs.readFile('/srv/tftp/sauvegarde.conf') ?? '';
    expect(texte).toContain('set hostname');
    expect(texte).toContain('PARE-FEU-A');
    expect(texte).toContain('config system interface');
  });

  it('un serveur inaccessible est signale, pas passe sous silence', async () => {
    const { fgt } = await laboratoire();
    const vu = await run(fgt, 'execute backup config tftp x.conf 10.99.99.99');
    expect(vu).toContain('Command fail');
  });

  it('une destination que l unite n a pas est refusee en le disant', async () => {
    const { fgt } = await laboratoire();
    const vu = await run(fgt, 'execute backup config usb x.conf');
    expect(vu).toContain('Command fail');
    expect(vu.toLowerCase()).toContain('usb');
  });
});

describe('`execute restore config` REMET la configuration sauvegardee', () => {
  it('un reglage efface apres la sauvegarde revient', async () => {
    const { fgt } = await laboratoire();
    await run(fgt, 'config system global');
    await run(fgt, 'set hostname AVANT');
    await run(fgt, 'end');
    await run(fgt, 'execute backup config tftp b.conf 192.168.10.10');

    await run(fgt, 'config system global');
    await run(fgt, 'set hostname APRES');
    await run(fgt, 'end');
    expect(await run(fgt, 'get system status')).toContain('APRES');

    await run(fgt, 'execute restore config tftp b.conf 192.168.10.10');
    expect(await run(fgt, 'get system status')).toContain('AVANT');
  });

  it('un fichier absent est signale', async () => {
    const { fgt } = await laboratoire();
    const vu = await run(fgt, 'execute restore config tftp absent.conf 192.168.10.10');
    expect(vu).toContain('Command fail');
  });
});

describe('`execute factoryreset` demande confirmation et remet a zero', () => {
  it('la phrase est celle de la machine', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute factoryreset');
    expect(seen(s)).toContain('This operation will reset the system to factory default!');
    expect(prompted(s)).toContain('Do you want to continue? (y/n)');
  });

  it('`n` annule et la configuration tient', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'config system global');
    await runCommand(s, 'set hostname GARDE-MOI');
    await runCommand(s, 'end');

    await runCommand(s, 'execute factoryreset');
    await answerPrompt(s, 'n');
    expect(await run(fgt, 'get system status')).toContain('GARDE-MOI');
  });

  it('`y` efface la configuration et redemande le login', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'config system global');
    await runCommand(s, 'set hostname EFFACE-MOI');
    await runCommand(s, 'end');

    await runCommand(s, 'execute factoryreset');
    await answerPrompt(s, 'y');

    expect(await run(fgt, 'get system status')).not.toContain('EFFACE-MOI');
    expect(prompted(s)).toContain('login:');
  });

  it('apres remise a zero, le mot de passe redevient vide', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await runCommand(s, 'execute factoryreset');
    await answerPrompt(s, 'y');

    expect(fgt.adminMustChoosePassword('admin')).toBe(true);
  });

  it('les trois actions figurent dans `execute ?`', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const vu = await run(fgt, 'execute ?');
    expect(vu).toContain('backup');
    expect(vu).toContain('restore');
    expect(vu).toContain('factoryreset');
  });
});
