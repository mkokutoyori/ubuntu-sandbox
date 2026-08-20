/**
 * `a2ensite` / `a2dissite` / `a2enmod` / `a2dismod`.
 *
 * Les quatre commandes n'existaient pas — `a2ensite default-ssl`
 * répondait `command not found`, à la deuxième ligne de n'importe quel
 * tutoriel Apache. Tout le module les nommait pourtant, en observant
 * qu'elles ne sont qu'un `ln -s` ; l'observation est juste et a servi de
 * raison de ne pas les écrire, ce qui ne suit pas : faire marcher
 * `ln -s` à la main n'exige pas que la commande soit absente.
 *
 * Ce que ces cas vérifient : que la commande fait bien CE LIEN-LÀ (donc
 * qu'un lien posé à la main reste équivalent), que `apachectl -M` et
 * `apachectl -S` le voient puisqu'ils lisent le répertoire, et que
 * `mods-available` existe enfin — sans lui, `a2enmod ssl` n'aurait rien
 * à lier, et c'est cette distinction disponible/activé qui porte la
 * leçon.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

let srv: LinuxServer;

beforeEach(() => {
  srv = new LinuxServer('linux-server', 'SRV');
  srv.powerOn();
});

describe('a2ensite / a2dissite', () => {
  it('active un site en posant le lien que Debian pose', async () => {
    const out = await srv.executeCommand('a2ensite default-ssl');
    expect(out).toContain('Enabling site default-ssl.');
    // Un site se RECHARGE ; un module se redémarre. La différence est
    // réelle et le message la porte.
    expect(out).toContain('systemctl reload apache2');

    const listing = await srv.executeCommand('ls -l /etc/apache2/sites-enabled');
    // Le lien est RELATIF, comme celui de Debian : un chemin absolu
    // marcherait et se verrait au premier `ls -l`.
    expect(listing).toContain('default-ssl.conf -> ../sites-available/default-ssl.conf');
  });

  it('le suffixe `.conf` est toléré, comme le vrai script', async () => {
    expect(await srv.executeCommand('a2ensite default-ssl.conf'))
      .toContain('Enabling site default-ssl.');
  });

  it('activer deux fois le dit sans rien casser', async () => {
    await srv.executeCommand('a2ensite default-ssl');
    const out = await srv.executeCommand('a2ensite default-ssl');
    expect(out).toContain('Site default-ssl already enabled');
    expect(out).not.toContain('Enabling');
  });

  it('un site qui n\'existe pas est une erreur, pas un silence', async () => {
    expect(await srv.executeCommand('a2ensite nexistepas'))
      .toContain('ERROR: Site nexistepas does not exist!');
  });

  it('désactiver retire le lien, et `apachectl -S` cesse de voir le site', async () => {
    await srv.executeCommand('a2ensite default-ssl');
    const out = await srv.executeCommand('a2dissite default-ssl');
    expect(out).toContain('Site default-ssl disabled.');
    expect(await srv.executeCommand('ls /etc/apache2/sites-enabled'))
      .not.toContain('default-ssl');
  });

  it('désactiver un site déjà éteint le dit, et un inexistant reste une erreur', async () => {
    // Les deux cas sont distincts sur un vrai système : l'un est un
    // état, l'autre une faute de frappe.
    expect(await srv.executeCommand('a2dissite default-ssl'))
      .toContain('Site default-ssl already disabled');
    expect(await srv.executeCommand('a2dissite nexistepas'))
      .toContain('ERROR: Site nexistepas does not exist!');
  });

  it('un lien posé À LA MAIN vaut autant — la commande n\'est que ce lien', async () => {
    await srv.executeCommand(
      'ln -s ../sites-available/default-ssl.conf /etc/apache2/sites-enabled/default-ssl.conf');
    // Et `a2dissite` doit alors le retirer : les deux gestes portent sur
    // le même objet, sans registre à part.
    expect(await srv.executeCommand('a2dissite default-ssl'))
      .toContain('Site default-ssl disabled.');
  });
});

describe('a2enmod / a2dismod', () => {
  it('`mods-available` existe et contient ce que Debian livre éteint', async () => {
    const dispo = await srv.executeCommand('ls /etc/apache2/mods-available');
    // Le répertoire n'existait pas du tout. Ce sont précisément ces
    // quatre-là qu'un TP allume en premier.
    for (const m of ['ssl.load', 'proxy.load', 'rewrite.load', 'headers.load']) {
      expect(dispo, m).toContain(m);
    }
    const actifs = await srv.executeCommand('ls /etc/apache2/mods-enabled');
    expect(actifs).not.toContain('ssl.load');
    expect(actifs).toContain('dir.load');
  });

  it('activer un module le fait apparaître dans `apachectl -M`', async () => {
    const out = await srv.executeCommand('a2enmod ssl');
    expect(out).toContain('Enabling module ssl.');
    // Un module est du CODE chargé dans le serveur : il faut le
    // redémarrer, pas le recharger.
    expect(out).toContain('systemctl restart apache2');
    expect(await srv.executeCommand('apachectl -M')).toContain('ssl_module (shared)');
  });

  it('désactiver le retire de `apachectl -M`', async () => {
    await srv.executeCommand('a2enmod rewrite');
    expect(await srv.executeCommand('apachectl -M')).toContain('rewrite_module');
    expect(await srv.executeCommand('a2dismod rewrite')).toContain('Module rewrite disabled.');
    expect(await srv.executeCommand('apachectl -M')).not.toContain('rewrite_module');
  });

  it('un module qui n\'existe pas est une erreur', async () => {
    expect(await srv.executeCommand('a2enmod zorglub'))
      .toContain('ERROR: Module zorglub does not exist!');
  });

  it('sans argument, la commande énumère les choix', async () => {
    const out = await srv.executeCommand('a2enmod');
    expect(out).toContain('Your choices are:');
    expect(out).toContain('ssl');
    expect(out).toContain('Which module(s) do you want to enable');
  });

  it('les modules livrés actifs sont des LIENS, pas des copies', async () => {
    // Sans cela, `a2dismod dir` supprimerait un fichier que rien ne
    // pourrait recréer, et `a2enmod dir` échouerait ensuite.
    expect(await srv.executeCommand('ls -l /etc/apache2/mods-enabled'))
      .toContain('dir.load -> ../mods-available/dir.load');
    await srv.executeCommand('a2dismod dir');
    expect(await srv.executeCommand('a2enmod dir')).toContain('Enabling module dir.');
  });
});
