/**
 * Un plugin audisp dont le programme n'est ni audisp-syslog ni audisp-af_unix (audit 3.1.2, audisp/audispd.c :
 * le programme lit les evenements sur son entree standard, un par ligne). Le demon reel n'a pas pu etre lance dans
 * ce conteneur : l'oracle est le texte du source. L'interprete de scripts est synchrone : l'evenement est donc remis
 * en lancant le programme une fois par evenement, sous le pid du processus plugin, en root, avec la ligne pour
 * entree standard ; les variables du script ne survivent pas d'un evenement a l'autre (limite consignee dans TODO.md).
 *
 * Mesure avant : tout programme inconnu sortait aussitot et ne recevait aucun evenement. Avec src/network remis avant,
 * 3 cas sur 4 tombent (le script ne recevait pas non plus l'entree d'un tube : voir probe-script-lit-son-entree-standard) ; le temoin (plugin inactif, rien recu) passe dans les deux etats et borne les cas qui recoivent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

async function rootHost(): Promise<LinuxPC> {
  const pc = new LinuxPC('AuditHost', 0, 0);
  await pc.executeCommand('sudo su -');
  return pc;
}

const PLUGIN_CONF = [
  'active = yes', 'direction = out', 'path = /usr/local/sbin/collect.sh', 'type = always', 'format = string',
].join('\n');

async function installCollector(pc: LinuxPC, active = 'yes'): Promise<void> {
  await pc.executeCommand(
    'printf \'#!/bin/bash\\nwhile read line; do echo "$line" >> /var/tmp/collected.log; done\\n\' > /usr/local/sbin/collect.sh && chmod 755 /usr/local/sbin/collect.sh');
  await pc.executeCommand(`printf '${PLUGIN_CONF.replace('active = yes', `active = ${active}`)}\\n' > /etc/audit/plugins.d/collect.conf`);
  await pc.executeCommand('systemctl restart auditd');
}

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('audisp plugin running an arbitrary program', () => {
  it('witness: an inactive plugin receives nothing', async () => {
    const pc = await rootHost();
    await installCollector(pc, 'no');
    await pc.executeCommand('auditctl -m ignored');
    expect(await pc.executeCommand('cat /var/tmp/collected.log')).toContain('No such file');
  });

  it('receives every event on its standard input', async () => {
    const pc = await rootHost();
    await installCollector(pc);
    await pc.executeCommand('auditctl -m first');
    await pc.executeCommand('auditctl -m second');
    const collected = await pc.executeCommand('cat /var/tmp/collected.log');
    expect(collected).toMatch(/type=USER .*text=first/);
    expect(collected).toMatch(/type=USER .*text=second/);
  });

  it('runs as a child of auditd, as root, whoever triggered the event', async () => {
    const pc = await rootHost();
    await installCollector(pc);
    const daemon = (await pc.executeCommand('pgrep -x auditd')).trim();
    expect((await pc.executeCommand('ps -o ppid= -C collect.sh')).trim()).toBe(daemon);
    await pc.executeCommand('auditctl -m owner');
    expect((await pc.executeCommand('stat -c %U /var/tmp/collected.log')).trim()).toBe('root');
  });

  it('leaves the caller\'s exit status and directory untouched', async () => {
    const pc = await rootHost();
    await installCollector(pc);
    await pc.executeCommand('cd /etc');
    expect(await pc.executeCommand('auditctl -m keep; echo rc=$?; pwd')).toBe('rc=0\n/etc');
  });
});
