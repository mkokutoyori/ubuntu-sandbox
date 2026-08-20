/**
 * `openssl verify` vérifie une signature, et pas seulement un nom.
 *
 * Le défaut mesuré : la commande cherchait l'émetteur dans `-CAfile` par
 * son SUJET (`ancres.find(a => a.subject === cert.issuer)`) et répondait
 * `OK` dès qu'un nom correspondait — sans jamais contrôler la signature.
 * Or n'importe qui peut fabriquer une racine appelée `Lab Root CA` : il
 * suffit de la nommer ainsi. Un certificat signé par une racine
 * étrangère portant le même nom était donc déclaré valide.
 *
 * Ce n'est pas une nuance : `curl --cacert` REFUSE correctement ce même
 * couple de fichiers, puisqu'il passe par `CertificateVerifier`. Les deux
 * commandes rendaient des verdicts opposés sur les mêmes deux fichiers,
 * sur la même machine — pire qu'un seul verdict faux, parce que rien dans
 * le diagnostic ne tient debout. `verify` passe désormais par le même
 * objet ; c'est la correction, le reste en découle.
 *
 * Deux manques trouvés au passage et corrigés ici même : un `-CAfile` est
 * un FAISCEAU (plusieurs racines approuvées d'un coup) dont seule la
 * première ancre était lue, et `notBefore` n'était contrôlé nulle part.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'V'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

/** Une racine, son nom étant le seul choix qui compte ici. *
 * Les clés font 512 bits, la taille par défaut : ce que ces cas mesurent
 * est QUI a signé, jamais la force. Elles en demandaient 2048, ce qui
 * coûtait une demi-seconde chacune depuis que RSA est réel — assez pour
 * faire dépasser le délai de cinq secondes quand plusieurs de ces
 * fichiers tournent ensemble.
 */
async function racine(srv: LinuxServer, id: string, nom: string): Promise<void> {
  await srv.executeCommand(
    `openssl req -x509 -newkey rsa:512 -keyout /tmp/${id}.key `
    + `-out /tmp/${id}.crt -days 365 -nodes -subj "/CN=${nom}"`);
}

/** Une feuille signée par la racine désignée. */
async function feuille(srv: LinuxServer, id: string, nom: string, parId: string): Promise<void> {
  await srv.executeCommand(`openssl genrsa -out /tmp/${id}.key 512`);
  await srv.executeCommand(
    `openssl req -new -key /tmp/${id}.key -out /tmp/${id}.csr -subj "/CN=${nom}"`);
  await srv.executeCommand(
    `openssl x509 -req -in /tmp/${id}.csr -CA /tmp/${parId}.crt -CAkey /tmp/${parId}.key `
    + `-CAcreateserial -out /tmp/${id}.crt -days 90`);
}

describe('le nom ne suffit pas', () => {
  it('une feuille signée par sa racine se vérifie', async () => {
    const srv = machine();
    await racine(srv, 'ca', 'Lab Root CA');
    await feuille(srv, 'srv', 'www.lab', 'ca');

    expect(await srv.executeCommand('openssl verify -CAfile /tmp/ca.crt /tmp/srv.crt'))
      .toContain('/tmp/srv.crt: OK');
  });

  /**
   * LE CAS QUI DISCRIMINE. Les deux racines portent le même sujet, donc
   * la recherche par nom trouve toujours quelque chose ; seule la
   * signature les sépare.
   */
  it('une racine étrangère portant le MÊME nom est refusée', async () => {
    const srv = machine();
    await racine(srv, 'vraie', 'Lab Root CA');
    await racine(srv, 'fausse', 'Lab Root CA');
    await feuille(srv, 'srv', 'www.lab', 'vraie');

    const out = await srv.executeCommand('openssl verify -CAfile /tmp/fausse.crt /tmp/srv.crt');
    expect(out).not.toContain('OK');
    // 7 = certificate signature failure. Le numéro est ce que l'opérateur
    // cherche ; il doit désigner la signature, pas l'absence d'émetteur.
    expect(out).toContain('error 7 at 0 depth lookup: certificate signature failure');
    expect(out).toContain('verification failed');
  });

  it('et le code de sortie du refus reste 2', async () => {
    const srv = machine();
    await racine(srv, 'vraie', 'Lab Root CA');
    await racine(srv, 'fausse', 'Lab Root CA');
    await feuille(srv, 'srv', 'www.lab', 'vraie');

    expect((await srv.executeCommand(
      'sh -c \'openssl verify -CAfile /tmp/fausse.crt /tmp/srv.crt >/dev/null 2>&1; echo $?\'',
    )).trim()).toBe('2');
  });

  it('une racine d\'un autre nom donne 20, pas 7 — les deux échecs sont distincts', async () => {
    const srv = machine();
    await racine(srv, 'vraie', 'Lab Root CA');
    await racine(srv, 'autre', 'Autre CA');
    await feuille(srv, 'srv', 'www.lab', 'vraie');

    const out = await srv.executeCommand('openssl verify -CAfile /tmp/autre.crt /tmp/srv.crt');
    expect(out).toContain('error 20 at 0 depth lookup: unable to get local issuer certificate');
  });

  it('un auto-signé sans ancre reste un 18', async () => {
    const srv = machine();
    await racine(srv, 'seul', 'tout.seul');

    expect(await srv.executeCommand('openssl verify /tmp/seul.crt'))
      .toContain('error 18 at 0 depth lookup: self signed certificate');
  });

  it('mais un auto-signé PRÉSENT dans le faisceau est approuvé', async () => {
    const srv = machine();
    await racine(srv, 'seul', 'tout.seul');

    // C'est exactement ce que fait un labo : on approuve sa propre racine.
    expect(await srv.executeCommand('openssl verify -CAfile /tmp/seul.crt /tmp/seul.crt'))
      .toContain('/tmp/seul.crt: OK');
  });
});

