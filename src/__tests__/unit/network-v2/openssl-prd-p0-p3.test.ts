/**
 * docs/PRD-OpenSSL.md — P0 (le squelette et le mensonge qui cesse),
 * P1 (empreintes et aléa), P2 (base64, mots de passe),
 * P3 (clés, CSR, certificats).
 *
 * Le défaut de départ n'était pas « une option manque » : la commande
 * n'existait pas du tout, alors que `dpkg -l openssl` la déclarait
 * installée. Ces cas tiennent d'abord cette cohérence-là, puis le
 * §5 P1 — ce qui peut être réel l'est —, dont la vérification décisive
 * est que `sha256sum` et `openssl dgst -sha256` ne peuvent pas
 * diverger sur la même machine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function machine(nom = 'SSL'): LinuxServer {
  const srv = new LinuxServer('linux-server', nom);
  srv.powerOn();
  return srv;
}

describe('§P0 — le paquet ne ment plus', () => {
  it('la commande existe et rend sa version', async () => {
    const out = await machine().executeCommand('openssl version');
    expect(out).toContain('OpenSSL 3.0.2');
  });

  it('la version annoncée est celle du paquet, sinon dpkg la contredirait', async () => {
    const srv = machine();

    const paquet = await srv.executeCommand('dpkg -l openssl');
    const commande = await srv.executeCommand('openssl version');

    expect(paquet).toContain('3.0.2');
    expect(commande).toContain('3.0.2');
  });

  it('le binaire existe vraiment sur le disque, comme le paquet le promet', async () => {
    const out = await machine().executeCommand('ls -l /usr/bin/openssl');

    expect(out).toContain('/usr/bin/openssl');
    expect(out).not.toMatch(/No such file/);
  });

  /**
   * Cette lacune est FERMÉE, et ce cas était sa trace.
   *
   * Il affirmait, mesure à l'appui et `curl` comme témoin, que le garde
   * « binaire supprimé » de `CriticalFiles` ne couvrait pas les
   * commandes servies par le registre : `rm /usr/bin/curl` puis `curl`
   * fonctionnait encore. Le commentaire qu'il portait disait qu'il
   * tomberait le jour où le garde couvrirait le registre. Il est tombé,
   * et l'assertion s'inverse — voir `deleted-binary-registry-dispatch.test.ts`
   * pour les trois chemins de dispatch.
   */
  it('supprimer le binaire arrête la commande, comme tout binaire', async () => {
    const srv = machine();
    expect(await srv.executeCommand('openssl version')).toContain('OpenSSL');

    await srv.executeCommand('rm /usr/bin/openssl');

    expect(await srv.executeCommand('openssl version'))
      .toContain('/usr/bin/openssl: No such file or directory');
  });

  it('un sous-mode inexistant reçoit le message d\'openssl', async () => {
    const out = await machine().executeCommand('openssl frobnicate');
    expect(out).toContain("'frobnicate' is an invalid command");
  });

  it('un sous-mode qu\'openssl connaît mais que ce build n\'a pas est distingué', async () => {
    // `speed` existe chez openssl : répondre « invalid command »
    // affirmerait le contraire, et c'est ce qu'un apprenant retiendrait.
    const out = await machine().executeCommand('openssl speed');
    expect(out).toContain('is not implemented in this simulator');
    expect(out).not.toContain('invalid command');
  });
});

