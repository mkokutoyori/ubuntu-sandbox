/**
 * auditd.conf, porte de load_config() et de ses analyseurs (audit 3.1.2, src/auditd-config.c), construction
 * Ubuntu (strings du binaire du paquet : pas de listener TCP, pas de GSSAPI, donc tcp_* et krb5_* acceptes sans
 * controle). Le demon reel n'a pas ete lance ici : l'oracle est le texte du source, lu fonction par fonction ;
 * chaque message ci-dessous est celui de l'appel audit_msg() correspondant.
 *
 * Mesure avant : trois lecteurs de ce fichier coexistaient (LinuxAuditRules.validateAuditdConfig, le chargeur du
 * demon, parseAuditdConf des outils) et acceptaient ou refusaient autrement que auditd : `backlog_limit`,
 * `rate_limit` y etaient valides alors que 3.1.2 repond « Unknown keyword », `max_log_file = 0` y etait refuse
 * alors que auditd l'accepte, `num_logs = 1000` y etait accepte alors que auditd le refuse. Les 25 cas tombent
 * avant (le module n'existait pas) ; le temoin « le fichier livre se charge sans message » ne peut pas diverger
 * d'une implementation correcte, il borne les cas de refus.
 */
import { describe, it, expect } from 'vitest';
import { loadAuditdConfig, type FileInfo } from '@/network/devices/linux/audit/daemon/AuditdConfig';
import { SHIPPED_AUDITD_CONF } from '@/network/devices/linux/audit/daemon/AuditdConfFile';
import { CONF, fsOf, lab, type Lab } from './_helpers/auditdConfigWorld';

const load = (conf: string, extra: Partial<Lab> = {}) =>
  loadAuditdConfig(fsOf(lab(conf, extra)), { configFile: CONF, allowLinks: false });
const texts = (conf: string, extra: Partial<Lab> = {}) => load(conf, extra).messages.map((m) => m.text);