describe('-CAfile est un faisceau', () => {
  it('la deuxième racine du fichier approuve aussi', async () => {
    const srv = machine();
    await racine(srv, 'a', 'CA A');
    await racine(srv, 'b', 'CA B');
    await feuille(srv, 'srv', 'www.lab', 'b');
    await srv.executeCommand('sh -c \'cat /tmp/a.crt /tmp/b.crt > /tmp/bundle.crt\'');

    // Avec une lecture limitée au premier bloc, seule `CA A` comptait et
    // ce certificat était refusé alors que son émetteur est dans le
    // fichier qu'on vient de désigner.
    expect(await srv.executeCommand('openssl verify -CAfile /tmp/bundle.crt /tmp/srv.crt'))
      .toContain('/tmp/srv.crt: OK');
  });

  it('et une racine absente du faisceau ne l\'est pas devenue', async () => {
    const srv = machine();
    await racine(srv, 'a', 'CA A');
    await racine(srv, 'b', 'CA B');
    await racine(srv, 'c', 'CA C');
    await feuille(srv, 'srv', 'www.lab', 'c');
    await srv.executeCommand('sh -c \'cat /tmp/a.crt /tmp/b.crt > /tmp/bundle.crt\'');

    expect(await srv.executeCommand('openssl verify -CAfile /tmp/bundle.crt /tmp/srv.crt'))
      .not.toContain('OK');
  });
});

describe('les deux commandes disent la même chose des mêmes fichiers', () => {
  /**
   * L'invariant que cette correction pose : `verify` et `--cacert`
   * partagent `CertificateVerifier`. Le test le vérifie sur le couple qui
   * les séparait — la racine homonyme.
   */
  it('curl refuse ce que verify refuse', async () => {
    const srv = machine();
    await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
    await racine(srv, 'vraie', 'Lab Root CA');
    await racine(srv, 'fausse', 'Lab Root CA');
    await srv.executeCommand('openssl genrsa -out /etc/ssl/private/srv.key 512');
    await srv.executeCommand(
      'openssl req -new -key /etc/ssl/private/srv.key -out /tmp/srv.csr -subj "/CN=127.0.0.1"');
    await srv.executeCommand(
      'openssl x509 -req -in /tmp/srv.csr -CA /tmp/vraie.crt -CAkey /tmp/vraie.key '
      + '-CAcreateserial -out /etc/ssl/certs/srv.crt -days 90');
    await srv.executeCommand(
      `sh -c 'printf "server {\\n  listen 443 ssl;\\n  server_name _;\\n`
      + `  root /var/www/html;\\n  index index.nginx-debian.html;\\n`
      + `  ssl_certificate /etc/ssl/certs/srv.crt;\\n`
      + `  ssl_certificate_key /etc/ssl/private/srv.key;\\n}\\n" `
      + `> /etc/nginx/sites-available/default'`);
    await srv.executeCommand('systemctl start nginx');

    expect(await srv.executeCommand('openssl verify -CAfile /tmp/fausse.crt /etc/ssl/certs/srv.crt'))
      .not.toContain('OK');
    expect(await srv.executeCommand('curl -sS --cacert /tmp/fausse.crt https://127.0.0.1/'))
      .not.toContain('Welcome to nginx!');

    // Et acceptent tous deux la vraie, sans quoi l'accord ci-dessus
    // pourrait n'être qu'un refus systématique.
    expect(await srv.executeCommand('openssl verify -CAfile /tmp/vraie.crt /etc/ssl/certs/srv.crt'))
      .toContain('OK');
    expect(await srv.executeCommand('curl -sS --cacert /tmp/vraie.crt https://127.0.0.1/'))
      .toContain('Welcome to nginx!');
  });
});
