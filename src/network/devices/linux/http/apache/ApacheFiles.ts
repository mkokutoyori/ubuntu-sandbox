/**
 * docs/PRD-Manquements.md §M4a — apache2's files, the ones Debian ships.
 *
 * `systemctl start apache2` used to make the unit `active` while nothing
 * listened: `ss` showed no port and `curl localhost` was refused. The unit
 * existed, the server did not.
 *
 * The file layout is Debian's rather than upstream's, because Debian's is
 * the one the learner sees and edits: `ports.conf` carries the `Listen`,
 * `sites-available/000-default.conf` the VirtualHost, and `sites-enabled/`
 * is nothing but a directory of links — same as nginx, and for the same
 * reason: `a2ensite` is only an `ln -s`, so `ln -s` has to be enough.
 */

export const APACHE_BINARY = '/usr/sbin/apache2';
export const APACHE_CTL = '/usr/sbin/apachectl';
export const APACHE_VERSION = '2.4.52';
export const APACHE_CONF_PATH = '/etc/apache2/apache2.conf';
export const APACHE_PORTS_PATH = '/etc/apache2/ports.conf';
export const APACHE_SITES_AVAILABLE = '/etc/apache2/sites-available';
export const APACHE_SITES_ENABLED = '/etc/apache2/sites-enabled';
export const APACHE_MODS_ENABLED = '/etc/apache2/mods-enabled';
export const APACHE_ACCESS_LOG = '/var/log/apache2/access.log';
export const APACHE_ERROR_LOG = '/var/log/apache2/error.log';
export const APACHE_DOCROOT = '/var/www/html';
export const APACHE_ENVVARS_PATH = '/etc/apache2/envvars';

/**
 * `envvars` is Apache's Debian-specific quirk, and it is not decorative:
 * the shipped configuration writes `${APACHE_LOG_DIR}` everywhere, so
 * without this file `CustomLog ${APACHE_LOG_DIR}/access.log` names a
 * directory literally called `${APACHE_LOG_DIR}`. It is also what makes
 * `apache2` fail when started by hand on a real machine — only `apachectl`
 * sources it before running the server.
 */
export const APACHE_ENVVARS = `# envvars - default environment variables for apache2ctl
export APACHE_RUN_USER=www-data
export APACHE_RUN_GROUP=www-data
export APACHE_PID_FILE=/var/run/apache2/apache2\$SUFFIX.pid
export APACHE_RUN_DIR=/var/run/apache2\$SUFFIX
export APACHE_LOCK_DIR=/var/lock/apache2\$SUFFIX
export APACHE_LOG_DIR=/var/log/apache2\$SUFFIX
`;

export const APACHE_CONF = `# This is the main Apache server configuration file.
ServerRoot "/etc/apache2"
Mutex file:\${APACHE_LOCK_DIR} default
PidFile \${APACHE_PID_FILE}
Timeout 300
KeepAlive On
MaxKeepAliveRequests 100
KeepAliveTimeout 5

User \${APACHE_RUN_USER}
Group \${APACHE_RUN_GROUP}
HostnameLookups Off

ErrorLog \${APACHE_LOG_DIR}/error.log
LogLevel warn

IncludeOptional mods-enabled/*.load
IncludeOptional mods-enabled/*.conf
Include ports.conf

<Directory />
\tOptions FollowSymLinks
\tAllowOverride None
\tRequire all denied
</Directory>

<Directory /var/www/>
\tOptions Indexes FollowSymLinks
\tAllowOverride None
\tRequire all granted
</Directory>

AccessFileName .htaccess

IncludeOptional conf-enabled/*.conf
IncludeOptional sites-enabled/*.conf
`;

export const APACHE_PORTS_CONF = `# If you just change the port or add more ports here, you will likely also
# have to change the VirtualHost statement in
# /etc/apache2/sites-enabled/000-default.conf

Listen 80

<IfModule ssl_module>
\tListen 443
</IfModule>

<IfModule mod_gnutls.c>
\tListen 443
</IfModule>
`;

/**
 * The modules Debian enables at install time, one `.load` file per module
 * under `mods-enabled/`. They are laid down so `apachectl -M` has
 * something to READ instead of a list hard-coded in the command: `a2enmod`
 * is only an `ln -s` and `a2dismod` only an `rm`, so both have to show up
 * in `-M` without any command knowing about it.
 */
export const APACHE_DEFAULT_MODULES: readonly string[] = [
  'access_compat', 'alias', 'auth_basic', 'authn_core', 'authn_file',
  'authz_core', 'authz_host', 'authz_user', 'autoindex', 'deflate',
  'dir', 'env', 'filter', 'mime', 'mpm_event', 'negotiation',
  'reqtimeout', 'setenvif', 'status',
];

export function apacheModuleLoadFile(name: string): string {
  return `LoadModule ${name}_module /usr/lib/apache2/modules/mod_${name}.so\n`;
}

/** What `apachectl -l` lists: what is linked into the binary. */
export const APACHE_STATIC_MODULES: readonly string[] = [
  'core.c', 'mod_so.c', 'mod_watchdog.c', 'http_core.c',
  'mod_log_config.c', 'mod_logio.c', 'mod_version.c', 'mod_unixd.c',
];

export const APACHE_BUILD_DATE = '2023-10-26T13:44:44';

export const APACHE_DEFAULT_SITE = `<VirtualHost *:80>
\tServerAdmin webmaster@localhost
\tDocumentRoot /var/www/html

\tErrorLog \${APACHE_LOG_DIR}/error.log
\tCustomLog \${APACHE_LOG_DIR}/access.log combined
</VirtualHost>
`;

/** The "Apache2 Ubuntu Default Page", trimmed to what actually reads. */
export const APACHE_DEFAULT_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Apache2 Ubuntu Default Page: It works</title>
  </head>
  <body>
    <div class="page_header floating_element">
      <span class="floating_element">
        Apache2 Ubuntu Default Page
      </span>
    </div>
    <div class="main_page">
      <h1>It works!</h1>
      <p>
        This is the default welcome page used to test the correct
        operation of the Apache2 server after installation on Ubuntu
        systems.
      </p>
    </div>
  </body>
</html>
`;

export function apacheNotFoundPage(target: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head>
<title>404 Not Found</title>
</head><body>
<h1>Not Found</h1>
<p>The requested URL ${target} was not found on this server.</p>
<hr>
<address>Apache/${APACHE_VERSION} (Ubuntu) Server</address>
</body></html>
`;
}

export function apacheForbiddenPage(target: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head>
<title>403 Forbidden</title>
</head><body>
<h1>Forbidden</h1>
<p>You don't have permission to access ${target} on this server.</p>
<hr>
<address>Apache/${APACHE_VERSION} (Ubuntu) Server</address>
</body></html>
`;
}