describe('§P1 — les empreintes, et l\'accord entre outils', () => {
  it('`sha256sum` et `openssl dgst -sha256` rendent la MÊME empreinte', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "bonjour" > /tmp/m.txt'`);

    const coreutils = (await srv.executeCommand('sha256sum /tmp/m.txt')).trim().split(/\s+/)[0];
    const ssl = (await srv.executeCommand('openssl dgst -sha256 /tmp/m.txt')).trim();

    // Le contrat du §5 P1 : les deux lisent le même moteur, donc ils ne
    // PEUVENT pas diverger. Un simulateur où ils différeraient
    // enseignerait qu'une empreinte dépend de l'outil.
    expect(ssl).toBe(`SHA2-256(/tmp/m.txt)= ${coreutils}`);
  });

  it('le préfixe est celui d\'OpenSSL 3, pas celui de la 1.1', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "x" > /tmp/x'`);

    const out = await srv.executeCommand('openssl dgst -sha256 /tmp/x');

    expect(out).toContain('SHA2-256(');
    expect(out).not.toContain('SHA256(/tmp/x)');
  });

  it('md5 et sha1 répondent aussi, avec leur propre étiquette', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "abc" > /tmp/a'`);

    expect(await srv.executeCommand('openssl dgst -md5 /tmp/a')).toContain('MD5(/tmp/a)=');
    expect(await srv.executeCommand('openssl dgst -sha1 /tmp/a')).toContain('SHA1(/tmp/a)=');
  });

  it('l\'alias `openssl sha256 f` équivaut à `openssl dgst -sha256 f`', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "meme" > /tmp/m'`);

    const alias = await srv.executeCommand('openssl sha256 /tmp/m');
    const dgst = await srv.executeCommand('openssl dgst -sha256 /tmp/m');

    expect(alias.trim()).toBe(dgst.trim());
  });

  it('une empreinte que ce build n\'a pas est refusée en la nommant', async () => {
    const out = await machine().executeCommand('openssl dgst -sha384 /etc/hostname');
    expect(out).toContain("'sha384' is not implemented");
  });

  it('un fichier absent donne l\'erreur du système, pas un plantage', async () => {
    const out = await machine().executeCommand('openssl dgst -sha256 /tmp/absent');
    expect(out).toContain('No such file or directory');
  });

  it('`rand -hex` rend le bon nombre d\'octets', async () => {
    const out = (await machine().executeCommand('openssl rand -hex 16')).trim();
    expect(out).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('§P2 — base64 et mots de passe', () => {
  it('base64 fait l\'aller et le retour', async () => {
    const srv = machine();

    const code = (await srv.executeCommand(`sh -c 'printf "Bonjour" | openssl base64'`)).trim();
    expect(code).toBe('Qm9uam91cg==');

    const decode = (await srv.executeCommand(
      `sh -c 'printf "Qm9uam91cg==" | openssl base64 -d'`)).trim();
    expect(decode).toBe('Bonjour');
  });

  it('`passwd -1` rend un vrai MD5-crypt', async () => {
    const out = (await machine().executeCommand('openssl passwd -1 -salt abcdefgh secret')).trim();
    expect(out).toMatch(/^\$1\$abcdefgh\$/);
  });

  it('`passwd -6` rend la forme que la plateforme sait relire', async () => {
    // Décision écrite au §13.6 : l'empreinte doit être utilisable dans
    // /etc/shadow sur CETTE machine. Une empreinte cryptographiquement
    // exacte que le simulateur refuserait serait un exercice qui échoue
    // en enseignant que la méthode est fausse.
    const out = (await machine().executeCommand('openssl passwd -6 -salt sel motdepasse')).trim();
    expect(out).toBe('$6$sel$motdepasse');
  });
});

describe('§P3 — clés, CSR et certificats', () => {
  it('`genrsa -out` écrit une clé privée en PEM lisible', async () => {
    const srv = machine();

    await srv.executeCommand('openssl genrsa -out /tmp/serveur.key 2048');

    const pem = await srv.executeCommand('cat /tmp/serveur.key');
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(pem).toContain('-----END PRIVATE KEY-----');
  });

  it('`genrsa -traditional` écrit l\'étiquette historique', async () => {
    const srv = machine();
    await srv.executeCommand('openssl genrsa -traditional -out /tmp/t.key 2048');
    expect(await srv.executeCommand('cat /tmp/t.key')).toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('`req -x509` écrit un certificat auto-signé que `x509` relit', async () => {
    const srv = machine();

    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/ca.key -out /tmp/ca.crt '
      + '-days 365 -nodes -subj "/C=FR/O=Lab/CN=Lab Root CA"');

    const sujet = await srv.executeCommand('openssl x509 -in /tmp/ca.crt -noout -subject');
    expect(sujet).toContain('subject=C = FR, O = Lab, CN = Lab Root CA');
  });

  it('l\'aller-retour PEM conserve le certificat, champ par champ', async () => {
    const srv = machine();
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/k -out /tmp/c '
      + '-days 30 -nodes -subj "/CN=aller.retour"');

    const avant = await srv.executeCommand('openssl x509 -in /tmp/c -noout -subject -issuer -serial');

    // Réécrit le même certificat ailleurs, puis relit : c'est le §7.3
    // règle 1, et c'est ce qui rend le fichier utile à nginx.
    await srv.executeCommand('openssl x509 -in /tmp/c -out /tmp/c2');
    const apres = await srv.executeCommand('openssl x509 -in /tmp/c2 -noout -subject -issuer -serial');

    expect(apres).toBe(avant);
  });

  it('la chaîne complète : CA, CSR, signature, vérification', async () => {
    const srv = machine();

    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/ca.key -out /tmp/ca.crt '
      + '-days 365 -nodes -subj "/CN=Lab Root CA"');
    await srv.executeCommand('openssl genrsa -out /tmp/srv.key 2048');
    await srv.executeCommand(
      'openssl req -new -key /tmp/srv.key -out /tmp/srv.csr -subj "/CN=www.lab"');
    await srv.executeCommand(
      'openssl x509 -req -in /tmp/srv.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key '
      + '-CAcreateserial -out /tmp/srv.crt -days 90');

    const infos = await srv.executeCommand('openssl x509 -in /tmp/srv.crt -noout -subject -issuer');
    expect(infos).toContain('subject=CN = www.lab');
    expect(infos).toContain('issuer=CN = Lab Root CA');

    const verif = await srv.executeCommand('openssl verify -CAfile /tmp/ca.crt /tmp/srv.crt');
    expect(verif).toContain('/tmp/srv.crt: OK');
  });

  it('`verify` sans ancre échoue avec le code d\'erreur d\'openssl', async () => {
    const srv = machine();
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/k2 -out /tmp/seul.crt '
      + '-days 30 -nodes -subj "/CN=tout.seul"');

    const out = await srv.executeCommand('openssl verify /tmp/seul.crt');

    // 18 = self signed certificate. Le code exact compte : c'est ce
    // qu'un opérateur cherche dans un moteur de recherche.
    expect(out).toContain('error 18 at 0 depth lookup: self signed certificate');
    expect(out).toContain('verification failed');
  });

  it('`verify` échoue avec le code 2, pas 1', async () => {
    const srv = machine();
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/k3 -out /tmp/s.crt '
      + '-days 30 -nodes -subj "/CN=code"');

    // 1 signale une erreur d'USAGE ; 2 une chaîne invalide. Un script
    // de TP distingue les deux.
    const code = (await srv.executeCommand(
      'sh -c \'openssl verify /tmp/s.crt > /dev/null 2>&1; echo $?\'')).trim();
    expect(code).toBe('2');
  });

  it('`-dates` rend le format de date d\'openssl', async () => {
    const srv = machine();
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/k4 -out /tmp/d.crt '
      + '-days 30 -nodes -subj "/CN=dates"');

    const out = await srv.executeCommand('openssl x509 -in /tmp/d.crt -noout -dates');

    expect(out).toMatch(/notBefore=[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4} GMT/);
    expect(out).toMatch(/notAfter=/);
  });

  it('`-checkend` porte son résultat dans le code de sortie', async () => {
    const srv = machine();
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/k5 -out /tmp/ce.crt '
      + '-days 30 -nodes -subj "/CN=checkend"');

    const proche = (await srv.executeCommand(
      'sh -c \'openssl x509 -in /tmp/ce.crt -checkend 86400 > /dev/null; echo $?\'')).trim();
    const lointain = (await srv.executeCommand(
      'sh -c \'openssl x509 -in /tmp/ce.crt -checkend 999999999 > /dev/null; echo $?\'')).trim();

    expect(proche).toBe('0');
    expect(lointain).toBe('1');
  });

  it('`-text` déclare que la clé est simulée, là où elle se lit', async () => {
    const srv = machine();
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/k6 -out /tmp/t.crt '
      + '-days 30 -nodes -subj "/CN=texte"');

    const out = await srv.executeCommand('openssl x509 -in /tmp/t.crt -noout -text');

    expect(out).toContain('Certificate:');
    expect(out).toContain('Subject: CN = texte');
    // §5 P3 : un module inventé affiché sans mention enseignerait une
    // fausse confiance.
    expect(out).toContain('simulated key material');
  });

  it('`-addext subjectAltName` voyage jusqu\'au certificat', async () => {
    const srv = machine();
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/k7 -out /tmp/san.crt '
      + '-days 30 -nodes -subj "/CN=san.lab" -addext "subjectAltName=DNS:a.lab,DNS:b.lab"');

    const out = await srv.executeCommand('openssl x509 -in /tmp/san.crt -noout -text');
    expect(out).toContain('Subject Alternative Name');
    expect(out).toContain('DNS:a.lab');
  });

  it('un PEM corrompu est refusé sans faire tomber le shell', async () => {
    const srv = machine();
    await srv.executeCommand(`sh -c 'printf "ceci nest pas un certificat" > /tmp/faux.crt'`);

    const out = await srv.executeCommand('openssl x509 -in /tmp/faux.crt -noout -subject');
    expect(out).toContain('unable to load certificate');

    // Le shell répond encore : c'est la règle 2 du §7.3.
    expect((await srv.executeCommand('echo vivant')).trim()).toBe('vivant');
  });
});

