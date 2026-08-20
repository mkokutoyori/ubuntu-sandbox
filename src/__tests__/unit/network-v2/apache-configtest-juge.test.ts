/**
 * `apachectl configtest` juge enfin, et il juge comme Apache : par les
 * MODULES.
 *
 * Mesure de départ : `Syntax OK` pour tout, y compris `Zorglub on`,
 * `ProxyPass` et `Protocols h2`. Le jumeau exact du défaut que
 * `PRD-Nginx.md` §P2 avait corrigé côté nginx — le parseur finissait par
 * `default: break; // the rest of the grammar is read and ignored`.
 *
 * La forme du contrôle n'est pas une liste de mots interdits, et c'est
 * le point : Apache ne dit jamais « directive inconnue », il dit
 * « *Invalid command 'X', perhaps misspelled **or defined by a module
 * not included in the server configuration*** ». Son propre message
 * reconnaît qu'il ne sait pas distinguer une faute de frappe d'un module
 * éteint, parce que sa grammaire est définie par les modules chargés.
 * Refuser `ProxyPass` en dur dirait donc quelque chose de faux : ce qui
 * cloche n'est pas la directive, c'est que `mod_proxy` est éteint — et
 * `a2enmod proxy` est la réponse.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

const SITE = '/etc/apache2/sites-available/000-default.conf';

let srv: LinuxServer;

beforeEach(() => {
  srv = new LinuxServer('linux-server', 'SRV');
  srv.powerOn();
});

function ecrire(chemin: string, texte: string): string {
  const e = texte.replace(/\n/g, '\\n').replace(/"/g, '\\"').replace(/\$/g, '\\$');
  return `sh -c 'printf "${e}" > ${chemin}'`;
}

/** Un hôte virtuel minimal, plus les lignes qu'on veut juger. */
async function vhost(corps: string): Promise<string> {
  await srv.executeCommand(ecrire(SITE,
    `<VirtualHost *:80>\n  DocumentRoot /var/www/html\n${corps}</VirtualHost>\n`));
  return srv.executeCommand('apachectl configtest');
}

describe('configtest — ce qui doit passer continue de passer', () => {
  it('la configuration livrée par Debian est valide', async () => {
    // Le garde-fou du lot : un contrôle qui refuserait le fichier que la
    // distribution installe coûterait plus de vérité qu'il n'en apporte.
    expect(await srv.executeCommand('apachectl configtest')).toContain('Syntax OK');
  });

  it('les directives descriptives sont acceptées', async () => {
    const out = await vhost(
      '  ServerAdmin webmaster@localhost\n  ServerName lab.local\n'
      + '  ErrorLog /var/log/apache2/error.log\n  LogLevel warn\n'
      + '  DirectoryIndex index.html\n  Options Indexes FollowSymLinks\n'
      + '  AllowOverride None\n  Require all granted\n');
    expect(out).toContain('Syntax OK');
  });
});

describe('configtest — une directive qui n\'existe pas', () => {
  it('reçoit le message d\'Apache, avec la ligne et le fichier', async () => {
    const out = await vhost('  Zorglub on\n');
    expect(out).toContain("Invalid command 'Zorglub'");
    expect(out).toContain('perhaps misspelled or defined by a module not included');
    expect(out).toContain('/etc/apache2/sites-enabled/000-default.conf');
    expect(out).toContain('line 3');
    expect(out).not.toContain('Syntax OK');
  });

  it('le vrai `configtest` dit aussi que l\'action a échoué', async () => {
    const out = await vhost('  Zorglub on\n');
    expect(out).toContain("Action 'configtest' failed.");
    expect(out).toContain('The Apache error log may have more information.');
  });

  it('elle empêche le démarrage du service', async () => {
    await vhost('  Zorglub on\n');
    await srv.executeCommand('systemctl start apache2');
    expect(await srv.executeCommand('ss -ltn')).not.toContain(':80 ');
  });
});

