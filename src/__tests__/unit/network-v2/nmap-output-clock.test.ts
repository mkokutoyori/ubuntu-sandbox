/*
 * What nmap 7.94 writes around a scan, and when: the banner's date, the
 * -oN and -oG headers and footers, the detection note, and what a host
 * that did not answer leaves behind. Read in nmap at commit 3be01efb1 (the
 * 7.94 Ubuntu packages): nmap.cc:1547 (strftime "%Y-%m-%d %H:%M %Z" for the
 * banner, LOG_STDOUT only), nmap.cc:1983 ("# Nmap 7.94 scan initiated
 * <ctime> as: <args>" to LOG_NORMAL|LOG_MACHINE), output.cc printfinaloutput
 * ("Note: Host seems down" to LOG_STDOUT when one host was scanned, none
 * answered and pinging was on; the detection note to LOG_PLAIN; "# Nmap
 * done at <ctime> -- …" to the files), output.cc write_host_header (a down
 * host's report only under -v or -R). The time is the machine's own, in
 * its own zone — the reading `date` gives.
 *
 * Measured before: the banner had no date; -oN copied the screen, banner
 * and "Nmap done:" line included; -oG had neither date nor duration; a
 * down host printed "Nmap scan report for … [host down]" plus the note
 * whatever the options; no detection note; a blank line followed the
 * banner; the -v phase times and the XML dates used the zone of the
 * JavaScript runtime, not the machine's.
 *
 * DISCRIMINATION (git stash of src/network, src/powershell): all 6 cases
 * fall before the change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab(): Promise<LinuxServer> {
  const pc = new LinuxPC('PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return srv;
}

const CTIME = /[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}/.source;

describe('the banner carries the machine\'s date, in the machine\'s zone', () => {
  it('UTC by default, and the report follows at once', async () => {
    const srv = await lab();
    const lines = (await srv.executeCommand('nmap -p 22 10.0.0.1')).split('\n');
    expect(lines[0]).toMatch(/^Starting Nmap 7\.94 \( https:\/\/nmap\.org \) at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(lines[1]).toBe('Nmap scan report for 10.0.0.1');
  });

  it('timedatectl moves it, and it agrees with date', async () => {
    const srv = await lab();
    await srv.executeCommand('timedatectl set-timezone Europe/Paris');
    const zone = (await srv.executeCommand('date +%Z')).trim();
    const banner = (await srv.executeCommand('nmap -p 22 10.0.0.1')).split('\n')[0];
    expect(['CET', 'CEST']).toContain(zone);
    expect(banner.endsWith(` ${zone}`)).toBe(true);
  });

  it('Windows names its zone the Windows way', () => {
    return (async () => {
      const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
      const banner = (await win.executeCommand('nmap -Pn -p 22 10.0.0.9')).split('\n')[0];
      expect(banner).toMatch(/ at \d{4}-\d{2}-\d{2} \d{2}:\d{2} Coordinated Universal Time$/);
    })();
  });
});

describe('-oN and -oG have their own first and last lines', () => {
  it('-oN opens with "scan initiated" and closes with "# Nmap done at", without the screen\'s banner', async () => {
    const srv = await lab();
    await srv.executeCommand('nmap -p 22 -oN /tmp/s.nmap -oG /tmp/s.gnmap 10.0.0.1');
    const normal = (await srv.executeCommand('cat /tmp/s.nmap')).split('\n');
    expect(normal[0]).toMatch(new RegExp(`^# Nmap 7\\.94 scan initiated ${CTIME} as: nmap -p 22 -oN /tmp/s\\.nmap -oG /tmp/s\\.gnmap 10\\.0\\.0\\.1$`));
    expect(normal[1]).toBe('Nmap scan report for 10.0.0.1');
    expect(normal.at(-1)).toMatch(new RegExp(`^# Nmap done at ${CTIME} -- 1 IP address \\(1 host up\\) scanned in \\d+\\.\\d{2} seconds$`));
    expect(normal.join('\n')).not.toContain('Starting Nmap');
    const grep = (await srv.executeCommand('cat /tmp/s.gnmap')).split('\n');
    expect(grep[0]).toMatch(new RegExp(`^# Nmap 7\\.94 scan initiated ${CTIME} as: nmap `));
    expect(grep.at(-1)).toMatch(new RegExp(`^# Nmap done at ${CTIME} -- 1 IP address \\(1 host up\\) scanned in \\d+\\.\\d{2} seconds$`));
  });
});

describe('what printfinaloutput adds', () => {
  it('a lone host that did not answer leaves only the note; -v shows its report', async () => {
    const srv = await lab();
    expect((await srv.executeCommand('nmap 10.0.0.99')).split('\n').slice(1)).toEqual([
      'Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn',
      'Nmap done: 1 IP address (0 hosts up) scanned in 0.05 seconds',
    ]);
    expect(await srv.executeCommand('nmap -v 10.0.0.99')).toContain('Nmap scan report for 10.0.0.99 [host down]');
  });

  it('-sV ends with the service detection note, on screen and in -oN', async () => {
    const srv = await lab();
    const screen = (await srv.executeCommand('nmap -sV -p 22 -oN /tmp/v.nmap 10.0.0.1')).split('\n');
    const note = 'Service detection performed. Please report any incorrect results at https://nmap.org/submit/ .';
    expect(screen.at(-2)).toBe(note);
    expect((await srv.executeCommand('cat /tmp/v.nmap')).split('\n').at(-2)).toBe(note);
  });
});
