/*
 * Une machine Linux n'a qu'UN nom vu de l'interieur : celui que
 * `hostname`, `uname -n`, `$HOSTNAME`, `/proc/sys/kernel/hostname`, l'invite,
 * syslog et le nom annonce au DHCP donnent tous, au meme instant.
 *
 * L'AUTORITE :
 * - hostname(1), gethostname(2) et sethostname(2) : `hostname` sans argument
 *   affiche le nom du noyau ; `hostname NOM` (root) le change et NE TOUCHE
 *   PAS `/etc/hostname`, que seul le demarrage suivant relit ;
 * - hostnamectl(1) : `set-hostname` ecrit le nom STATIQUE (`/etc/hostname`) et
 *   pose le nom du noyau ; sans argument il affiche « Static hostname » et,
 *   quand les deux different, « Transient hostname » ;
 * - bash(1), PROMPTING : `\h` est le nom d'hote, celui de gethostname() ;
 * - hosts(5) : `hostname NOM` ne reecrit pas `/etc/hosts`.
 *
 * Ecrite a l'aveugle. Le poste s'appelle PC1 sur le canevas : c'est aussi
 * son nom de machine tant que personne ne le change. Avant le correctif,
 * `hostname` repondait « linux-pc », le nom du modele, pendant que l'invite
 * disait PC1. 17 des 19 cas tombent avant. Passent des deux cotes les
 * TEMOINS : l'invite, et le renommage fait depuis l'interface, qui ecrivait
 * deja les deux noms.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function pc(): LinuxPC {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0);
  machine.powerOn();
  return machine;
}

const promptOf = (machine: LinuxPC): string => new LinuxTerminalSession('t', machine).getPrompt();

describe('every view of the name agrees on a fresh machine', () => {
  it.each([
    ['hostname'],
    ['uname -n'],
    ['echo $HOSTNAME'],
    ['cat /proc/sys/kernel/hostname'],
    ['cat /etc/hostname'],
    ['hostname -f'],
  ])('%s says PC1', async (command) => {
    expect(await pc().executeCommand(command)).toBe('PC1');
  });

  it('hostnamectl names PC1 as the static hostname', async () => {
    expect(await pc().executeCommand('hostnamectl')).toMatch(/Static hostname: PC1\n/);
  });

  it('the loopback alias of /etc/hosts names PC1', async () => {
    expect(await pc().executeCommand('cat /etc/hosts')).toContain('127.0.1.1\tPC1');
  });

  it('a syslog line carries PC1', async () => {
    const machine = pc();
    await machine.executeCommand('logger hi');

    expect(await machine.executeCommand('tail -1 /var/log/syslog')).toMatch(/^\w{3} +\d+ [\d:]+ PC1 /);
  });

  it('the prompt names PC1 — WITNESS', async () => {
    expect(promptOf(pc())).toBe('user@PC1:~$ ');
  });

  it('a server is named like its canvas label too', async () => {
    const server = new LinuxServer('linux-server', 'SRV1', 0, 0);
    server.powerOn();

    expect(await server.executeCommand('hostname')).toBe('SRV1');
  });
});

describe('hostname NAME changes the name of the kernel and nothing else', () => {
  it('every view follows, /etc/hostname does not', async () => {
    const machine = pc();
    await machine.executeCommand('sudo hostname edge');

    expect(await machine.executeCommand('hostname')).toBe('edge');
    expect(await machine.executeCommand('uname -n')).toBe('edge');
    expect(await machine.executeCommand('cat /proc/sys/kernel/hostname')).toBe('edge');
    expect(await machine.executeCommand('cat /etc/hostname')).toBe('PC1');
    expect(getHostname(machine)).toBe('edge');
  });

  it('the prompt of a new terminal follows', async () => {
    const machine = pc();
    await machine.executeCommand('sudo hostname edge');

    expect(promptOf(machine)).toBe('user@edge:~$ ');
  });

  it('hostnamectl then shows both names', async () => {
    const machine = pc();
    await machine.executeCommand('sudo hostname edge');
    const shown = await machine.executeCommand('hostnamectl');

    expect(shown).toMatch(/Static hostname: PC1\n/);
    expect(shown).toMatch(/Transient hostname: edge\n/);
  });

  it('/etc/hosts is left alone', async () => {
    const machine = pc();
    await machine.executeCommand('sudo hostname edge');

    expect(await machine.executeCommand('cat /etc/hosts')).toContain('127.0.1.1\tPC1');
  });

  it('without root it is refused and nothing changes', async () => {
    const machine = pc();
    const answer = await machine.executeCommand('hostname edge');

    expect(answer).toBe('hostname: you must be root to change the host name');
    expect(await machine.executeCommand('hostname')).toBe('PC1');
  });
});

describe('hostnamectl set-hostname NAME sets the static name and the kernel name', () => {
  it('both agree afterwards, and the prompt follows', async () => {
    const machine = pc();
    await machine.executeCommand('sudo hostnamectl set-hostname core');

    expect(await machine.executeCommand('hostname')).toBe('core');
    expect(await machine.executeCommand('cat /etc/hostname')).toBe('core');
    expect(await machine.executeCommand('hostnamectl')).toMatch(/Static hostname: core\n/);
    expect(await machine.executeCommand('hostnamectl')).not.toContain('Transient hostname');
    expect(promptOf(machine)).toBe('user@core:~$ ');
  });

  it('the rename made from the interface is the same thing', async () => {
    const machine = pc();
    machine.setHostname('core');

    expect(await machine.executeCommand('hostname')).toBe('core');
    expect(await machine.executeCommand('cat /etc/hostname')).toBe('core');
  });
});

describe('a reboot reads the static name again', () => {
  it('the transient name is gone', async () => {
    const machine = pc();
    await machine.executeCommand('sudo hostname edge');
    await machine.executeCommand('sudo reboot');

    expect(await machine.executeCommand('hostname')).toBe('PC1');
  });
});

function getHostname(machine: LinuxPC): string {
  return (machine as unknown as { getHostname(): string }).getHostname();
}
