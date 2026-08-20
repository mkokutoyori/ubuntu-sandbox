/**
 * docs/PRD-Manquements.md §M4a — apache2 really listens.
 *
 * Measured before writing anything: `systemctl start apache2` made the
 * unit `active` and opened nothing. `ss -ltn` showed no `:80`, `curl
 * localhost` answered `Connection refused`, and the unit still claimed to
 * be running — the same "a fact displayed that nothing backs" pattern
 * `PRD-Nginx` closed for the other server.
 *
 * What is checked here is the whole chain rather than the command's
 * wording: the unit, the socket table, a real HTTP request over the real
 * TCP stack, the log files, and the conflict with nginx — in BOTH
 * directions, because the two servers share port 80 and each has to be
 * able to be the one that loses.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'WEB'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

async function startApache(srv: LinuxServer): Promise<string> {
  return srv.executeCommand('systemctl start apache2');
}

describe('§M4a — the unit and the socket agree', () => {
  it('systemctl start apache2 really opens port 80', async () => {
    const srv = machine();

    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:80\s/);

    const out = await startApache(srv);
    expect(out).not.toContain('failed');

    expect(await srv.executeCommand('systemctl is-active apache2')).toContain('active');
    expect(await srv.executeCommand('ss -ltn')).toMatch(/:80\s/);
  });

  it('the listener is named apache2 and not something else', async () => {
    const srv = machine();
    await startApache(srv);
    expect(await srv.executeCommand('ss -ltnp')).toContain('apache2');
  });

  it('systemctl stop closes the port instead of leaving it open', async () => {
    const srv = machine();
    await startApache(srv);
    expect(await srv.executeCommand('ss -ltn')).toMatch(/:80\s/);

    await srv.executeCommand('systemctl stop apache2');

    expect(await srv.executeCommand('systemctl is-active apache2')).not.toContain('\nactive');
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:80\s/);
  });
});

describe('§M4a — the server really serves', () => {
  it('curl localhost returns the Ubuntu default page', async () => {
    const srv = machine();
    await startApache(srv);

    const page = await srv.executeCommand('curl -sS http://127.0.0.1/');

    expect(page).toContain('Apache2 Ubuntu Default Page');
    expect(page).toContain('It works!');
  });

  it('the response identifies Apache rather than nginx', async () => {
    const srv = machine();
    await startApache(srv);

    expect(await srv.executeCommand('curl -sS -v http://127.0.0.1/'))
      .toMatch(/Server: Apache\/2\.4\.\d+ \(Ubuntu\)/);
  });

  it('a page dropped in the DocumentRoot is served', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "<h1>lab</h1>" > /var/www/html/lab.html'`);
    await startApache(srv);

    expect(await srv.executeCommand('curl -sS http://127.0.0.1/lab.html')).toContain('<h1>lab</h1>');
  });

  it('a missing file answers 404 with Apache\'s own page', async () => {
    const srv = machine();
    await startApache(srv);

    const out = await srv.executeCommand('curl -sS http://127.0.0.1/absent.html');

    expect(out).toContain('404 Not Found');
    expect(out).toContain('The requested URL /absent.html was not found on this server.');
  });

  it('a served request is written to access.log in the combined format', async () => {
    const srv = machine();
    await startApache(srv);
    await srv.executeCommand('curl -sS http://127.0.0.1/');

    const log = await srv.executeCommand('cat /var/log/apache2/access.log');

    // `CustomLog ${APACHE_LOG_DIR}/access.log combined` is only correct if
    // `envvars` was actually read: without the expansion the line would
    // land in a directory literally named `${APACHE_LOG_DIR}`.
    expect(log).toMatch(/"GET \/ HTTP\/1\.1" 200 \d+/);
  });
});

describe('§M4a — the configuration decides', () => {
  it('changing Listen and the VirtualHost moves the port for real', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "Listen 8080\\n" > /etc/apache2/ports.conf'`);
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:8080>\\n\\tDocumentRoot /var/www/html\\n</VirtualHost>\\n" `
      + `> /etc/apache2/sites-available/000-default.conf'`);

    await startApache(srv);

    const ports = await srv.executeCommand('ss -ltn');
    expect(ports).toMatch(/:8080\s/);
    expect(ports).not.toMatch(/:80\s/);
    expect(await srv.executeCommand('curl -sS http://127.0.0.1:8080/')).toContain('It works!');
  });

  it('removing the site link and reloading removes the site', async () => {
    const srv = machine();
    await startApache(srv);
    expect(await srv.executeCommand('curl -sS http://127.0.0.1/')).toContain('It works!');

    // `a2dissite` is only an `rm` of the link.
    await srv.executeCommand('rm /etc/apache2/sites-enabled/000-default.conf');
    await srv.executeCommand('systemctl reload apache2');

    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:80\s/);
  });

  it('a VirtualHost with no matching Listen is reported without blocking', async () => {
    const srv = machine();
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:8080>\\n\\tDocumentRoot /var/www/html\\n</VirtualHost>\\n" `
      + `> /etc/apache2/sites-available/other.conf'`);
    await srv.executeCommand(
      'ln -s ../sites-available/other.conf /etc/apache2/sites-enabled/other.conf');

    const test = await srv.executeCommand('apachectl configtest');

    expect(test).toContain('has no matching Listen directive');
    // It does not block: `Syntax OK` still comes, and the server starts.
    expect(test).toContain('Syntax OK');
    await startApache(srv);
    expect(await srv.executeCommand('ss -ltn')).toMatch(/:80\s/);
  });

  it('a malformed configuration refuses the start and says where', async () => {
    const srv = machine();
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:80>\\n\\tDocumentRoot /var/www/html\\n" `
      + `> /etc/apache2/sites-available/000-default.conf'`);

    expect(await srv.executeCommand('apachectl configtest'))
      .toContain('expected </VirtualHost> before end of file');
    await startApache(srv);
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:80\s/);
  });

  it('ServerName picks which vhost answers', async () => {
    const srv = machine();
    await srv.executeCommand('mkdir -p /var/www/site2');
    await srv.executeCommand(`sh -c 'printf "<h1>site2</h1>" > /var/www/site2/index.html'`);
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:80>\\n\\tServerName site2.lab\\n`
      + `\\tDocumentRoot /var/www/site2\\n</VirtualHost>\\n" `
      + `> /etc/apache2/sites-available/site2.conf'`);
    await srv.executeCommand(
      'ln -s ../sites-available/site2.conf /etc/apache2/sites-enabled/site2.conf');
    await startApache(srv);

    const named = await srv.executeCommand('curl -sS -H "Host: site2.lab" http://127.0.0.1/');
    const fallback = await srv.executeCommand('curl -sS http://127.0.0.1/');

    expect(named).toContain('site2');
    // With no Host match, Apache keeps the first vhost of the port —
    // `000-default` comes first in alphabetical order, which is why real
    // machines use numeric prefixes.
    expect(fallback).toContain('It works!');
  });
});

describe('§M4a — the port-80 conflict, in both directions', () => {
  it('nginx first: apache2 refuses to start and says why', async () => {
    const srv = machine();
    await srv.executeCommand('systemctl start nginx');
    expect(await srv.executeCommand('ss -ltn')).toMatch(/:80\s/);

    const out = await startApache(srv);

    expect(out).toContain('Address already in use');
    expect(out).toContain('AH00072: make_sock: could not bind to address 0.0.0.0:80');
    expect(await srv.executeCommand('systemctl is-active apache2')).not.toContain('\nactive');
    // nginx keeps serving: the loser is the one that arrived second.
    expect(await srv.executeCommand('curl -sS http://127.0.0.1/')).toContain('nginx');
  });

  it('apache2 first: nginx refuses, with nginx\'s own message', async () => {
    const srv = machine();
    await startApache(srv);

    const out = await srv.executeCommand('systemctl start nginx');

    expect(out).toContain('Address already in use');
    // nginx does not say `AH00072` — each server has its own wording, and
    // that is what the operator will search their log for.
    expect(out).not.toContain('AH00072');
    expect(await srv.executeCommand('curl -sS http://127.0.0.1/')).toContain('It works!');
  });

  it('the refusal is written to Apache\'s error.log', async () => {
    const srv = machine();
    await srv.executeCommand('systemctl start nginx');
    await startApache(srv);

    expect(await srv.executeCommand('cat /var/log/apache2/error.log'))
      .toContain('AH00072: make_sock: could not bind to address 0.0.0.0:80');
  });

  it('stopping nginx frees the port and apache2 then starts', async () => {
    const srv = machine();
    await srv.executeCommand('systemctl start nginx');
    await startApache(srv);
    expect(await srv.executeCommand('systemctl is-active apache2')).not.toContain('\nactive');

    await srv.executeCommand('systemctl stop nginx');
    await startApache(srv);

    expect(await srv.executeCommand('systemctl is-active apache2')).toContain('active');
    expect(await srv.executeCommand('curl -sS http://127.0.0.1/')).toContain('It works!');
  });
});
