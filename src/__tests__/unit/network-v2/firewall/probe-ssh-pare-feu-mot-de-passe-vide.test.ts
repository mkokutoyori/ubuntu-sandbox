/*
 * Le compte `admin` d'usine d'un FortiGate a un mot de passe VIDE, et SSH
 * doit l'accepter.
 *
 * L'AUTORITE : FortiOS (documentation Fortinet, « Administrators » et
 * « Default administrator account ») : sur un pare-feu neuf `admin` n'a pas
 * de mot de passe et se connecte par SSH ou la console en le laissant vide
 * (FortiOS demande ensuite d'en choisir un). Un serveur SSH decide du
 * secret au moment de l'authentification (RFC 4252 §8) : si le magasin de
 * comptes du pare-feu dit oui, la session s'ouvre.
 *
 * Mesure de depart (terminal Linux, `ssh admin@10.0.10.2`, saisie vide) :
 * « Permission denied, please try again. » alors que
 * `authenticateAdmin('admin', '')` rend `true`. Le contexte serveur du
 * pare-feu declarait `permitEmptyPasswords() { return false; }`, ce qui
 * fermait la porte AVANT que le magasin de comptes soit consulte.
 *
 * Discriminee par `git stash push -- src/network` : 2 des 4 cas tombent
 * (mot de passe vide accepte depuis un terminal Linux et depuis un
 * terminal Windows). Passent des deux cotes les deux TEMOINS : un mot de
 * passe fixe refuse la saisie vide, et un mauvais mot de passe reste
 * refuse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const PARE_FEU = '10.0.10.2';
const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function laboratoire(adminPassword: string | null) {
  const pareFeu = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const shell = pareFeu.getShell();
  const linux = new LinuxPC('linux-pc', 'PC', -150, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', -150, 100);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  linux.powerOn(); windows.powerOn(); commutateur.powerOn();
  new Cable('a').connect(linux.getPort('eth0')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(pareFeu.getPort('port1')!, commutateur.getPort('eth1')!);
  new Cable('c').connect(windows.getPorts()[0], commutateur.getPort('eth2')!);
  for (const ligne of [
    'config system interface', 'edit "port1"', 'set mode static', `set ip ${PARE_FEU} 255.255.255.0`,
    'set allowaccess ping https ssh', 'next', 'end',
  ]) shell.execute(ligne);
  if (adminPassword !== null) {
    for (const ligne of ['config system admin', 'edit "admin"', `set password "${adminPassword}"`, 'next', 'end']) shell.execute(ligne);
  }
  await linux.executeCommand('ip link set eth0 up');
  await linux.executeCommand('ip addr add 10.0.10.9/24 dev eth0');
  windows.getPorts()[0].configureIP(new IPAddress('10.0.10.8'), new SubnetMask('255.255.255.0'));
  return { linux, windows };
}

async function ouvrirSsh(host: TerminalSession, motDePasse: string): Promise<void> {
  host.setInput(`ssh -o StrictHostKeyChecking=accept-new admin@${PARE_FEU}`);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 60 && host.currentInputMode.type !== 'password'; i++) await tick();
  host.setPasswordBuf(motDePasse);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 20; i++) await tick();
}

const surLePareFeu = (host: TerminalSession): boolean => /FGT\b.*#/.test(host.getPrompt());

describe('le compte admin d\'usine, mot de passe vide', () => {
  it('terminal Linux : la saisie vide ouvre la session', async () => {
    const { linux } = await laboratoire(null);
    const host = new LinuxTerminalSession('h', linux);
    await host.init?.();
    await ouvrirSsh(host, '');
    expect(surLePareFeu(host)).toBe(true);
  }, 60_000);

  it('terminal Windows : la saisie vide ouvre la session', async () => {
    const { windows } = await laboratoire(null);
    const host = new WindowsTerminalSession('h', windows);
    await host.init?.();
    await ouvrirSsh(host, '');
    expect(surLePareFeu(host)).toBe(true);
  }, 60_000);

  it('TEMOIN: un mot de passe fixe refuse la saisie vide', async () => {
    const { linux } = await laboratoire('Secret123');
    const host = new LinuxTerminalSession('h', linux);
    await host.init?.();
    await ouvrirSsh(host, '');
    expect(surLePareFeu(host)).toBe(false);
  }, 60_000);

  it('TEMOIN: un mauvais mot de passe reste refuse, meme sur le compte d\'usine', async () => {
    const { linux } = await laboratoire(null);
    const host = new LinuxTerminalSession('h', linux);
    await host.init?.();
    await ouvrirSsh(host, 'nimporte-quoi');
    expect(surLePareFeu(host)).toBe(false);
  }, 60_000);
});