describe('configtest — le module décide, et c\'est la leçon', () => {
  it('`ProxyPass` avec mod_proxy ÉTEINT : c\'est le module qui manque', async () => {
    // Et le message le dit, sans nommer le simulateur : sur un vrai
    // Debian la réponse est exactement celle-là.
    const out = await vhost('  ProxyPass / http://10.0.0.2:8080/\n');
    expect(out).toContain("Invalid command 'ProxyPass'");
    expect(out).toContain('not included in the server configuration');
    expect(out).not.toContain('not supported by this simulator');
  });

  it('`ProxyPass` avec mod_proxy ALLUMÉ : c\'est le simulateur qui manque', async () => {
    await srv.executeCommand('a2enmod proxy');
    const out = await vhost('  ProxyPass / http://10.0.0.2:8080/\n');
    // La directive existe désormais pour ce serveur ; ce qu'il n'a pas,
    // c'est de quoi la produire. Deux manques différents, deux messages.
    expect(out).toContain("the 'ProxyPass' directive is not supported by this simulator");
    expect(out).not.toContain('Invalid command');
  });

  it('`RewriteEngine` suit exactement la même règle', async () => {
    expect(await vhost('  RewriteEngine On\n')).toContain("Invalid command 'RewriteEngine'");
    await srv.executeCommand('a2enmod rewrite');
    expect(await vhost('  RewriteEngine On\n'))
      .toContain("the 'RewriteEngine' directive is not supported by this simulator");
  });

  it('`Header` demande mod_headers, qui est livré éteint', async () => {
    expect(await vhost('  Header set X-Test yes\n')).toContain("Invalid command 'Header'");
    await srv.executeCommand('a2enmod headers');
    expect(await vhost('  Header set X-Test yes\n')).toContain('not supported by this simulator');
  });

  it('`SSLEngine` sans mod_ssl est refusée comme sur un vrai Debian', async () => {
    expect(await vhost('  SSLEngine on\n')).toContain("Invalid command 'SSLEngine'");
  });

  it('`SSLEngine` avec mod_ssl est APPLIQUÉE, pas seulement acceptée', async () => {
    await srv.executeCommand('a2enmod ssl');
    // Elle passe le contrôle de grammaire et échoue plus loin, sur le
    // certificat : la preuve qu'elle est lue et non tolérée.
    const out = await vhost('  SSLEngine on\n');
    expect(out).not.toContain('Invalid command');
    expect(out).toContain('AH02572');
  });
});

describe('`<IfModule>` est honoré, et c\'est ce qui fait le TP TLS', () => {
  it('`a2ensite default-ssl` sans `a2enmod ssl` passe, et ne sert RIEN sur 443', async () => {
    await srv.executeCommand('a2ensite default-ssl');
    // Le fichier de Debian est enveloppé dans `<IfModule mod_ssl.c>` :
    // Apache saute le bloc, donc aucune erreur — et aucun port. C'est la
    // confusion classique, et elle doit être reproduite plutôt
    // qu'évitée.
    expect(await srv.executeCommand('apachectl configtest')).toContain('Syntax OK');
    expect(await srv.executeCommand('apachectl -S')).not.toContain('*:443');

    await srv.executeCommand('systemctl start apache2');
    expect(await srv.executeCommand('ss -ltn')).not.toContain(':443');
  });

  it('après `a2enmod ssl`, le bloc est lu et bute sur le certificat absent', async () => {
    await srv.executeCommand('a2ensite default-ssl');
    await srv.executeCommand('a2enmod ssl');
    // La vraie première marche du TP : Debian nomme un certificat
    // « snakeoil » que cette image ne fabrique pas.
    const out = await srv.executeCommand('apachectl configtest');
    expect(out).toContain('ssl-cert-snakeoil.pem');
    expect(out).not.toContain('Syntax OK');
  });

  it('`<IfModule !mod_ssl.c>` fait l\'inverse', async () => {
    await srv.executeCommand(ecrire(SITE,
      '<IfModule !mod_ssl.c>\n<VirtualHost *:8081>\n  DocumentRoot /var/www/html\n'
      + '</VirtualHost>\n</IfModule>\n'));
    // mod_ssl éteint → la négation est vraie → le bloc est LU.
    expect(await srv.executeCommand('apachectl -S')).toContain('*:8081');
    await srv.executeCommand('a2enmod ssl');
    expect(await srv.executeCommand('apachectl -S')).not.toContain('*:8081');
  });

  it('un bloc sauté ne fait pas juger ses directives', async () => {
    await srv.executeCommand(ecrire(SITE,
      '<VirtualHost *:80>\n  DocumentRoot /var/www/html\n</VirtualHost>\n'
      + '<IfModule mod_rewrite.c>\n<VirtualHost *:8082>\n  RewriteEngine On\n'
      + '</VirtualHost>\n</IfModule>\n'));
    // `RewriteEngine` serait refusée si elle était lue ; elle ne l'est
    // pas, parce qu'Apache n'entre pas dans le bloc.
    expect(await srv.executeCommand('apachectl configtest')).toContain('Syntax OK');
  });
});

describe('`apachectl -M` et `configtest` lisent les MÊMES modules', () => {
  it('un module allumé apparaît dans les deux vues au même instant', async () => {
    expect(await srv.executeCommand('apachectl -M')).not.toContain('proxy_module');
    expect(await vhost('  ProxyPass / http://x/\n')).toContain('Invalid command');

    await srv.executeCommand('a2enmod proxy');

    // Deux vues qui ne seraient pas d'accord sur ce qui est chargé
    // seraient la contradiction la plus déroutante possible — c'est
    // pourquoi une seule lecture les sert.
    expect(await srv.executeCommand('apachectl -M')).toContain('proxy_module');
    expect(await vhost('  ProxyPass / http://x/\n')).toContain('not supported by this simulator');
  });

  it('un lien posé à la main sous mods-enabled compte aussi', async () => {
    await srv.executeCommand(
      'ln -s ../mods-available/rewrite.load /etc/apache2/mods-enabled/rewrite.load');
    expect(await vhost('  RewriteEngine On\n')).toContain('not supported by this simulator');
  });
});