describe('§P4 — les commandes de description', () => {
  it('`ciphers` décrit CE simulateur, pas un autre openssl', async () => {
    const out = await machine().executeCommand('openssl ciphers');

    // La règle du §P4 : réciter la liste d'un vrai openssl décrirait une
    // autre machine. Ce sont les suites que les transports TLS de ce
    // dépôt offrent réellement.
    expect(out).toContain('TLS_AES_256_GCM_SHA384');
    expect(out).toContain('TLS_CHACHA20_POLY1305_SHA256');
    // Une suite TLS 1.2 qu'aucun transport d'ici ne négocie.
    expect(out).not.toContain('ECDHE-RSA-AES256-SHA384');
  });

  it('`ciphers -v` détaille chaque suite', async () => {
    const out = await machine().executeCommand('openssl ciphers -v');
    expect(out).toMatch(/TLS_AES_128_GCM_SHA256\s+TLSv1\.3/);
  });

  it('`info` rend les chemins de l\'installation', async () => {
    expect((await machine().executeCommand('openssl info -configdir')).trim())
      .toBe('/usr/lib/ssl');
  });

  it('`prime` répond juste, dans les deux sens', async () => {
    const srv = machine();
    expect(await srv.executeCommand('openssl prime 17')).toMatch(/is prime/);
    expect(await srv.executeCommand('openssl prime 18')).toMatch(/is not prime/);
  });
});

