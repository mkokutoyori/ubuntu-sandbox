/**
 * Le dispatcher d'auditd et ses plugins (audit 3.1.2, audisp/audispd.c, audisp-syslog.c, audisp-af_unix.c) sur
 * une machine Linux simulee : fichiers de /etc/audit/plugins.d, lancement des programmes comme enfants d'auditd,
 * envoi de chaque evenement au plugin, redemarrage apres mort, SIGHUP, etat. Le demon reel n'a pas ete lance dans
 * ce conteneur : l'oracle est le texte du source.
 *
 * Mesure avant : plugins.d n'existait pas, auditd annoncait toujours « 0 plugins » dans /var/run/auditd.state et
 * ne repondait jamais « No plugins found, not dispatching events » ; activer audisp-syslog ne transmettait aucun
 * evenement. Avec src remis avant, 10 cas sur 12 tombent ; 2 passent dans les deux etats : le temoin (auditd
 * ecrit l'evenement dans son journal) et « sans plugin actif, rien n'est transmis » (refus que l'absence de
 * dispatcher satisfait aussi) ; le temoin borne les cas qui transmettent.
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

const SYSLOG_CONF = '/etc/audit/plugins.d/syslog.conf';
const syslogLines = async (pc: LinuxPC, pattern: string): Promise<string[]> =>
  (await pc.executeCommand(`grep -E '${pattern}' /var/log/syslog`)).split('\n').filter((line) => line !== '');

const enable = async (pc: LinuxPC, args = 'LOG_INFO'): Promise<void> => {
  await pc.executeCommand(`sed -i 's/^active = no/active = yes/; s/^args = .*/args = ${args}/' ${SYSLOG_CONF}`);
  await pc.executeCommand('systemctl restart auditd');
};

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('auditd dispatcher and audisp plugins', () => {
  it('witness: auditd writes the event to its own log', async () => {
    const pc = await rootHost();
    await pc.executeCommand('auditctl -m witness');
    expect(await pc.executeCommand('grep -c text=witness /var/log/audit/audit.log')).toContain('1');
  });

  it('with no active plugin auditd says so and forwards nothing', async () => {
    const pc = await rootHost();
    await pc.executeCommand('auditctl -m quiet');
    const journal = await pc.executeCommand('journalctl -t auditd --no-pager');
    expect(journal).toContain('No plugins found, not dispatching events');
    expect(journal).toContain('Init complete, auditd 3.1.2 listening for events (startup state enable)');
    expect(await syslogLines(pc, 'audisp-syslog')).toEqual([]);
  });

  it('ships both plugin files, 0640 root:root, in a 0750 directory, with inactive plugins', async () => {
    const pc = await rootHost();
    expect((await pc.executeCommand('stat -c "%a %U:%G %n" /etc/audit/plugins.d /etc/audit/plugins.d/syslog.conf /etc/audit/plugins.d/af_unix.conf')).trim().split('\n'))
      .toEqual(['750 root:root /etc/audit/plugins.d', '640 root:root /etc/audit/plugins.d/syslog.conf', '640 root:root /etc/audit/plugins.d/af_unix.conf']);
  });

  it('an active audisp-syslog starts as a child of auditd and says how it was configured', async () => {
    const pc = await rootHost();
    await enable(pc);
    const pids = (await pc.executeCommand('pgrep -x auditd')).trim();
    expect((await pc.executeCommand('ps -o ppid=,args= -C audisp-syslog')).trim()).toBe(`${pids} /sbin/audisp-syslog LOG_INFO`);
    expect(await syslogLines(pc, 'audisp-syslog: syslog plugin initialized')).toHaveLength(1);
    expect((await syslogLines(pc, 'syslog plugin initialized'))[0]).toContain('with facility 8 and priority 6');
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain('audit dispatcher initialized with q_depth=2000 and 1 active plugins');
  });

  it('forwards each event to syslog under the tag audisp-syslog, the interpretation separator turned into a space', async () => {
    const pc = await rootHost();
    await enable(pc);
    await pc.executeCommand('auditctl -m forwarded');
    const lines = await syslogLines(pc, 'audisp-syslog: type=USER .*text=forwarded');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' UID="root" AUID="user"');
    expect(lines[0]).not.toContain('\u001d');
  });

  it('LOG_LOCAL3 changes the facility and the tag becomes audispd; interpret prints the fields interpreted', async () => {
    const pc = await rootHost();
    await enable(pc, 'LOG_LOCAL3 interpret');
    await pc.executeCommand('auditctl -m shown');
    const lines = await syslogLines(pc, 'audispd: type=USER');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/audispd: type=USER msg=audit\(\d\d\/\d\d\/\d\d \d\d:\d\d:\d\d\) : pid=\d+ uid=root auid=user ses=1 subj=unconfined text=shown /);
    expect(lines[0]).not.toContain('UID="root"');
  });

  it('an unknown argument makes the plugin exit; auditd restarts it until max_restarts', async () => {
    const pc = await rootHost();
    await pc.executeCommand('sed -i "s/^max_restarts = .*/max_restarts = 1/" /etc/audit/auditd.conf');
    await enable(pc, 'LOG_BOGUS');
    await pc.executeCommand('auditctl -m one');
    await pc.executeCommand('auditctl -m two');
    expect(await syslogLines(pc, 'Unknown log priority/facility LOG_BOGUS')).toHaveLength(2);
    const journal = await pc.executeCommand('journalctl -t auditd --no-pager');
    expect(journal.match(/plugin \/sbin\/audisp-syslog terminated unexpectedly/g)?.length).toBe(2);
    expect(journal).toContain('plugin /sbin/audisp-syslog has exceeded max_restarts');
    expect(journal.match(/plugin \/sbin\/audisp-syslog was restarted/g)?.length).toBe(2);
  });

  it('a plugin killed from outside is restarted when the next event arrives', async () => {
    const pc = await rootHost();
    await enable(pc);
    const before = (await pc.executeCommand('pgrep -x audisp-syslog')).trim();
    await pc.executeCommand(`kill -9 ${before}`);
    await pc.executeCommand('auditctl -m after-kill');
    const after = (await pc.executeCommand('pgrep -x audisp-syslog')).trim();
    expect(after).not.toBe('');
    expect(after).not.toBe(before);
    expect(await pc.executeCommand('journalctl -t auditd --no-pager')).toContain('plugin /sbin/audisp-syslog terminated unexpectedly');
    expect(await syslogLines(pc, 'text=after-kill')).toHaveLength(1);
  });

  it('SIGHUP terminates a plugin that was switched off and starts one that was switched on', async () => {
    const pc = await rootHost();
    await enable(pc);
    await pc.executeCommand(`sed -i 's/^active = yes/active = no/' ${SYSLOG_CONF}`);
    await pc.executeCommand('systemctl kill -s SIGHUP auditd');
    expect((await pc.executeCommand('pgrep -x audisp-syslog')).trim()).toBe('');
    const journal = await pc.executeCommand('journalctl -t auditd --no-pager');
    expect(journal).toContain('Terminating /sbin/audisp-syslog because its now inactive');
    expect(journal).toContain('After reconfigure, there are no active plugins, exiting');
    await pc.executeCommand(`sed -i 's/^active = no/active = yes/' ${SYSLOG_CONF}`);
    await pc.executeCommand('systemctl kill -s SIGHUP auditd');
    expect((await pc.executeCommand('pgrep -x audisp-syslog')).trim()).not.toBe('');
  });

  it('a plugin file that fails its checks is skipped with the reason', async () => {
    const pc = await rootHost();
    await pc.executeCommand(`sed -i 's/^active = no/active = yes/; s#^path = .*#path = /sbin/not-there#' ${SYSLOG_CONF}`);
    await pc.executeCommand('systemctl restart auditd');
    const journal = await pc.executeCommand('journalctl -t auditd --no-pager');
    expect(journal).toContain('Unable to stat /sbin/not-there (No such file or directory)');
    expect(journal).toContain('Skipping syslog.conf plugin due to errors');
  });

  it('audisp-af_unix creates its socket with the requested mode and removes it when it ends', async () => {
    const pc = await rootHost();
    await pc.executeCommand(`sed -i 's/^active = no/active = yes/; s#^args = .*#args = 0660 /var/run/audit_events#' /etc/audit/plugins.d/af_unix.conf`);
    await pc.executeCommand('systemctl restart auditd');
    expect((await pc.executeCommand('stat -c "%F %a" /var/run/audit_events')).trim()).toBe('socket 660');
    expect(await syslogLines(pc, 'audisp-af_unix plugin is listening for events')).toHaveLength(1);
    await pc.executeCommand('systemctl stop auditd');
    expect(await pc.executeCommand('ls /var/run/audit_events 2>&1')).toContain('No such file');
  });

  it('/var/run/auditd.state counts the plugins and the queue', async () => {
    const pc = await rootHost();
    await enable(pc);
    await pc.executeCommand('auditctl -m counted');
    await pc.executeCommand('systemctl kill -s SIGCONT auditd');
    const state = await pc.executeCommand('cat /var/run/auditd.state');
    expect(state).toContain('Number of active plugins = 1');
    expect(state).toContain('max plugin queue depth used = 1');
    expect(state).toContain('plugin queue size = 2000');
  });
});
