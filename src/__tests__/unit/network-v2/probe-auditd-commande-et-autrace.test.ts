/**
 * La commande `auditd` (audit 3.1.2, src/auditd.c : getopt_long « flns:c: », usage, code 4 hors root, -s par
 * prefixe, -c = repertoire contenant auditd.conf, fichier pid, set-pid refuse quand un demon tient deja le noyau)
 * et `autrace` (src/autrace.c : refus hors root, programme introuvable par access(), refus avec des regles chargees,
 * deux regles pid=N / ppid=N, execution du fils sous ce pid, nettoyage, phrase finale). Le binaire reel n'a pas pu
 * etre lance dans ce conteneur (il exige l'ecriture de /etc/audit) : l'oracle est le texte du source.
 *
 * Mesure avant : `auditd` et `autrace` etaient inconnus du shell (« command not found ») ; /var/run/auditd.pid
 * n'existait pas ; un evenement emis pendant un script portait le pid du shell. Avec src/network remis avant, les 17
 * cas tombent, temoin compris (il lit le fichier pid que le demon n'ecrivait pas). Aucun cas ne passe dans les deux
 * etats ; la borne est donnee par le temoin, qui prouve que le demon lance par systemd est celui que `pgrep` voit.
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

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('auditd command', () => {
  it('witness: the service-started daemon writes its pid file and answers to a second start', async () => {
    const pc = await rootHost();
    const pid = (await pc.executeCommand('cat /var/run/auditd.pid')).trim();
    expect(pid).toMatch(/^\d+$/);
    expect((await pc.executeCommand('pgrep -x auditd')).trim()).toBe(pid);
  });

  it('refuses an unknown option with the getopt message then the usage, exit 2', async () => {
    const pc = await rootHost();
    expect(await pc.executeCommand('auditd -x; echo rc=$?')).toBe(
      "auditd: invalid option -- 'x'\nUsage: auditd [-f] [-l] [-n] [-s disable|enable|nochange] [-c <config_file>]\nrc=2");
  });

  it('refuses an unknown startup mode and trailing arguments', async () => {
    const pc = await rootHost();
    expect(await pc.executeCommand('auditd -s bogus; echo rc=$?')).toContain("unknown startup mode 'bogus'\nUsage: auditd");
    expect(await pc.executeCommand('auditd extra; echo rc=$?')).toMatch(/^Usage: auditd .*\nrc=2$/);
  });

  it('refuses a non-root user with exit 4', async () => {
    const pc = new LinuxPC('AuditHost', 0, 0);
    expect(await pc.executeCommand('auditd; echo rc=$?')).toBe('You must be root or have capabilities to run this program.\nrc=4');
  });

  it('a second daemon cannot take the kernel: set-pid fails, DAEMON_ABORT is logged, exit 1', async () => {
    const pc = await rootHost();
    const pid = (await pc.executeCommand('cat /var/run/auditd.pid')).trim();
    expect(await pc.executeCommand('auditd; echo rc=$?')).toBe('rc=1');
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain('Unable to set audit pid, exiting');
    expect(await pc.executeCommand('ausearch -m DAEMON_ABORT -i')).toMatch(/op=set-pid auid=unset pid=\d+ uid=root ses=unset subj=unconfined res=failed/);
    expect((await pc.executeCommand('auditctl -s')).split('\n').find((line) => line.startsWith('pid '))).toBe(`pid ${pid}`);
  });

  it('starts by hand once stopped: pid file, kernel pid, -s disable leaves auditing off, SIGTERM removes the pid file', async () => {
    const pc = await rootHost();
    await pc.executeCommand('systemctl stop auditd');
    expect(await pc.executeCommand('auditd -s disable; echo rc=$?')).toBe('rc=0');
    const pid = (await pc.executeCommand('cat /var/run/auditd.pid')).trim();
    expect(await pc.executeCommand('pgrep -x auditd')).toContain(pid);
    const status = await pc.executeCommand('auditctl -s');
    expect(status).toContain('enabled 0');
    expect(status).toContain(`pid ${pid}`);
    await pc.executeCommand(`kill -TERM ${pid}`);
    expect(await pc.executeCommand('ls /var/run/auditd.pid')).toContain('No such file');
    expect(await pc.executeCommand('pgrep -x auditd')).toBe('');
  });

  it('-s accepts a prefix and names the state in the init message', async () => {
    const pc = await rootHost();
    await pc.executeCommand('systemctl stop auditd');
    await pc.executeCommand('auditd -s noc');
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain('startup state nochange');
  });

  it('-f prints the daemon messages on stderr instead of the journal and writes no log', async () => {
    const pc = await rootHost();
    await pc.executeCommand('systemctl stop auditd');
    const before = await pc.executeCommand('wc -c < /var/log/audit/audit.log');
    const out = await pc.executeCommand('auditd -f');
    expect(out).toContain('Init complete, auditd 3.1.2 listening for events (startup state enable)');
    await pc.executeCommand('auditctl -m foreground');
    expect(await pc.executeCommand('wc -c < /var/log/audit/audit.log')).toBe(before);
  });

  it('-c names a directory holding auditd.conf', async () => {
    const pc = await rootHost();
    await pc.executeCommand('systemctl stop auditd');
    await pc.executeCommand('mkdir -p /root/alt && sed "s/^num_logs = 5/num_logs = 9/" /etc/audit/auditd.conf > /root/alt/auditd.conf');
    expect(await pc.executeCommand('auditd -c /root/alt; echo rc=$?')).toBe('rc=0');
    await pc.executeCommand('kill -USR1 $(cat /var/run/auditd.pid)');
    expect((await pc.executeCommand('ls -1 /var/log/audit')).split('\n')).toContain('audit.log.1');
  });

  it('exits 6 when the configuration is invalid, and starts on defaults when the file is absent', async () => {
    const pc = await rootHost();
    await pc.executeCommand('systemctl stop auditd');
    await pc.executeCommand('mkdir -p /root/bad && echo "log_format = BOGUS" > /root/bad/auditd.conf');
    expect(await pc.executeCommand('auditd -c /root/bad; echo rc=$?')).toBe('rc=6');
    expect(await pc.executeCommand('pgrep -x auditd')).toBe('');
    expect(await pc.executeCommand('auditd -c /nonexistent; echo rc=$?')).toBe('rc=0');
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain("Config file /nonexistent/auditd.conf doesn't exist, skipping");
  });
});

describe('autrace', () => {
  it('prints usage with no argument and with -h, exit 1', async () => {
    const pc = await rootHost();
    expect(await pc.executeCommand('autrace; echo rc=$?')).toBe('usage: autrace [-r] program\nrc=1');
    expect(await pc.executeCommand('autrace -h; echo rc=$?')).toBe('usage: autrace [-r] program\nrc=1');
  });

  it('refuses a non-root user', async () => {
    const pc = new LinuxPC('AuditHost', 0, 0);
    expect(await pc.executeCommand('autrace /bin/ls; echo rc=$?')).toBe('You must be root or have capabilities to run this program.\nrc=1');
  });

  it("looks the program up with access(): a bare name is not searched in PATH", async () => {
    const pc = await rootHost();
    expect(await pc.executeCommand('autrace ls; echo rc=$?')).toBe("Error - can't find: ls\nrc=1");
  });

  it('refuses to run with rules loaded', async () => {
    const pc = await rootHost();
    await pc.executeCommand('auditctl -w /etc/passwd -p wa -k pw');
    expect(await pc.executeCommand('autrace /bin/ls; echo rc=$?')).toBe(
      "autrace cannot be run with rules loaded.\nPlease delete all rules using 'auditctl -D' if you really wanted to\nrun this command.\nrc=1");
  });

  it('runs the program as a child under a fresh pid, leaves no rule behind and logs its syscalls under that pid', async () => {
    const pc = await rootHost();
    const out = await pc.executeCommand('autrace /usr/bin/cat /etc/hostname');
    const pid = /ausearch -i -p (\d+)'/.exec(out)?.[1];
    expect(pid).toBeDefined();
    expect(out).toMatch(/^Waiting to execute: \/usr\/bin\/cat\nAuditHost\nCleaning up\.\.\.\nTrace complete\. You can locate the records with 'ausearch -i -p \d+'$/);
    expect(await pc.executeCommand('auditctl -l')).toBe('No rules');
    const records = await pc.executeCommand(`ausearch -i -p ${pid}`);
    expect(records).toMatch(new RegExp(`syscall=execve .* pid=${pid} `));
    expect(records).toContain('name=/etc/hostname');
    expect(records).not.toMatch(new RegExp(`pid=${pid}\\b.*\\n.*pid=(?!${pid}\\b)`));
  });

  it('adds exactly the two rules of the source while the program runs, and removes them after', async () => {
    const pc = await rootHost();
    const out = await pc.executeCommand('autrace /usr/sbin/auditctl -l');
    const pid = /ausearch -i -p (\d+)'/.exec(out)?.[1];
    expect(out).toContain(`-a always,exit -S all -F pid=${pid}`);
    expect(out).toContain(`-a always,exit -S all -F ppid=${pid}`);
    const changes = await pc.executeCommand('ausearch -m CONFIG_CHANGE -i');
    expect((changes.match(/op=add_rule/g) ?? []).length).toBe(2);
    expect((changes.match(/op=remove_rule/g) ?? []).length).toBe(2);
  });

  it('-r traces a threat-analysis selection of syscalls rather than all', async () => {
    const pc = await rootHost();
    const out = await pc.executeCommand('autrace -r /usr/sbin/auditctl -l');
    expect(out).toMatch(/-a always,exit .*openat/);
    expect(out).toMatch(/-a always,exit .*execve/);
    expect(out).not.toContain('-S all');
  });
});
