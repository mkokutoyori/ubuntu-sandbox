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
import { bootFortiConsole } from './fortiConsoleHarness';
import { decodeSecret } from '@/network/devices/firewall/vendors/fortios/runtime/secretEncoding';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const srv = new LinuxServer('linux-server', 'PC-LAN', -200, 0);
  new Cable('lan').connect(srv.getPort('eth0')!, fgt.getPort('port2')!);
  srv.configureInterface('eth0',
    new IPAddress('192.168.10.50'), new SubnetMask('255.255.255.0'));

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
  new TftpServer(srv, {
    fs: new LinuxSftpFSAdapter(vfs, 1000, 1000), rootPath: '/srv/tftp',
  }).start();

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping https ssh', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping https ssh', 'next',
    'end',
    'config system console', 'set output standard', 'end',
  ]);
  await fgt.executeCommand('execute ping 192.168.10.50');
  return { fgt, vfs };
}

describe('TP 24 — Durcir et sauvegarder', () => {
  it('etape 1 : la sauvegarde chiffree part vers le serveur TFTP', async () => {
    const { fgt, vfs } = await laboratoire();
    const vu = await fgt.executeCommand(
      'execute backup config tftp avant-durcissement.conf 192.168.10.50 MotDePasse2026');

    expect(vu).not.toMatch(/Command fail|Unknown action/i);
    expect(vfs.readFile('/srv/tftp/avant-durcissement.conf')).not.toBeNull();
  });

  it('etape 2 : le fichier en clair REVELE le secret partage, qui se relit', async () => {
    const { fgt, vfs } = await laboratoire();
    await taper(fgt, [
      'config vpn ipsec phase1-interface', 'edit "VPN-SIEGE"',
      'set interface "port1"', 'set remote-gw 203.0.113.1',
      'set psksecret "SecretPartage2026"', 'next', 'end',
      'execute backup config tftp en-clair.conf 192.168.10.50',
    ]);

    const clair = vfs.readFile('/srv/tftp/en-clair.conf') ?? '';
    const blob = /set psksecret ENC (\S+)/.exec(clair);

    expect(blob, 'le secret doit figurer dans la sauvegarde').not.toBeNull();
    expect(decodeSecret(blob?.[1] ?? '')).toBe('SecretPartage2026');
  });

  it('etape 2 : le fichier chiffre ne revele NI le secret NI la configuration', async () => {
    const { fgt, vfs } = await laboratoire();
    await taper(fgt, [
      'config vpn ipsec phase1-interface', 'edit "VPN-SIEGE"',
      'set interface "port1"', 'set remote-gw 203.0.113.1',
      'set psksecret "SecretPartage2026"', 'next', 'end',
      'execute backup config tftp chiffre.conf 192.168.10.50 MotDePasse2026',
    ]);

    const chiffre = vfs.readFile('/srv/tftp/chiffre.conf') ?? '';

    expect(chiffre.length).toBeGreaterThan(0);
    expect(chiffre).not.toContain('SecretPartage2026');
    expect(chiffre).not.toContain('config system interface');
    expect(chiffre).not.toContain('192.168.10.1');
  });

  it('etape 2 : les deux sauvegardes de la MEME machine different vraiment', async () => {
    const { fgt, vfs } = await laboratoire();
    await taper(fgt, [
      'execute backup config tftp en-clair.conf 192.168.10.50',
      'execute backup config tftp chiffre.conf 192.168.10.50 MotDePasse2026',
    ]);

    expect(vfs.readFile('/srv/tftp/chiffre.conf'))
      .not.toBe(vfs.readFile('/srv/tftp/en-clair.conf'));
  });

  it('etape 3 : la politique de mots de passe se declare et se relit', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system password-policy',
      'set status enable', 'set apply-to admin-password',
      'set minimum-length 12',
      'set min-lower-case-letter 1', 'set min-upper-case-letter 1',
      'set min-non-alphanumeric 1', 'set min-number 1', 'end',
    ]));

    const conf = await fgt.executeCommand('show system password-policy');
    expect(conf).toContain('set status enable');
    expect(conf).toContain('set minimum-length 12');
  });

  it('etape 3 : un mot de passe faible est REFUSE', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config system password-policy',
      'set status enable', 'set apply-to admin-password',
      'set minimum-length 12', 'set min-non-alphanumeric 1', 'end',
    ]);

    await taper(fgt, ['config system admin', 'edit "test-faible"']);
    const refus = await fgt.executeCommand('set password "1234"');

    expect(refus).toMatch(/Command fail|parse error/i);
    await taper(fgt, ['abort']);
  });

  it('etape 3 : un mot de passe CONFORME est accepte', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config system password-policy',
      'set status enable', 'set apply-to admin-password',
      'set minimum-length 12', 'set min-lower-case-letter 1',
      'set min-upper-case-letter 1', 'set min-non-alphanumeric 1',
      'set min-number 1', 'end',
    ]);

    propre(await taper(fgt, [
      'config system admin', 'edit "test-solide"',
      'set password "Motdepasse2026!"', 'set accprofile "super_admin"',
      'next', 'end',
    ]));
  });

  it('etape 3 : `abort` laisse le compte de test INEXISTANT', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['config system admin', 'edit "test-faible"', 'abort']);

    expect(await fgt.executeCommand('show system admin'))
      .not.toContain('test-faible');
  });

  it('etape 4 : le verrouillage apres echecs se declare', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system global',
      'set admin-lockout-threshold 3', 'set admin-lockout-duration 300', 'end',
    ]));

    const conf = await fgt.executeCommand('show system global');
    expect(conf).toContain('set admin-lockout-threshold 3');
    expect(conf).toContain('set admin-lockout-duration 300');
  });

  it('etape 5 : les ports d\'administration se deplacent', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system global',
      'set admin-sport 8443', 'set admin-ssh-port 2222', 'end',
    ]));

    const conf = await fgt.executeCommand('show system global');
    expect(conf).toContain('set admin-sport 8443');
    expect(conf).toContain('set admin-ssh-port 2222');
  });

  it('etape 6 : le WAN n\'accepte plus que le ping', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system interface', 'edit port1',
      'set allowaccess ping', 'next', 'end',
    ]));

    const conf = await fgt.executeCommand('show system interface port1');
    expect(conf).toContain('set allowaccess ping');
    expect(conf).not.toMatch(/set allowaccess .*ssh/);
  });

  it('etape 7 : la banniere se declare et son texte se pose', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system global', 'set pre-login-banner enable', 'end',
      'config system replacemsg admin "pre_admin-disclaimer-text"',
      'set buffer "ACCES RESERVE AUX PERSONNES AUTORISEES."',
      'next', 'end',
    ]));

    expect(await fgt.executeCommand('show system global'))
      .toContain('set pre-login-banner enable');
  });

  it('etape 7 : la banniere s\'AFFICHE avant l\'invite de connexion', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, [
      'config system global', 'set pre-login-banner enable', 'end',
      'config system replacemsg admin "pre_admin-disclaimer-text"',
      'set buffer "ACCES RESERVE AUX PERSONNES AUTORISEES."',
      'next', 'end',
    ]);

    const console_ = await bootFortiConsole(fgt);
    const vu = console_.lines.map(l => l.text).join('\n');

    expect(vu).toContain('ACCES RESERVE AUX PERSONNES AUTORISEES.');
  });

  it('etape 8 : `show` rend la configuration entiere, et le suivi voit la difference',
    async () => {
      const { fgt } = await laboratoire();
      const avant = await fgt.executeCommand('show');

      await taper(fgt, [
        'config system global', 'set hostname "FGT-DURCI"', 'end',
      ]);
      const apres = await fgt.executeCommand('show');

      expect(avant).toContain('config system interface');
      expect(apres).toContain('FGT-DURCI');
      expect(apres).not.toBe(avant);
    });

  it('etape 9 : les quatre commandes d\'etat repondent', async () => {
    const { fgt } = await laboratoire();
    const sorties = await taper(fgt, [
      'get system status',
      'diagnose autoupdate versions',
      'get system performance status',
      'show system global',
    ]);

    propre(sorties);
    for (const s of sorties) expect(s.trim().length).toBeGreaterThan(0);
  });

  it('etape 10 : l\'etat durci se sauvegarde a son tour', async () => {
    const { fgt, vfs } = await laboratoire();
    await taper(fgt, [
      'config system global',
      'set admin-lockout-threshold 3', 'set admin-sport 8443', 'end',
    ]);
    await fgt.executeCommand(
      'execute backup config tftp apres-durcissement.conf 192.168.10.50 MotDePasse2026');

    expect(vfs.readFile('/srv/tftp/apres-durcissement.conf')).not.toBeNull();
  });

  it('la sauvegarde chiffree se RESTAURE avec le bon mot de passe', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['config system global', 'set hostname "AVANT"', 'end']);
    await fgt.executeCommand(
      'execute backup config tftp etat.conf 192.168.10.50 MotDePasse2026');
    await taper(fgt, ['config system global', 'set hostname "APRES"', 'end']);

    await fgt.executeCommand(
      'execute restore config tftp etat.conf 192.168.10.50 MotDePasse2026');

    expect(await fgt.executeCommand('get system status')).toContain('AVANT');
  });

  it('la sauvegarde chiffree REFUSE de se restaurer sans le mot de passe', async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['config system global', 'set hostname "AVANT"', 'end']);
    await fgt.executeCommand(
      'execute backup config tftp etat.conf 192.168.10.50 MotDePasse2026');
    await taper(fgt, ['config system global', 'set hostname "APRES"', 'end']);

    const refus = await fgt.executeCommand(
      'execute restore config tftp etat.conf 192.168.10.50');

    expect(refus).toMatch(/Command fail/i);
    expect(await fgt.executeCommand('get system status')).toContain('APRES');
  });
});
