/**
 * `curl --version`, et quatre options qui n'avaient besoin d'aucune
 * invention.
 *
 * Le point de départ est un DÉFAUT, pas une absence : `curl --version`
 * répondait `curl: option --version: is unknown`. Or `docs/PRD-Curl.md`
 * §3 pose trois familles d'options — implémentées, connues-mais-non-
 * implémentées, et inexistantes — et le message `is unknown` appartient
 * à la troisième. L'appliquer à l'option la plus tapée de toutes était
 * le seul message de ce fichier qui mentait sur ce que curl est.
 *
 * Les quatre autres (`-e`, `-T`, `-D`, `--data-urlencode`) étaient
 * refusées honnêtement, et n'exigeaient rien qui n'existe déjà :
 * un en-tête, une lecture de fichier, une écriture, un encodage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse } from '@/network/http/semantics/types';

let srv: LinuxServer;
let cli: LinuxServer;

beforeEach(() => {
  srv = new LinuxServer('linux-server', 'SRV');
  cli = new LinuxServer('linux-server', 'CLI');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  srv.powerOn();
  cli.powerOn();
  new Cable('a').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));

  // Un serveur qui RAPPORTE la requête : la méthode, le `Referer`, le
  // type et le corps. Sans ce rapport, ces options ne se mesurent pas.
  new Http1ServerSession(srv.getTcpStack(), 8080, (req) => {
    const r = createResponse(200, 'OK');
    r.headers.set('Content-Type', 'text/plain');
    r.headers.set('X-Marque', 'oui');
    const corps = req.body ? new TextDecoder().decode(req.body) : '';
    r.body = new TextEncoder().encode(
      `${req.method} ref=[${req.headers.get('Referer') ?? '-'}] `
      + `ct=[${req.headers.get('Content-Type') ?? '-'}] corps=[${corps}]`);
    return r;
  }).start();
});

describe('`--version` — une option que curl connaît', () => {
  it('répond au lieu de se dire inconnue', async () => {
    const out = await cli.executeCommand('curl --version');
    expect(out).toContain('curl 8.5.0');
    expect(out).not.toContain('is unknown');
  });

  it('`-V` est la forme courte', async () => {
    expect(await cli.executeCommand('curl -V')).toContain('curl 8.5.0');
  });

  it('n\'exige pas d\'URL — elle ne transfère rien', async () => {
    // L'exiger ferait répondre le mode d'emploi à `curl --version`,
    // qui est précisément la commande qu'on tape sans URL.
    expect(await cli.executeCommand('curl --version')).not.toContain('curl [-fiIkLOsSv]');
  });

  it('n\'annonce que les protocoles réellement servis', async () => {
    const out = await cli.executeCommand('curl --version');
    expect(out).toContain('Protocols: http https');
    // Recopier la liste du vrai curl annoncerait une vingtaine de
    // schémas que la commande refuse — le décor que ce PRD retire.
    for (const absent of ['ftp', 'gopher', 'imap', 'ldap', 'smtp', 'telnet']) {
      expect(out, absent).not.toContain(absent);
    }
  });

  it('n\'annonce que les capacités réelles', async () => {
    const out = await cli.executeCommand('curl --version');
    expect(out).toContain('Features: IPv6 SSL');
    for (const absent of ['HTTPS-proxy', 'TLS-SRP', 'UnixSockets', 'brotli']) {
      expect(out, absent).not.toContain(absent);
    }
  });
});

describe('`-e` — l\'en-tête `Referer`', () => {
  it('part avec la requête', async () => {
    expect(await cli.executeCommand('curl -s -e https://ref.local/p http://10.0.0.2:8080/'))
      .toContain('ref=[https://ref.local/p]');
  });

  it('absent, aucun `Referer` n\'est inventé', async () => {
    expect(await cli.executeCommand('curl -s http://10.0.0.2:8080/')).toContain('ref=[-]');
  });
});

describe('`-T` — téléverser un fichier', () => {
  it('fait un PUT et envoie le contenu', async () => {
    await cli.executeCommand(`sh -c 'printf "contenu-du-fichier" > /tmp/up.txt'`);
    const out = await cli.executeCommand('curl -s -T /tmp/up.txt http://10.0.0.2:8080/cible');
    // PUT et non POST : c'est un téléversement, et les confondre
    // changerait la sémantique côté serveur.
    expect(out).toContain('PUT');
    expect(out).toContain('corps=[contenu-du-fichier]');
  });

  it('n\'impose aucun `Content-Type`', async () => {
    await cli.executeCommand(`sh -c 'printf "x" > /tmp/up.txt'`);
    // Un téléversement n'est pas un formulaire : curl laisse le serveur
    // décider, là où `-d` déclare `x-www-form-urlencoded`.
    expect(await cli.executeCommand('curl -s -T /tmp/up.txt http://10.0.0.2:8080/'))
      .toContain('ct=[-]');
  });

  it('un fichier absent échoue AVANT toute connexion, avec le code de curl', async () => {
    const out = await cli.executeCommand('curl -sS -T /tmp/pasla http://10.0.0.2:8080/ 2>&1');
    expect(out).toContain('curl: (26) Failed to open/read local data');
    expect(await cli.executeCommand('curl -s -T /tmp/pasla http://10.0.0.2:8080/ ; echo code=$?'))
      .toContain('code=26');
  });
});

describe('`--data-urlencode`', () => {
  it('n\'encode QUE la valeur d\'une paire `nom=valeur`', async () => {
    // Encoder le tout enverrait `a%3Db%20c`, que rien ne sait relire.
    expect(await cli.executeCommand('curl -s --data-urlencode "a=b c&d" http://10.0.0.2:8080/'))
      .toContain('corps=[a=b%20c%26d]');
  });

  it('encode en entier une chaîne sans `=`', async () => {
    expect(await cli.executeCommand('curl -s --data-urlencode "b c&d" http://10.0.0.2:8080/'))
      .toContain('corps=[b%20c%26d]');
  });

  it('fait un POST, comme `-d`', async () => {
    expect(await cli.executeCommand('curl -s --data-urlencode "a=1" http://10.0.0.2:8080/'))
      .toContain('POST');
  });
});

describe('`-D` — écrire les en-têtes reçus', () => {
  it('écrit le bloc d\'en-têtes dans le fichier', async () => {
    await cli.executeCommand('curl -s -D /tmp/hdr -o /tmp/corps http://10.0.0.2:8080/');
    const entetes = await cli.executeCommand('cat /tmp/hdr');
    expect(entetes).toContain('HTTP/1.1 200 OK');
    expect(entetes).toContain('X-Marque: oui');
  });

  it('n\'écrit pas le corps dans ce fichier — c\'est ce qui la distingue de `-i`', async () => {
    await cli.executeCommand('curl -s -D /tmp/hdr -o /tmp/corps http://10.0.0.2:8080/');
    expect(await cli.executeCommand('cat /tmp/hdr')).not.toContain('corps=[');
    expect(await cli.executeCommand('cat /tmp/corps')).toContain('corps=[');
  });
});

describe('les options encore absentes le disent toujours', () => {
  it('`-x` reste refusée', async () => {
    // Le garde-fou : ouvrir cinq portes ne doit pas faire croire que
    // les autres le sont. `--retry` et `-F` sont sorties de cette liste
    // en étant implémentées, et ce cas est tombé alors — son rôle.
    for (const option of ['-x']) {
      expect(await cli.executeCommand(`curl -s ${option} zorglub http://10.0.0.2:8080/`), option)
        .toContain(`curl: option ${option}: is not implemented in this simulator`);
    }
  });

  it('une option qui n\'existe pas garde le message de curl', async () => {
    expect(await cli.executeCommand('curl -s --zorglub http://10.0.0.2:8080/'))
      .toContain('curl: option --zorglub: is unknown');
  });
});
