/**
 * Le demon auditd applique sa configuration au journal /var/log/audit/audit.log (port d'auditd-event.c, audit
 * 3.1.2) : rotation par taille, num_logs, max_log_file_action, actions de bas niveau d'espace, ENRICHED,
 * permissions de log_group, SIGUSR1/SIGUSR2/SIGHUP. Le demon reel n'a pas ete lance dans ce conteneur (il exige
 * l'ecriture de /etc/audit) : l'oracle est le texte du source.
 *
 * Mesure avant : auditd.conf etait lu et jamais applique. max_log_file, num_logs, max_log_file_action, les
 * actions d'espace, log_format, log_group et flush n'avaient aucun effet : audit.log etait reecrit en entier a
 * chaque enregistrement, jamais tourne, toujours en RAW et en 0600 root:root ; SIGUSR1 n'ecrivait que
 * DAEMON_ROTATE sans rien tourner, SIGHUP ecrivait DAEMON_CONFIG meme quand le fichier etait invalide.
 * Avec src remis avant (LinuxAuditDaemon, LinuxAuditLog, LinuxAuditRules, LinuxAuditToolHost), 11 cas sur 13
 * tombent ; 2 passent dans les deux etats : le temoin (le journal recoit bien les enregistrements) et
 * « num_logs = 1 desactive la rotation » (refus que l'absence de rotation satisfait aussi) ; le temoin borne
 * les cas qui tournent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { SHIPPED_AUDITD_CONF } from '@/network/devices/linux/audit/daemon/AuditdConfFile';

async function rootHost(): Promise<LinuxPC> {
  const pc = new LinuxPC('AuditHost', 0, 0);
  await pc.executeCommand('sudo su -');
  return pc;
}

const withConf = (overrides: Record<string, string>): string => {
  const lines = SHIPPED_AUDITD_CONF.split('\n').map((line) => {
    const key = line.split(' = ')[0];
    return key in overrides ? `${key} = ${overrides[key]}` : line;
  });
  return lines.join('\n');
};

async function install(pc: LinuxPC, overrides: Record<string, string>): Promise<void> {
  const body = withConf(overrides).replace(/'/g, "'\\''");
  await pc.executeCommand(`printf '%s' '${body}' > /etc/audit/auditd.conf`);
  await pc.executeCommand('service auditd restart');
}

const send = async (pc: LinuxPC, count: number, tag = 'm'): Promise<void> => {
  for (let i = 0; i < count; i++) await pc.executeCommand(`auditctl -m ${tag}${i}`);
};

const lines = async (pc: LinuxPC, path = '/var/log/audit/audit.log'): Promise<string[]> =>
  (await pc.executeCommand(`cat ${path}`)).split('\n').filter((line) => line !== '');

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('auditd applies auditd.conf to its log', () => {
  it('witness: records reach audit.log', async () => {
    const pc = await rootHost();
    await send(pc, 2);
    expect((await lines(pc)).filter((l) => l.startsWith('type=USER ')).length).toBeGreaterThanOrEqual(2);
  });

  it('log_format = ENRICHED appends the interpreted ids after the 0x1d separator, RAW does not', async () => {
    const pc = await rootHost();
    await send(pc, 1, 'enr');
    const enriched = (await lines(pc)).find((l) => l.includes('text=enr0'))!;
    expect(enriched).toMatch(/\u001dUID="root" AUID="user"$/);
    await install(pc, { log_format: 'RAW' });
    await send(pc, 1, 'raw');
    const raw = (await lines(pc)).find((l) => l.includes('text=raw0'))!;
    expect(raw).not.toContain('\u001d');
  });

  it('the log is root:adm 0640 with log_group = adm and root:root 0600 without', async () => {
    const pc = await rootHost();
    expect((await pc.executeCommand('stat -c "%a %U:%G" /var/log/audit/audit.log /var/log/audit')).trim().split('\n')).toEqual(['640 root:adm', '750 root:adm']);
    await install(pc, { log_group: 'root' });
    expect((await pc.executeCommand('stat -c "%a %U:%G" /var/log/audit/audit.log /var/log/audit')).trim().split('\n')).toEqual(['600 root:root', '700 root:root']);
  });

  it('max_log_file_action = ROTATE shifts audit.log to .1 and keeps num_logs files', async () => {
    const pc = await rootHost();
    await install(pc, { max_log_file: '0', num_logs: '3', max_log_file_action: 'ROTATE' });
    await send(pc, 6);
    const listing = (await pc.executeCommand('ls /var/log/audit')).trim().split(/\s+/);
    expect(listing).toEqual(['audit.log', 'audit.log.1', 'audit.log.2']);
    expect((await pc.executeCommand('stat -c "%a" /var/log/audit/audit.log.1 /var/log/audit/audit.log.2')).trim().split('\n')).toEqual(['440', '440']);
  });

  it('a rotated log holds older events, and ausearch reads the whole rotated set', async () => {
    const pc = await rootHost();
    await install(pc, { max_log_file: '0', num_logs: '8', max_log_file_action: 'ROTATE' });
    await send(pc, 3, 'old');
    expect((await pc.executeCommand('ls /var/log/audit')).trim().split(/\s+/).length).toBeGreaterThan(3);
    const found = await pc.executeCommand('ausearch -m USER -i');
    for (let i = 0; i < 3; i++) expect(found).toContain(`text=old${i}`);
  });

  it('num_logs = 1 disables rotation: ROTATE does nothing and the log keeps growing', async () => {
    const pc = await rootHost();
    await install(pc, { max_log_file: '0', num_logs: '1', max_log_file_action: 'ROTATE' });
    await send(pc, 3);
    expect((await pc.executeCommand('ls /var/log/audit')).trim()).toBe('audit.log');
  });

  it('KEEP_LOGS never discards: files keep their numbers', async () => {
    const pc = await rootHost();
    await install(pc, { max_log_file: '0', num_logs: '2', max_log_file_action: 'KEEP_LOGS' });
    await send(pc, 4);
    const listing = (await pc.executeCommand('ls /var/log/audit')).trim().split(/\s+/);
    expect(listing.length).toBeGreaterThan(3);
  });

  it('SUSPEND stops writing and says why', async () => {
    const pc = await rootHost();
    await install(pc, { max_log_file: '0', max_log_file_action: 'SUSPEND' });
    await send(pc, 1, 'a');
    const before = (await lines(pc)).length;
    await send(pc, 2, 'b');
    expect((await lines(pc)).length).toBe(before);
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain('Audit daemon is suspending logging due to logfile size.');
  });

  it('SYSLOG reports the size once per write and keeps logging', async () => {
    const pc = await rootHost();
    await install(pc, { max_log_file: '0', max_log_file_action: 'SYSLOG' });
    await send(pc, 2);
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain('Audit daemon log file is larger than max size');
    expect((await lines(pc)).filter((l) => l.startsWith('type=USER ')).length).toBeGreaterThanOrEqual(2);
  });

  it('SIGUSR1 rotates the logs at once and records DAEMON_ROTATE in the new file', async () => {
    const pc = await rootHost();
    await send(pc, 2, 'before');
    await pc.executeCommand('systemctl kill -s SIGUSR1 auditd');
    expect((await pc.executeCommand('ls /var/log/audit')).trim().split(/\s+/)).toEqual(['audit.log', 'audit.log.1']);
    expect((await lines(pc)).some((l) => l.includes('op=rotate-logs'))).toBe(true);
    expect((await lines(pc, '/var/log/audit/audit.log.1')).some((l) => l.includes('text=before0'))).toBe(true);
  });

  it('SIGHUP applies a changed log_format and records DAEMON_CONFIG; an invalid file is refused without that record', async () => {
    const pc = await rootHost();
    await pc.executeCommand(`printf '%s' '${withConf({ log_format: 'RAW' }).replace(/'/g, "'\\''")}' > /etc/audit/auditd.conf`);
    await pc.executeCommand('systemctl kill -s SIGHUP auditd');
    expect((await lines(pc)).filter((l) => l.includes('op=reconfigure')).length).toBe(1);
    await pc.executeCommand('echo "bogus = 1" > /etc/audit/auditd.conf');
    await pc.executeCommand('systemctl kill -s SIGHUP auditd');
    expect((await lines(pc)).filter((l) => l.includes('op=reconfigure')).length).toBe(1);
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain('Unknown keyword "bogus" in line 1');
  });

  it('SIGCONT dumps the daemon state to /var/run/auditd.state', async () => {
    const pc = await rootHost();
    await pc.executeCommand('systemctl kill -s SIGCONT auditd');
    const state = await pc.executeCommand('cat /var/run/auditd.state');
    expect(state).toContain('audit version = 3.1.2');
    expect(state).toContain('writing to logs = yes');
    expect(state).toContain('logging suspended = no');
    expect(state).toContain('max log size = 8192 KB');
  });

  it('a full disk applies disk_full_action = SUSPEND, and SIGUSR2 resumes logging once space is back', async () => {
    const pc = await rootHost();
    const vfs = (pc as unknown as { executor: { vfs: { setCapacityBytes(n: number): void; getCapacityBytes(): number; usedBytes(): number } } }).executor.vfs;
    const capacity = vfs.getCapacityBytes();
    await send(pc, 1, 'fill');
    vfs.setCapacityBytes(vfs.usedBytes() + 300);
    await send(pc, 6, 'tail');
    const journal = await pc.executeCommand('journalctl -t auditd --no-pager');
    expect(journal).toContain('Audit daemon has no space left on logging partition');
    expect(journal).toContain('Audit daemon is suspending logging due to no space left on logging partition.');
    const frozen = (await lines(pc)).length;
    await send(pc, 2, 'lost');
    expect((await lines(pc)).length).toBe(frozen);
    vfs.setCapacityBytes(capacity);
    await pc.executeCommand('systemctl kill -s SIGUSR2 auditd');
    await send(pc, 1, 'back');
    const log = await lines(pc);
    expect(log.some((l) => l.includes('op=resume-logging'))).toBe(true);
    expect(log.some((l) => l.includes('text=back0'))).toBe(true);
  });
});