describe('auditd.conf, auditd 3.1.2 load_config()', () => {
  it('witness: the file the Ubuntu package ships loads with rc 0 and no message', () => {
    const result = load(SHIPPED_AUDITD_CONF);
    expect(result.rc).toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.config).toMatchObject({
      logFile: '/var/log/audit/audit.log', logGroup: 4, logFormat: 'ENRICHED', flush: 'INCREMENTAL_ASYNC', freq: 50,
      maxLogSize: 8, numLogs: 5, maxLogSizeAction: 'ROTATE', spaceLeft: 75, adminSpaceLeft: 50, diskFullAction: 'SUSPEND',
      diskErrorAction: 'SUSPEND', qDepth: 2000, pluginDir: '/etc/audit/plugins.d/', endOfEventTimeout: 2,
    });
  });

  it('an unknown keyword stops the load, naming the keyword, the line and the file', () => {
    const result = load('log_group = adm\nbacklog_limit = 64\n');
    expect(result.rc).toBe(1);
    expect(result.messages.map((m) => m.text)).toEqual(['Unknown keyword "backlog_limit" in line 2 of /etc/audit/auditd.conf']);
  });

  it('keywords are matched without regard to case', () => {
    expect(load('FLUSH = none\nSpace_Left = 75\nAdmin_Space_Left = 50\n').rc).toBe(0);
  });

  it('a missing equal sign is reported, then the load stops', () => {
    expect(texts('log_format ENRICHED extra\n')).toEqual([
      'Missing equal sign for line 1 in /etc/audit/auditd.conf', 'Not processing any more lines in /etc/audit/auditd.conf',
    ]);
  });

  it('a name with no value is a wrong number of arguments, then the load stops', () => {
    expect(texts('freq\n')).toEqual([
      'Wrong number of arguments for line 1 in /etc/audit/auditd.conf', 'Not processing any more lines in /etc/audit/auditd.conf',
    ]);
  });

  it('tokens are split on spaces only: a tab-separated line is one token', () => {
    expect(texts('log_group\t=\tadm\n')).toEqual([
      'Wrong number of arguments for line 1 in /etc/audit/auditd.conf', 'Not processing any more lines in /etc/audit/auditd.conf',
    ]);
  });

  it('an option on a keyword that takes none is refused', () => {
    expect(texts('flush = none extra\n')).toEqual(['Keyword "flush" has invalid option "extra" in line 1 of /etc/audit/auditd.conf']);
  });

  it('num_logs: digits only, 999 at most', () => {
    expect(texts('num_logs = abc\n')).toEqual(['Value abc should only be numbers - line 1']);
    expect(texts('num_logs = 1000\n')).toEqual(['num_logs must be 999 or less']);
    expect(load('num_logs = 0\nspace_left = 75\nadmin_space_left = 50\n').config.numLogs).toBe(0);
  });

  it('max_log_file = 0 is accepted: auditd only requires digits', () => {
    const result = load('max_log_file = 0\nspace_left = 75\nadmin_space_left = 50\n');
    expect(result.rc).toBe(0);
    expect(result.config.maxLogSize).toBe(0);
  });

  it('a number past unsigned long is reported as a conversion error', () => {
    expect(texts('max_log_file = 99999999999999999999999\n')).toEqual(['Error converting string to a number (Numerical result out of range) - line 1']);
  });

  it('space_left must exceed admin_space_left once the file has a line', () => {
    expect(texts('space_left = 50\nadmin_space_left = 50\n')).toEqual(['Error - space_left(50) must be larger than admin_space_left(50)']);
    expect(texts('flush = none\n')).toEqual(['Error - space_left(0) must be larger than admin_space_left(0)']);
    expect(load('').rc).toBe(0);
  });

  it('percentages are kept apart from megabytes and bounded below 100', () => {
    const ok = load('space_left = 10%\nadmin_space_left = 5%\n').config;
    expect(ok).toMatchObject({ spaceLeft: 0, spaceLeftPercent: 10, adminSpaceLeft: 0, adminSpaceLeftPercent: 5 });
    expect(texts('space_left = 150%\n')).toEqual(['Percentages should be less than 100 - line 1']);
    expect(texts('space_left = 1x\n')).toEqual(['Value x 1x should only be numbers or percent - line 1']);
  });

  it('incremental flushing needs a frequency', () => {
    expect(texts('flush = incremental\nspace_left = 75\nadmin_space_left = 50\n')).toEqual(['Error - incremental flushing chosen, but 0 selected for freq']);
    expect(texts('flush = data\nfreq = 20\nspace_left = 75\nadmin_space_left = 50\n')).toEqual(['Warning - freq is non-zero and incremental flushing not selected.']);
  });

  it('log_group: numeric, known name, or refused with the message that ends in a newline', () => {
    expect(load('log_group = 4\nspace_left = 75\nadmin_space_left = 50\n').config.logGroup).toBe(4);
    expect(texts('log_group = nobody\n')).toEqual(['Group ID is non-numeric and unknown (nobody) - line 1\n']);
  });

  it('a group-owned log may not sit directly in /var/log', () => {
    expect(texts('log_group = adm\nlog_file = /var/log/audit.log\nspace_left = 75\nadmin_space_left = 50\n')).toEqual([
      "Error - log_file is directly in /var/log and chgrp will alter a system directory's permissions. Use another directory.",
    ]);
  });

  it('log_file: short directory, missing directory, non-regular, not root, permissions', () => {
    expect(texts('log_file = /a/b\n')).toEqual(['The directory name: /a is too short - line 1']);
    expect(texts('log_file = /var/nodir/audit.log\n')).toEqual(['Could not open dir /var/nodir (No such file or directory)']);
    const existing = (info: FileInfo) => ({ files: new Map([['/var/log/audit/audit.log', { info }]]) });
    expect(texts('log_file = /var/log/audit/audit.log\n', existing({ kind: 'directory', uid: 0, gid: 0, mode: 0o700 }))).toEqual(['/var/log/audit/audit.log is not a regular file']);
    expect(texts('log_file = /var/log/audit/audit.log\n', existing({ kind: 'file', uid: 1000, gid: 0, mode: 0o600 }))).toEqual(['/var/log/audit/audit.log is not owned by root']);
    expect(load('log_file = /var/log/audit/audit.log\nspace_left = 75\nadmin_space_left = 50\n', existing({ kind: 'file', uid: 0, gid: 0, mode: 0o644 })).messages.map((m) => m.text))
      .toEqual(['/var/log/audit/audit.log permissions should be 0600 or 0640']);
  });

  it('disk_full_action refuses email; disk_error_action refuses email and rotate', () => {
    expect(texts('disk_full_action = email\n')).toEqual(['Illegal option email for disk_full_action - line 1']);
    expect(texts('disk_error_action = rotate\n')).toEqual(['Illegal option rotate for disk_error_action - line 1']);
    expect(texts('disk_error_action = nothing\n')).toEqual(['Option nothing not found - line 1']);
  });

  it('an exec action needs an absolute path to a root-owned executable of the right mode', () => {
    expect(texts('space_left_action = exec\n')).toEqual(['Executable path needed for line 1']);
    expect(texts('space_left_action = exec relative.sh\n')).toEqual(['Absolute path needed for relative.sh - line 1']);
    expect(texts('space_left_action = exec /usr/local/bin/missing\n')).toEqual(['Unable to stat /usr/local/bin/missing (No such file or directory) - line 1']);
    const script = (mode: number) => ({ files: new Map([['/usr/local/bin/alert', { info: { kind: 'file' as const, uid: 0, gid: 0, mode } }]]) });
    expect(texts('space_left_action = exec /usr/local/bin/alert\n', script(0o777))).toEqual(['/usr/local/bin/alert permissions should be 0750, 0755, 0555 or 0550 - line 1']);
    const good = load('space_left = 75\nadmin_space_left = 50\nspace_left_action = exec /usr/local/bin/alert\n', script(0o750));
    expect(good.rc).toBe(0);
    expect(good.config).toMatchObject({ spaceLeftAction: 'EXEC', spaceLeftExe: '/usr/local/bin/alert' });
  });

  it('the Ubuntu build has no listener: tcp_* and krb5_* values are accepted unchecked', () => {
    const conf = 'tcp_listen_port = abc\ntcp_max_per_addr = 99999\ntcp_client_ports = 5-1\nkrb5_principal = x\nspace_left = 75\nadmin_space_left = 50\n';
    expect(load(conf).rc).toBe(0);
  });

  it('transport only knows tcp', () => {
    expect(texts('transport = krb5\n')).toEqual(['Option krb5 not found - line 1']);
  });

  it('log_format = nolog warns twice and turns write_logs off', () => {
    const result = load('log_format = nolog\nspace_left = 75\nadmin_space_left = 50\n');
    expect(result.messages.map((m) => m.text)).toEqual([
      'The NOLOG option to log_format is deprecated. Please use the write_logs option.',
      'The NOLOG option is overriding the write_logs current setting.',
    ]);
    expect(result.config.writeLogs).toBe(false);
  });

  it('q_depth below 512 warns, above 99999 is refused; plugin_dir gains its trailing slash', () => {
    expect(load('q_depth = 100\nspace_left = 75\nadmin_space_left = 50\n').messages.map((m) => m.text)).toEqual(['q_depth should be larger than 512 for safety margin']);
    expect(texts('q_depth = 100000\n')).toEqual(['q_depth must be 99999 or less']);
    expect(load('plugin_dir = /opt/plugins\nspace_left = 75\nadmin_space_left = 50\n').config.pluginDir).toBe('/opt/plugins/');
  });

  it('deprecated keywords warn and are otherwise ignored', () => {
    const result = load('dispatcher = /sbin/audispd\ndisp_qos = lossy\nspace_left = 75\nadmin_space_left = 50\n');
    expect(result.rc).toBe(0);
    expect(result.messages.map((m) => m.text)).toEqual(['The dispatcher option is deprecated - line 1', 'The disp_qos option is deprecated - line 2']);
  });

  it('a line of 160 characters is skipped, and so is a last line with no newline', () => {
    const long = `# ${'x'.repeat(170)}\n`;
    expect(texts(`space_left = 75\nadmin_space_left = 50\n${long}freq = 1`)).toEqual([
      'Skipping line 3 in /etc/audit/auditd.conf: too long', 'Skipping line 4 in /etc/audit/auditd.conf: too long',
    ]);
  });

  it('the file must exist, belong to root, not be world writable, be regular and not a link', () => {
    const absent = loadAuditdConfig(fsOf({ ...lab(''), files: new Map() }), { configFile: CONF, allowLinks: false });
    expect(absent.rc).toBe(0);
    expect(absent.messages.map((m) => m.text)).toEqual(["Config file /etc/audit/auditd.conf doesn't exist, skipping"]);
    const asUser = (info: FileInfo) => loadAuditdConfig(fsOf(lab('', { files: new Map([[CONF, { info, content: '' }]]) })), { configFile: CONF, allowLinks: false });
    expect(asUser({ kind: 'file', uid: 1000, gid: 0, mode: 0o640 }).messages[0].text).toBe("Error - /etc/audit/auditd.conf isn't owned by root");
    expect(asUser({ kind: 'file', uid: 0, gid: 0, mode: 0o666 }).messages[0].text).toBe('Error - /etc/audit/auditd.conf is world writable');
    expect(asUser({ kind: 'directory', uid: 0, gid: 0, mode: 0o750 }).messages[0].text).toBe('Error - /etc/audit/auditd.conf is not a regular file');
    expect(asUser({ kind: 'symlink', uid: 0, gid: 0, mode: 0o777 }).messages[0].text).toBe('Error opening config file (Too many levels of symbolic links)');
  });

  it('action_mail_acct is checked unless verify_email is off', () => {
    expect(texts('action_mail_acct = a\n')).toEqual(['email: a is too short, expecting at least 2 characters']);
    expect(texts('action_mail_acct = a!b\n')).toEqual(['email: a!b has illegal character']);
    expect(texts('action_mail_acct = root@example\n')).toEqual(['email: root@example should have . after @']);
    expect(load('verify_email = no\naction_mail_acct = a\nspace_left = 75\nadmin_space_left = 50\n').rc).toBe(0);
  });
});
