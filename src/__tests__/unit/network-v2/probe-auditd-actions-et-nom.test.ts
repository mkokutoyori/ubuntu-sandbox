/**
 * Les actions d'espace d'auditd (EMAIL, EXEC, SINGLE, HALT), la resolution du domaine de action_mail_acct et
 * name_format (audit 3.1.2, auditd-event.c, auditd-config.c validate_email, auditd.c resolve_node). Le demon reel
 * n'a pas pu etre lance dans ce conteneur : l'oracle est le texte du source.
 *
 * Mesure avant : hostResolves repondait toujours oui, de sorte qu'un domaine inconnu etait accepte sans le message
 * « failed looking up host » ; rescue.target, poweroff.target et halt.target n'existaient pas, si bien que SINGLE et
 * HALT journalisaient leur alerte sans rien changer ; un demon qui abandonnait son demarrage (nom USER absent) ou
 * s'arretait de lui-meme laissait son processus et son unite actifs. Avec src/network remis avant, 4 cas tombent
 * (domaine inconnu, SINGLE, HALT, nom USER absent) ; les autres sont des sondes de non-regression qui passent dans les
 * deux etats. Le temoin du domaine (connu de /etc/hosts) et « espace suffisant, rien n'est signale » bornent les cas
 * qui refusent. Un domaine inconnu n'arrete pas le demon : validate_email rend 1 (echec temporaire) et le parseur
 * ne refuse qu'au-dela de 1.
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

const withConf = (overrides: Record<string, string>): string =>
  SHIPPED_AUDITD_CONF.split('\n').map((line) => {
    const key = line.split(' = ')[0];
    return key in overrides ? `${key} = ${overrides[key]}` : line;
  }).join('\n');

async function install(pc: LinuxPC, overrides: Record<string, string>): Promise<string> {
  const body = withConf(overrides).replace(/'/g, "'\\''");
  await pc.executeCommand(`printf '%s' '${body}' > /etc/audit/auditd.conf`);
  return pc.executeCommand('service auditd restart');
}

type Vfs = { setCapacityBytes(n: number): void; usedBytes(): number };
const vfsOf = (pc: LinuxPC): Vfs => (pc as unknown as { executor: { vfs: Vfs } }).executor.vfs;

const MEGABYTE = 1024 * 1024;
const journal = (pc: LinuxPC): Promise<string> => pc.executeCommand('journalctl -t auditd --no-pager');

async function leaveFreeBytes(pc: LinuxPC, bytes: number): Promise<void> {
  const vfs = vfsOf(pc);
  vfs.setCapacityBytes(vfs.usedBytes() + bytes);
  for (let i = 0; i < 12; i++) await pc.executeCommand(`auditctl -m trigger${i}`);
}

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('action_mail_acct domain lookup', () => {
  it('witness: a domain known to /etc/hosts is accepted', async () => {
    const pc = await rootHost();
    await pc.executeCommand('echo "192.0.2.25 mail.example.test" >> /etc/hosts');
    await install(pc, { action_mail_acct: 'ops@mail.example.test' });
    expect(await pc.executeCommand('pgrep -x auditd')).not.toBe('');
  });

  it('an unknown domain is reported with the resolver message but, being a temporary failure (rc 1), is kept', async () => {
    const pc = await rootHost();
    await install(pc, { action_mail_acct: 'ops@nowhere.invalid' });
    expect(await journal(pc)).toContain('validate_email: failed looking up host for nowhere.invalid (Name or service not known)');
    expect(await pc.executeCommand('pgrep -x auditd')).not.toBe('');
    expect(await pc.executeCommand('auditctl -m kept')).toBe('');
  });

  it('an address that is not an e-mail at all is refused for good (rc 2) and the daemon does not start', async () => {
    const pc = await rootHost();
    await install(pc, { action_mail_acct: 'ops@nodots' });
    expect(await journal(pc)).toContain('email: ops@nodots should have . after @');
    expect(await pc.executeCommand('pgrep -x auditd')).toBe('');
  });
});

describe('space_left_action', () => {
  it('witness: with enough space nothing is reported', async () => {
    const pc = await rootHost();
    await install(pc, { space_left: '2', admin_space_left: '1', space_left_action: 'EMAIL' });
    await pc.executeCommand('auditctl -m quiet');
    expect(await journal(pc)).not.toContain('low on disk space');
    expect(await pc.executeCommand('ls /var/mail')).not.toContain('root');
  });

  it('EMAIL mails action_mail_acct and logs the alert once', async () => {
    const pc = await rootHost();
    await install(pc, { space_left: '2', admin_space_left: '1', space_left_action: 'EMAIL' });
    await leaveFreeBytes(pc, Math.floor(1.5 * MEGABYTE));
    await pc.executeCommand('auditctl -m again');
    const mail = await pc.executeCommand('cat /var/mail/root');
    expect(mail).toContain('Subject: Audit Disk Space Alert');
    expect(mail).toContain('The audit daemon is low on disk space for logging!');
    expect(((await journal(pc)).match(/Audit daemon is low on disk space for logging/g) ?? []).length).toBe(1);
  });

  it('admin_space_left_action = EMAIL sends the louder message', async () => {
    const pc = await rootHost();
    await install(pc, { space_left: '2', admin_space_left: '1', space_left_action: 'IGNORE', admin_space_left_action: 'EMAIL' });
    await leaveFreeBytes(pc, Math.floor(0.5 * MEGABYTE));
    expect(await pc.executeCommand('cat /var/mail/root')).toContain('Subject: Audit Admin Space Alert');
  });

  it('EXEC runs the named program and suspends logging', async () => {
    const pc = await rootHost();
    await pc.executeCommand('printf "#!/bin/sh\\ntouch /root/alert-ran\\n" > /root/alert.sh && chmod 755 /root/alert.sh');
    await install(pc, { space_left: '2', admin_space_left: '1', space_left_action: 'EXEC /root/alert.sh' });
    await leaveFreeBytes(pc, Math.floor(1.5 * MEGABYTE));
    expect(await pc.executeCommand('ls /root/alert-ran')).toBe('/root/alert-ran');
    const before = Number((await pc.executeCommand('wc -l < /var/log/audit/audit.log')).trim());
    await pc.executeCommand('auditctl -m afterexec');
    expect(Number((await pc.executeCommand('wc -l < /var/log/audit/audit.log')).trim())).toBe(before);
  });

  it('SINGLE switches the machine to rescue mode and stops the daemon', async () => {
    const pc = await rootHost();
    await install(pc, { space_left: '2', admin_space_left: '1', space_left_action: 'SINGLE' });
    expect(await pc.executeCommand('systemctl is-active cron')).toBe('active');
    await leaveFreeBytes(pc, Math.floor(1.5 * MEGABYTE));
    expect(await journal(pc)).toContain('The audit daemon is now changing the system to single user mode and exiting due to low disk space');
    expect(await pc.executeCommand('pgrep -x auditd')).toBe('');
    expect(await pc.executeCommand('systemctl is-active cron')).toBe('inactive');
  });

  it('HALT powers the machine off and stops the daemon', async () => {
    const pc = await rootHost();
    await install(pc, { space_left: '2', admin_space_left: '1', space_left_action: 'HALT' });
    await leaveFreeBytes(pc, Math.floor(1.5 * MEGABYTE));
    expect(await journal(pc)).toContain('The audit daemon is now halting the system and exiting due to low disk space');
    expect(await pc.executeCommand('pgrep -x auditd')).toBe('');
    expect(await pc.executeCommand('systemctl is-active cron')).toBe('inactive');
  });
});

describe('name_format', () => {
  const firstLine = async (pc: LinuxPC): Promise<string> => (await pc.executeCommand('tail -n 1 /var/log/audit/audit.log')).trim();

  it('witness: NONE leaves the line without a node field', async () => {
    const pc = await rootHost();
    await install(pc, { log_format: 'RAW' });
    await pc.executeCommand('auditctl -m plain');
    expect(await firstLine(pc)).toMatch(/^type=USER /);
  });

  it('HOSTNAME prefixes node=<hostname>', async () => {
    const pc = await rootHost();
    await install(pc, { log_format: 'RAW', name_format: 'HOSTNAME' });
    await pc.executeCommand('auditctl -m named');
    expect(await firstLine(pc)).toMatch(/^node=AuditHost type=USER /);
  });

  it('USER prefixes the configured name and refuses a missing one', async () => {
    const pc = await rootHost();
    await install(pc, { log_format: 'RAW', name_format: 'USER' });
    await pc.executeCommand('echo "name = central-1" >> /etc/audit/auditd.conf; service auditd restart');
    await pc.executeCommand('auditctl -m custom');
    expect(await firstLine(pc)).toMatch(/^node=central-1 type=USER /);
    await install(pc, { log_format: 'RAW', name_format: 'USER' });
    expect(await journal(pc)).toContain('User defined name missing');
    expect(await pc.executeCommand('pgrep -x auditd')).toBe('');
  });

  it('NUMERIC prefixes the primary address', async () => {
    const pc = await rootHost();
    await pc.executeCommand('ifconfig eth0 192.0.2.7 netmask 255.255.255.0 up');
    await install(pc, { log_format: 'RAW', name_format: 'NUMERIC' });
    await pc.executeCommand('auditctl -m numeric');
    expect(await firstLine(pc)).toMatch(/^node=192\.0\.2\.7 type=USER /);
  });
});