describe('§P5 — la PKI de labo : ca, révocation, CRL', () => {
  /** Une autorité et un certificat signé par elle, prêts à révoquer. */
  async function autorite(nom: string) {
    const srv = machine(nom);
    await srv.executeCommand('mkdir -p /etc/ssl/CA');
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/CA/ca.key -out /etc/ssl/CA/ca.crt '
      + '-days 3650 -nodes -subj "/CN=Lab Root CA"');
    await srv.executeCommand('openssl genrsa -out /tmp/w.key 2048');
    await srv.executeCommand(
      'openssl req -new -key /tmp/w.key -out /tmp/w.csr -subj "/CN=www.lab"');
    return srv;
  }

  it('`ca -in csr -out crt` signe et inscrit à l\'index', async () => {
    const srv = await autorite('CA1');

    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
      + '-in /tmp/w.csr -out /tmp/w.crt -days 90');

    const sujet = await srv.executeCommand('openssl x509 -in /tmp/w.crt -noout -subject -issuer');
    expect(sujet).toContain('subject=CN = www.lab');
    expect(sujet).toContain('issuer=CN = Lab Root CA');

    // L'index est un vrai fichier, au format d'openssl-ca : `V` en tête,
    // la série, le sujet. C'est lui que `-gencrl` relira.
    const index = await srv.executeCommand('cat /etc/ssl/CA/index.txt');
    expect(index).toMatch(/^V\t/);
    expect(index).toContain('/CN=www.lab');
  });

  it('le certificat signé par la CA se vérifie contre elle', async () => {
    const srv = await autorite('CA2');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
      + '-in /tmp/w.csr -out /tmp/w.crt -days 90');

    const out = await srv.executeCommand('openssl verify -CAfile /etc/ssl/CA/ca.crt /tmp/w.crt');
    expect(out).toContain('/tmp/w.crt: OK');
  });

  it('`-revoke` change l\'état dans l\'index, et `-gencrl` le publie', async () => {
    const srv = await autorite('CA3');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
      + '-in /tmp/w.csr -out /tmp/w.crt -days 90');
    const serie = (await srv.executeCommand('openssl x509 -in /tmp/w.crt -noout -serial'))
      .trim().replace('serial=', '');

    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/w.crt');

    expect(await srv.executeCommand('cat /etc/ssl/CA/index.txt')).toMatch(/^R\t/);

    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
      + '-gencrl -out /tmp/lab.crl');

    // La CRL et l'index ne peuvent pas se contredire : `-gencrl` LIT
    // l'index, il ne tient pas sa propre liste.
    const crl = await srv.executeCommand('openssl crl -in /tmp/lab.crl -noout -text');
    expect(crl).toContain('Revoked Certificates:');
    expect(crl).toContain(serie);
  });

  it('une CRL sans révocation le dit, au lieu d\'une liste vide muette', async () => {
    const srv = await autorite('CA4');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
      + '-in /tmp/w.csr -out /tmp/w.crt -days 90');

    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
      + '-gencrl -out /tmp/vide.crl');

    expect(await srv.executeCommand('openssl crl -in /tmp/vide.crl -noout -text'))
      .toContain('No Revoked Certificates.');
  });

  it('révoquer un certificat étranger à l\'index est refusé', async () => {
    const srv = await autorite('CA5');
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/e.key -out /tmp/etranger.crt '
      + '-days 30 -nodes -subj "/CN=etranger"');

    const out = await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key -revoke /tmp/etranger.crt');

    expect(out).toContain('is not in the index');
  });

  it('la CRL nomme son émetteur', async () => {
    const srv = await autorite('CA6');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
      + '-in /tmp/w.csr -out /tmp/w.crt -days 90');
    await srv.executeCommand(
      'openssl ca -cert /etc/ssl/CA/ca.crt -keyfile /etc/ssl/CA/ca.key '
      + '-gencrl -out /tmp/i.crl');

    expect((await srv.executeCommand('openssl crl -in /tmp/i.crl -noout -issuer')).trim())
      .toBe('issuer=CN = Lab Root CA');
  });
});

