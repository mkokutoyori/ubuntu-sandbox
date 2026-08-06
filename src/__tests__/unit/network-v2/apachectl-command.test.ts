/**
 * docs/PRD-Manquements.md §M4a — `apachectl` / `apache2ctl`.
 *
 * What is checked is that the command READS the machine rather than
 * reciting a fixed text: `-M` follows a link added or removed under
 * `mods-enabled/`, `-S` follows the vhosts on disk, `configtest` and the
 * daemon judge the same file the same way, and the lifecycle verbs move
 * the same service `systemctl` moves — a command that claimed to start a
 * server `systemctl status` still calls stopped would be worse than no
 * command at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'CTL'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

describe('§M4a — apachectl reports the build', () => {
  it('-v gives the version and the build date', async () => {
    const out = await machine().executeCommand('apachectl -v');
    expect(out).toMatch(/Server version: Apache\/2\.4\.\d+ \(Ubuntu\)/);
    expect(out).toContain('Server built:');
  });

  it('-V adds the MPM and the compile settings', async () => {
    const out = await machine().executeCommand('apachectl -V');
    expect(out).toContain('Server MPM:     event');
    expect(out).toContain('-D SERVER_CONFIG_FILE="apache2.conf"');
  });

  it('apache2ctl is the same command under its other name', async () => {
    const srv = machine();
    expect(await srv.executeCommand('apache2ctl -v'))
      .toBe(await srv.executeCommand('apachectl -v'));
  });

  it('-l lists what is compiled in, -M what is loaded', async () => {
    const srv = machine();
    expect(await srv.executeCommand('apachectl -l')).toContain('core.c');
    expect(await srv.executeCommand('apachectl -M')).toContain('core_module (static)');
  });
});

describe('§M4a — apachectl -M reads mods-enabled', () => {
  it('the default modules are listed as shared', async () => {
    const out = await machine().executeCommand('apachectl -M');
    expect(out).toContain('alias_module (shared)');
    expect(out).toContain('mpm_event_module (shared)');
  });

  it('a module link removed by hand disappears from the list', async () => {
    const srv = machine();
    expect(await srv.executeCommand('apachectl -M')).toContain('deflate_module (shared)');

    // `a2dismod` is only an `rm` of the `.load` file.
    await srv.executeCommand('rm /etc/apache2/mods-enabled/deflate.load');

    expect(await srv.executeCommand('apachectl -M')).not.toContain('deflate_module (shared)');
  });

  it('a module link added by hand appears in the list', async () => {
    const srv = machine();
    expect(await srv.executeCommand('apachectl -M')).not.toContain('rewrite_module');

    await srv.executeCommand(
      `sh -c 'printf "LoadModule rewrite_module /usr/lib/apache2/modules/mod_rewrite.so\\n" `
      + `> /etc/apache2/mods-enabled/rewrite.load'`);

    expect(await srv.executeCommand('apachectl -M')).toContain('rewrite_module (shared)');
  });
});

describe('§M4a — apachectl -S reads the vhosts', () => {
  it('the default vhost is shown with the file it comes from', async () => {
    const out = await machine().executeCommand('apachectl -S');
    expect(out).toContain('VirtualHost configuration:');
    expect(out).toContain('/etc/apache2/sites-enabled/000-default.conf:1');
    expect(out).toContain('Main DocumentRoot: "/var/www/html"');
  });

  it('two vhosts on one port make it a NameVirtualHost', async () => {
    const srv = machine();
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:80>\\n\\tServerName second.lab\\n`
      + `\\tDocumentRoot /var/www/html\\n</VirtualHost>\\n" `
      + `> /etc/apache2/sites-available/second.conf'`);
    await srv.executeCommand(
      'ln -s ../sites-available/second.conf /etc/apache2/sites-enabled/second.conf');

    const out = await srv.executeCommand('apachectl -S');

    expect(out).toContain('is a NameVirtualHost');
    expect(out).toContain('namevhost second.lab');
  });
});

describe('§M4a — configtest and the daemon judge alike', () => {
  it('a sound configuration answers Syntax OK', async () => {
    expect(await machine().executeCommand('apachectl configtest')).toContain('Syntax OK');
  });

  it('-t is the same test as configtest', async () => {
    const srv = machine();
    expect(await srv.executeCommand('apachectl -t'))
      .toBe(await srv.executeCommand('apachectl configtest'));
  });

  it('a configuration configtest refuses is a configuration the daemon refuses', async () => {
    const srv = machine();
    await srv.executeCommand('rm /etc/apache2/ports.conf');

    const test = await srv.executeCommand('apachectl configtest');
    const start = await srv.executeCommand('systemctl start apache2');

    // Two views, one verdict: a command saying "Syntax OK" about a file
    // `systemctl start` refuses would be worse than no command at all.
    expect(test).toContain('No such file or directory');
    expect(start).toContain('No such file or directory');
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:80\s/);
  });
});

describe('§M4a — apachectl drives the same service as systemctl', () => {
  it('apachectl start really opens the port and systemctl agrees', async () => {
    const srv = machine();

    await srv.executeCommand('apachectl start');

    expect(await srv.executeCommand('systemctl is-active apache2')).toContain('active');
    expect(await srv.executeCommand('ss -ltn')).toMatch(/:80\s/);
    expect(await srv.executeCommand('curl -sS http://127.0.0.1/')).toContain('It works!');
  });

  it('start on a running server says so instead of starting a second one', async () => {
    const srv = machine();
    await srv.executeCommand('apachectl start');

    expect(await srv.executeCommand('apachectl start')).toMatch(/already running/);
    expect(await srv.executeCommand('ss -ltn')).toMatch(/:80\s/);
  });

  it('apachectl stop closes the port, and stop again says it is not running', async () => {
    const srv = machine();
    await srv.executeCommand('apachectl start');

    await srv.executeCommand('apachectl stop');
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:80\s/);

    expect(await srv.executeCommand('apachectl stop')).toContain('not running');
  });

  it('graceful re-reads the configuration on a running server', async () => {
    const srv = machine();
    await srv.executeCommand('apachectl start');

    await srv.executeCommand('rm /etc/apache2/sites-enabled/000-default.conf');
    await srv.executeCommand('apachectl graceful');

    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:80\s/);
  });

  it('graceful refuses on a broken configuration rather than killing the server', async () => {
    const srv = machine();
    await srv.executeCommand('apachectl start');
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:80>\\n" > /etc/apache2/sites-available/000-default.conf'`);

    const out = await srv.executeCommand('apachectl graceful');

    expect(out).toContain('not reloading, configuration test failed');
    // The running server keeps serving: that is the whole point of testing
    // before reloading.
    expect(await srv.executeCommand('curl -sS http://127.0.0.1/')).toContain('It works!');
  });

  it('restart refuses on a broken configuration too', async () => {
    const srv = machine();
    await srv.executeCommand('apachectl start');
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:80>\\n" > /etc/apache2/sites-available/000-default.conf'`);

    expect(await srv.executeCommand('apachectl restart'))
      .toContain('not restarting, configuration test failed');
  });
});

describe('§M4a — apachectl refuses what it does not know', () => {
  it('status names the missing text browser rather than inventing a page', async () => {
    const out = await machine().executeCommand('apachectl status');
    expect(out).toContain('requires a text browser');
  });

  it('an unknown option is refused with apache2\'s own wording', async () => {
    expect(await machine().executeCommand('apachectl -z')).toContain("invalid option -- 'z'");
  });

  it('with no argument it prints its usage', async () => {
    expect(await machine().executeCommand('apachectl')).toContain('Usage: /usr/sbin/apachectl');
  });

  it('deleting the binary stops the command, like any binary', async () => {
    const srv = machine();
    expect(await srv.executeCommand('apachectl -v')).toContain('Server version');

    await srv.executeCommand('rm /usr/sbin/apachectl');

    expect(await srv.executeCommand('apachectl -v'))
      .toContain('/usr/sbin/apachectl: No such file or directory');
  });
});
