/**
 * Fichiers de /etc/audit/plugins.d, port de load_pconfig() (audit 3.1.2, audisp/audispd-pconfig.c). Le demon reel
 * n'a pas ete lance ici : l'oracle est le source, chaque message est celui de l'appel audit_msg() correspondant.
 *
 * Mesure avant : le dossier plugins.d n'existait pas dans le simulateur et rien ne lisait ces fichiers ; les 12
 * cas tombent (le module n'existait pas). Le temoin (les deux fichiers livres par le paquet se chargent sans
 * message, inactifs) ne peut pas diverger d'une implementation correcte et borne les cas de refus.
 */
import { describe, it, expect } from 'vitest';
import { loadPluginConfig } from '@/network/devices/linux/audit/daemon/dispatch/AudispPluginConfig';
import { SHIPPED_AUDISP_AF_UNIX_CONF, SHIPPED_AUDISP_SYSLOG_CONF } from '@/network/devices/linux/audit/daemon/AudispConfFiles';
import type { FileInfo } from '@/network/devices/linux/audit/daemon/AuditdConfig';
import { fsOf, lab } from './_helpers/auditdConfigWorld';

const FILE = '/etc/audit/plugins.d/x.conf';
const PROGRAM = '/sbin/audisp-syslog';

const load = (conf: string, program: FileInfo | null = { kind: 'file', ino: 77, uid: 0, gid: 0, mode: 0o755 }, file = FILE) => {
  const world = lab('');
  world.files.set(file, { info: { kind: 'file', uid: 0, gid: 0, mode: 0o640 }, content: conf });
  if (program !== null) world.files.set(PROGRAM, { info: program });
  world.dirs.add('/etc/audit/plugins.d');
  return loadPluginConfig(fsOf(world), file);
};
const texts = (conf: string, program?: FileInfo | null) => load(conf, program).messages.map((m) => m.text);

describe('audisp plugin configuration, auditd 3.1.2 load_pconfig()', () => {
  it('witness: the two files shipped by the package load, inactive, with no message', () => {
    for (const content of [SHIPPED_AUDISP_SYSLOG_CONF, SHIPPED_AUDISP_AF_UNIX_CONF]) {
      const result = load(content);
      expect(result.rc).toBe(0);
      expect(result.messages).toEqual([]);
      expect(result.config.active).toBe(false);
    }
    expect(load(SHIPPED_AUDISP_SYSLOG_CONF).config).toMatchObject({ direction: 'out', path: '/sbin/audisp-syslog', type: 'ALWAYS', args: ['LOG_INFO'], format: 'string', name: 'x.conf' });
    expect(load(SHIPPED_AUDISP_AF_UNIX_CONF).config.args).toEqual(['0640', '/var/run/audispd_events']);
  });

  it('an active plugin records the inode of its program', () => {
    const result = load('active = yes\ndirection = out\npath = /sbin/audisp-syslog\ntype = always\nargs = LOG_INFO\nformat = string\n');
    expect(result.rc).toBe(0);
    expect(result.config).toMatchObject({ active: true, inode: 77 });
  });

  it('an unknown keyword stops the load', () => {
    expect(texts('mode = fast\n')).toEqual(['Unknown keyword "mode" in line 1 of /etc/audit/plugins.d/x.conf']);
  });

  it('a name with no value stops the load without a second message', () => {
    expect(texts('active\n')).toEqual(['Wrong number of arguments for line 1 in /etc/audit/plugins.d/x.conf']);
  });

  it('an option on a keyword that takes none is refused; args takes up to two values', () => {
    expect(texts('active = yes extra\n')).toEqual(['Keyword "active" has invalid option "extra" in line 1 of /etc/audit/plugins.d/x.conf']);
    expect(load('args = LOG_INFO interpret\n').config.args).toEqual(['LOG_INFO', 'interpret']);
  });

  it('direction only knows out; type only knows always; builtin is obsolete; format knows binary and string', () => {
    expect(texts('direction = in\n')).toEqual(['Option in not found - line 1']);
    expect(texts('type = sometimes\n')).toEqual(['Option sometimes not found - line 1']);
    expect(texts('type = builtin\n')).toEqual(['Option builtin line 1 is obsolete - update it']);
    expect(texts('format = xml\n')).toEqual(['Option xml not found - line 1']);
    expect(load('format = binary\n').config.format).toBe('binary');
  });

  it('a builtin_ path is replaced by the af_unix plugin with a warning', () => {
    const result = load('path = builtin_af_unix\n');
    expect(result.messages.map((m) => m.text)).toEqual(['Option builtin_af_unix line 1 is obsolete - using /sbin/audisp-af_unix']);
    expect(result.config.path).toBe('/sbin/audisp-af_unix');
  });

  it('a path whose directory is shorter than four characters is refused', () => {
    expect(texts('path = /a/b\n')).toEqual(['The directory name: /a is too short - line 1']);
  });

  it('an active plugin needs a path', () => {
    expect(texts('active = yes\n')).toEqual(['Error - plugin (/etc/audit/plugins.d/x.conf) is active but no path given']);
  });

  it('an active plugin needs a root-owned regular program executable by its owner and group', () => {
    const active = 'active = yes\npath = /sbin/audisp-syslog\n';
    expect(texts(active, null)).toEqual(['Unable to stat /sbin/audisp-syslog (No such file or directory)']);
    expect(texts(active, { kind: 'directory', uid: 0, gid: 0, mode: 0o755 })).toEqual(['/sbin/audisp-syslog is not a regular file']);
    expect(texts(active, { kind: 'file', uid: 1000, gid: 0, mode: 0o755 })).toEqual(['/sbin/audisp-syslog is not owned by root']);
    expect(texts(active, { kind: 'file', uid: 0, gid: 0, mode: 0o700 })).toEqual(['/sbin/audisp-syslog permissions should be 0750']);
  });

  it('an inactive plugin is not checked against its program', () => {
    expect(load('active = no\npath = /sbin/audisp-syslog\n', null).rc).toBe(0);
  });

  it('the file must be owned by root and not world writable', () => {
    const world = lab('');
    world.files.set(FILE, { info: { kind: 'file', uid: 1000, gid: 0, mode: 0o640 }, content: '' });
    expect(loadPluginConfig(fsOf(world), FILE).messages[0].text).toBe("Error - /etc/audit/plugins.d/x.conf isn't owned by root");
    world.files.set(FILE, { info: { kind: 'file', uid: 0, gid: 0, mode: 0o666 }, content: '' });
    expect(loadPluginConfig(fsOf(world), FILE).messages[0].text).toBe('Error - /etc/audit/plugins.d/x.conf is world writable');
  });
});