describe('§P6 — le reste de la PKI', () => {
  it('`ecparam -genkey` écrit une clé EC que `ec` relit', async () => {
    const srv = machine();

    await srv.executeCommand('openssl ecparam -name prime256v1 -genkey -out /tmp/ec.key');

    expect(await srv.executeCommand('cat /tmp/ec.key')).toContain('-----BEGIN EC PRIVATE KEY-----');
    expect(await srv.executeCommand('openssl ec -in /tmp/ec.key -noout -text'))
      .toContain('NIST CURVE: P-256');
  });

  it('une courbe inconnue est refusée en la nommant', async () => {
    const out = await machine().executeCommand('openssl ecparam -name courbe-imaginaire -genkey');
    expect(out).toContain('unknown curve name (courbe-imaginaire)');
  });

  it('`ec -in` sur une clé RSA refuse, au lieu de la lire de travers', async () => {
    const srv = machine();
    await srv.executeCommand('openssl genrsa -out /tmp/r.key 2048');

    expect(await srv.executeCommand('openssl ec -in /tmp/r.key -noout')).toContain('unable to load Key');
  });

  /**
   * Ce cas invoquait `-topk8` SANS `-nocrypt` et attendait une clé en
   * clair. C'était le défaut, pas le comportement : sur un vrai openssl,
   * `-topk8` chiffre, et `-nocrypt` est justement le drapeau qui demande
   * de ne pas le faire (voir `openssl-pkcs8-encrypted.test.ts`). Le test
   * est corrigé, pas le produit.
   */
  it('`pkcs8 -topk8 -nocrypt` change l\'armure sans changer la clé', async () => {
    const srv = machine();
    await srv.executeCommand('openssl genrsa -traditional -out /tmp/trad.key 2048');
    expect(await srv.executeCommand('cat /tmp/trad.key')).toContain('BEGIN RSA PRIVATE KEY');

    await srv.executeCommand('openssl pkcs8 -topk8 -nocrypt -in /tmp/trad.key -out /tmp/p8.key');

    expect(await srv.executeCommand('cat /tmp/p8.key')).toContain('BEGIN PRIVATE KEY');
    // La conversion porte sur la FORME : la clé doit encore servir.
    expect(await srv.executeCommand('openssl rsa -in /tmp/p8.key -noout -check'))
      .toContain('RSA key ok');
  });

  it('`pkeyutl -sign` puis `-verify` accepte la vraie signature', async () => {
    const srv = machine();
    await srv.executeCommand('openssl genrsa -out /tmp/s.key 2048');
    await srv.executeCommand(`sh -c 'printf "message" > /tmp/msg'`);

    await srv.executeCommand('openssl pkeyutl -sign -in /tmp/msg -inkey /tmp/s.key -out /tmp/msg.sig');

    expect(await srv.executeCommand(
      'openssl pkeyutl -verify -in /tmp/msg -inkey /tmp/s.key -sigfile /tmp/msg.sig'))
      .toContain('Signature Verified Successfully');
  });

  it('`pkeyutl -verify` REJETTE une signature falsifiée', async () => {
    const srv = machine();
    await srv.executeCommand('openssl genrsa -out /tmp/s2.key 2048');
    await srv.executeCommand(`sh -c 'printf "message" > /tmp/m2'`);
    await srv.executeCommand(`sh -c 'printf "rsa:0000000000000000" > /tmp/fausse.sig'`);

    // La signature est simulée ; sa VÉRIFICATION ne l'est pas. C'est la
    // seule partie de cette PKI qui refuse réellement quelque chose, et
    // c'est ce qui rend le sous-mode utile plutôt que décoratif.
    const out = await srv.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m2 -inkey /tmp/s2.key -sigfile /tmp/fausse.sig');
    expect(out).toContain('Signature Verification Failure');
  });

  it('un message modifié après signature ne se vérifie plus', async () => {
    const srv = machine();
    await srv.executeCommand('openssl genrsa -out /tmp/s3.key 2048');
    await srv.executeCommand(`sh -c 'printf "original" > /tmp/m3'`);
    await srv.executeCommand('openssl pkeyutl -sign -in /tmp/m3 -inkey /tmp/s3.key -out /tmp/m3.sig');

    await srv.executeCommand(`sh -c 'printf "falsifie" > /tmp/m3'`);

    expect(await srv.executeCommand(
      'openssl pkeyutl -verify -in /tmp/m3 -inkey /tmp/s3.key -sigfile /tmp/m3.sig'))
      .toContain('Signature Verification Failure');
  });
});

describe('§P7 — s_client ouvre une vraie connexion', () => {
  const SRV = '10.95.0.10';
  const CLI = '10.95.0.20';

  /** Deux machines câblées, comme pour `nc` et `nmap`. */
  function reseau() {
    const server = new LinuxServer('linux-server', 'TLS-SRV');
    const client = new LinuxPC('linux-pc', 'TLS-CLI');
    const sw = new GenericSwitch('switch-generic', 'SW');
    new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    server.getPorts()[0].configureIP(new IPAddress(SRV), mask);
    client.getPorts()[0].configureIP(new IPAddress(CLI), mask);
    server.powerOn();
    client.powerOn();
    return { server, client };
  }

  it('un port réellement servi répond CONNECTED', async () => {
    const { server, client } = reseau();
    server.getTcpStack().listen(8443, { onAccept: () => undefined });

    const out = await client.executeCommand(`openssl s_client -connect ${SRV}:8443`);

    expect(out).toContain('CONNECTED(00000003)');
  });

  it('un port que personne ne sert rend l\'errno du vrai client', async () => {
    const { client } = reseau();

    const out = await client.executeCommand(`openssl s_client -connect ${SRV}:9999`);

    // 111 est ECONNREFUSED, le nombre qu'un opérateur reconnaît.
    expect(out).toContain('connect:errno=111');
    expect(out).not.toContain('CONNECTED');
  });

  it('le verdict vient du fil : couper le câble change la réponse', async () => {
    const { server, client } = reseau();
    server.getTcpStack().listen(8443, { onAccept: () => undefined });
    expect(await client.executeCommand(`openssl s_client -connect ${SRV}:8443`))
      .toContain('CONNECTED');

    server.getPorts()[0].setAdminDown(true);

    // Rien n'a changé côté écoute ; c'est le réseau qui a changé, et
    // c'est ce que `s_client` rapporte. Une réponse en dur ne pourrait
    // pas faire cette différence.
    expect(await client.executeCommand(`openssl s_client -connect ${SRV}:8443`))
      .not.toContain('CONNECTED(');
  });

  it('sans -CAfile, il DIT qu\'il n\'a pas de chaîne au lieu d\'en inventer une', async () => {
    const { server, client } = reseau();
    server.getTcpStack().listen(8443, { onAccept: () => undefined });

    const out = await client.executeCommand(`openssl s_client -connect ${SRV}:8443`);

    // §5 P3 : c'est le seul endroit d'openssl où l'apprenant lit
    // littéralement « fais confiance ». Un `Verification: OK` fabriqué
    // serait la pire ligne de tout ce chantier.
    expect(out).toContain('no peer certificate available in this simulator');
    expect(out).toContain('Verification: not performed');
    expect(out).not.toContain('Verification: OK');
  });

  it('avec -CAfile, il affiche l\'ancre fournie', async () => {
    const { server, client } = reseau();
    server.getTcpStack().listen(8443, { onAccept: () => undefined });
    await client.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/a.key -out /tmp/ancre.crt '
      + '-days 365 -nodes -subj "/CN=Ancre Lab"');

    const out = await client.executeCommand(
      `openssl s_client -connect ${SRV}:8443 -CAfile /tmp/ancre.crt`);

    expect(out).toContain('s:CN = Ancre Lab');
    expect(out).toContain('Verification: OK');
  });

  it('un nom se résout par /etc/hosts, comme les autres clients', async () => {
    const { server, client } = reseau();
    server.getTcpStack().listen(8443, { onAccept: () => undefined });
    await client.executeCommand(`sh -c 'echo "${SRV} tls.lab" >> /etc/hosts'`);

    expect(await client.executeCommand('openssl s_client -connect tls.lab:8443'))
      .toContain('CONNECTED');
  });

  it('un nom inconnu est refusé avant toute connexion', async () => {
    const { client } = reseau();

    const out = await client.executeCommand('openssl s_client -connect nulle-part.lab:443');

    expect(out).toContain('unable to resolve host');
  });

  it('un -connect malformé est refusé', async () => {
    const { client } = reseau();
    expect(await client.executeCommand('openssl s_client -connect nimportequoi'))
      .toContain('malformed -connect argument');
  });

  it('`s_server` reste refusé, honnêtement', async () => {
    const { client } = reseau();
    const out = await client.executeCommand('openssl s_server -accept 4433');
    expect(out).toContain('is not implemented in this simulator');
  });
});
