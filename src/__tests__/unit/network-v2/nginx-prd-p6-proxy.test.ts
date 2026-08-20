/**
 * docs/PRD-Nginx.md §P6 — nginx en mandataire inverse.
 *
 * Le PRD annonçait « un chantier à part entière » au motif que nginx
 * devrait être client HTTP autant que serveur, donc asynchrone. La
 * mesure a corrigé la prémisse : la livraison des trames est SYNCHRONE
 * dans ce simulateur, si bien que `Http1ClientSession.send()` rend la
 * réponse de l'amont avant de revenir, et qu'un gestionnaire de requête
 * peut appeler l'amont EN LIGNE.
 *
 * Ce que ces cas vérifient : qu'une requête traverse réellement, que
 * les trois formes de réécriture du chemin sont celles de nginx, que
 * `proxy_set_header` agit, et surtout que les PANNES sont les bonnes —
 * un amont éteint donne un `502` et sa raison dans `error.log`, pas une
 * page vide ni un onglet figé.
 */

import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';

/**
 * `printf` passe par le shell, qui mange un `$` non protégé : sans
 * l'échappement, `proxy_set_header Host $host;` arrive dans le fichier
 * comme `proxy_set_header Host ;` et le cas ne mesure plus rien. C'est
 * arrivé, et le premier jet de ces tests concluait à tort que
 * `proxy_set_header` n'était pas appliqué.
 */
function ecrireConf(texte: string): string {
  const echappe = texte
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');
  return `sh -c 'printf "${echappe}" > /etc/nginx/sites-available/default'`;
}

interface Labo {
  front: LinuxServer;
  back: LinuxServer;
  /** Ce que l'amont a REÇU — un miroir vaut mieux qu'une page fixe. */
  vu: HttpMessage[];
}

function labo(): Labo {
  const front = new LinuxServer('linux-server', 'FRONT');
  const back = new LinuxServer('linux-server', 'BACK');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  front.powerOn();
  back.powerOn();
  new Cable('a').connect(front.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(back.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  front.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  back.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { front, back, vu: [] };
}

/** Un amont qui rend ce qu'il a reçu, pour que le cas puisse l'observer. */
function miroir(lab: Labo, port = 9000): void {
  new Http1ServerSession(lab.back.getTcpStack(), port, (req) => {
    lab.vu.push(req);
    const res = createResponse(200, 'OK');
    res.headers.set('Content-Type', 'text/plain');
    res.body = new TextEncoder().encode('miroir');
    return res;
  }).start();
}

async function demarrer(lab: Labo, conf: string): Promise<void> {
  await lab.front.executeCommand(ecrireConf(conf));
  await lab.front.executeCommand('systemctl restart nginx');
}

const PROXY_SIMPLE = `server {
  listen 80;
  location / {
    proxy_pass http://10.0.0.2:9000;
  }
}
`;

describe('§P6 — nginx mandataire inverse', () => {
  it('une requête traverse réellement jusqu\'à l\'amont', async () => {
    const lab = labo();
    await lab.back.executeCommand(ecrireConf(
      'server {\n  listen 8080;\n  root /var/www/html;\n  index index.html;\n}\n'));
    await lab.back.executeCommand(`sh -c 'printf "PAGE-AMONT" > /var/www/html/index.html'`);
    await lab.back.executeCommand('systemctl start nginx');

    await demarrer(lab, 'server {\n  listen 80;\n  location / {\n    proxy_pass http://10.0.0.2:8080;\n  }\n}\n');

    // Le client parle au FRONTAL et reçoit la page de l'AMONT : c'est
    // tout ce que « mandataire inverse » veut dire.
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/')).toContain('PAGE-AMONT');
  });

  it('un amont éteint rend 502, et la RAISON va dans error.log', async () => {
    const lab = labo();
    await demarrer(lab, PROXY_SIMPLE);

    const page = await lab.back.executeCommand('curl -s http://10.0.0.1/');
    expect(page).toContain('502 Bad Gateway');
    expect(page).toContain('nginx/');

    // La page ne dit pas POURQUOI — la vraie non plus. C'est le journal
    // qui l'apprend, et c'est là qu'on veut envoyer l'opérateur.
    const journal = await lab.front.executeCommand('cat /var/log/nginx/error.log');
    expect(journal).toContain('Connection refused');
    expect(journal).toContain('client: 10.0.0.2');
  });

  it('un 502 n\'écrit PAS de ligne « open() failed » — il n\'a ouvert aucun fichier', async () => {
    const lab = labo();
    await demarrer(lab, PROXY_SIMPLE);
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/'))
      .toContain('502 Bad Gateway');

    // Avant §P6, tout état ≥ 400 venait d'une recherche de fichier, donc
    // le journal en parlait toujours. Un 502 de mandataire ne vient pas
    // de là : la ligne aurait été une seconde explication, fausse.
    //
    // L'assertion POSITIVE ci-dessus est ce qui empêche ce cas de passer
    // à vide : sans elle, une version où le mandataire n'existe pas du
    // tout n'écrit rien et satisfait le `not.toContain` sans rien
    // prouver — mesuré par `git stash`.
    const journal = await lab.front.executeCommand('cat /var/log/nginx/error.log');
    expect(journal).toContain('Connection refused');
    expect(journal).not.toContain('open()');
  });

  it('un bloc `upstream` nomme la cible', async () => {
    const lab = labo();
    miroir(lab);
    await demarrer(lab, `upstream appli {
  server 10.0.0.2:9000;
}
server {
  listen 80;
  location / {
    proxy_pass http://appli;
  }
}
`);
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/')).toContain('miroir');
    expect(lab.vu).toHaveLength(1);
  });

  it('un membre `down` est ignoré et le suivant sert', async () => {
    const lab = labo();
    miroir(lab);
    await demarrer(lab, `upstream appli {
  server 10.0.0.9:9999 down;
  server 10.0.0.2:9000;
}
server {
  listen 80;
  location / {
    proxy_pass http://appli;
  }
}
`);
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/')).toContain('miroir');
  });

  describe('la réécriture du chemin suit la règle de nginx', () => {
    // La règle la plus mal comprise de `proxy_pass` : c'est la PRÉSENCE
    // d'un chemin dans l'URI qui décide, pas sa valeur.
    const cas: Array<[string, string, string]> = [
      ['sans chemin, l\'URI passe telle quelle', 'http://10.0.0.2:9000', '/api/v1'],
      ['avec `/`, le préfixe de la location est REMPLACÉ', 'http://10.0.0.2:9000/', '/v1'],
      ['avec un préfixe, il se substitue', 'http://10.0.0.2:9000/backend', '/backend/v1'],
    ];
    for (const [nom, pass, attendu] of cas) {
      it(nom, async () => {
        const lab = labo();
        miroir(lab);
        await demarrer(lab, `server {
  listen 80;
  location /api/ {
    proxy_pass ${pass};
  }
}
`);
        await lab.back.executeCommand('curl -s http://10.0.0.1/api/v1');
        expect(lab.vu).toHaveLength(1);
        expect(lab.vu[0].target).toBe(attendu);
      });
    }
  });

  it('par défaut `Host` devient l\'autorité de l\'amont', async () => {
    const lab = labo();
    miroir(lab);
    await demarrer(lab, PROXY_SIMPLE);
    await lab.back.executeCommand('curl -s http://10.0.0.1/');
    expect(lab.vu[0].headers.get('Host')).toBe('10.0.0.2:9000');
  });

  it('`proxy_set_header Host $host` le préserve — c\'est à cela qu\'il sert', async () => {
    const lab = labo();
    miroir(lab);
    await demarrer(lab, `server {
  listen 80;
  location / {
    proxy_pass http://10.0.0.2:9000;
    proxy_set_header Host $host;
  }
}
`);
    await lab.back.executeCommand('curl -s http://10.0.0.1/');
    expect(lab.vu[0].headers.get('Host')).toBe('10.0.0.1');
  });

  it('`$remote_addr` est l\'adresse RÉELLE du client', async () => {
    const lab = labo();
    miroir(lab);
    await demarrer(lab, `server {
  listen 80;
  location / {
    proxy_pass http://10.0.0.2:9000;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
`);
    await lab.back.executeCommand('curl -s http://10.0.0.1/');
    // Ni `0.0.0.0` ni `-` : le gestionnaire de requête ignorait qui
    // l'appelait, la socket le sachant. Un `X-Real-IP` qui ne porte pas
    // l'adresse réelle n'apprend rien de ce que cet en-tête existe pour.
    expect(lab.vu[0].headers.get('X-Real-IP')).toBe('10.0.0.2');
    expect(lab.vu[0].headers.get('X-Forwarded-Proto')).toBe('http');
  });

  it('`$proxy_add_x_forwarded_for` EMPILE le client derrière la chaîne reçue', async () => {
    const lab = labo();
    miroir(lab);
    await demarrer(lab, `server {
  listen 80;
  location / {
    proxy_pass http://10.0.0.2:9000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
`);
    await lab.back.executeCommand(
      `curl -s -H "X-Forwarded-For: 192.0.2.7" http://10.0.0.1/`);
    expect(lab.vu[0].headers.get('X-Forwarded-For')).toBe('192.0.2.7, 10.0.0.2');
  });

  it('les en-têtes saut-par-saut ne sont pas relayés (RFC 9110 §7.6.1)', async () => {
    const lab = labo();
    miroir(lab);
    await demarrer(lab, PROXY_SIMPLE);
    await lab.back.executeCommand(`curl -s -H "Connection: close" http://10.0.0.1/`);
    expect(lab.vu[0].headers.get('Connection')).toBeUndefined();
  });

  it('le journal d\'accès nomme le client', async () => {
    const lab = labo();
    miroir(lab);
    await demarrer(lab, PROXY_SIMPLE);
    await lab.back.executeCommand('curl -s http://10.0.0.1/');
    const acces = await lab.front.executeCommand('cat /var/log/nginx/access.log');
    expect(acces).toContain('10.0.0.2 - -');
  });

  it('une boucle de mandat s\'arrête, au lieu de figer l\'onglet', async () => {
    const lab = labo();
    // nginx se mandate lui-même. La livraison étant synchrone, sans
    // borne c'est une récursion infinie — un vrai nginx boucle aussi,
    // mais il finit par épuiser ses connexions ; ici il n'y a rien à
    // épuiser, donc la borne est explicite.
    await demarrer(lab, 'server {\n  listen 80;\n  location / {\n    proxy_pass http://10.0.0.1:80;\n  }\n}\n');
    const page = await lab.back.executeCommand('curl -s http://10.0.0.1/');
    expect(page).toContain('502 Bad Gateway');
    expect(await lab.front.executeCommand('cat /var/log/nginx/error.log'))
      .toContain('proxy loop detected');
  });

  it('un amont `https` est refusé plutôt que parlé en clair', async () => {
    const lab = labo();
    await demarrer(lab, 'server {\n  listen 80;\n  location / {\n    proxy_pass https://10.0.0.2:9000;\n  }\n}\n');
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/')).toContain('502 Bad Gateway');
    expect(await lab.front.executeCommand('cat /var/log/nginx/error.log'))
      .toContain('https upstreams are not supported');
  });

  it('un nom d\'amont introuvable donne 502 et le dit', async () => {
    const lab = labo();
    await demarrer(lab, 'server {\n  listen 80;\n  location / {\n    proxy_pass http://nexistepas.lan;\n  }\n}\n');
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/')).toContain('502 Bad Gateway');
    expect(await lab.front.executeCommand('cat /var/log/nginx/error.log'))
      .toContain('nexistepas.lan could not be resolved');
  });

  it('un nom résolu par /etc/hosts atteint l\'amont', async () => {
    const lab = labo();
    miroir(lab);
    // Le mandataire résout par la MACHINE qui l'exécute : c'est son
    // `/etc/hosts` qui décide, comme pour le vrai nginx.
    await lab.front.executeCommand(
      `sh -c 'printf "10.0.0.2 appli.lan\\n" >> /etc/hosts'`);
    await demarrer(lab, 'server {\n  listen 80;\n  location / {\n    proxy_pass http://appli.lan:9000;\n  }\n}\n');
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/')).toContain('miroir');
  });

  describe('`nginx -t` juge la configuration du mandataire', () => {
    it('une URL qu\'il ne sait pas lire est refusée avec le message de nginx', async () => {
      const lab = labo();
      await lab.front.executeCommand(ecrireConf(
        'server {\n  listen 80;\n  location / {\n    proxy_pass zorglub;\n  }\n}\n'));
      const out = await lab.front.executeCommand('nginx -t');
      expect(out).toContain('invalid URL prefix in "zorglub"');
      expect(out).toContain('test failed');
    });

    it('`proxy_pass` hors d\'une `location` est refusée', async () => {
      const lab = labo();
      await lab.front.executeCommand(ecrireConf(
        'server {\n  listen 80;\n  proxy_pass http://10.0.0.2:9000;\n}\n'));
      const out = await lab.front.executeCommand('nginx -t');
      expect(out).toContain('"proxy_pass" directive is not allowed here');
    });

    it('`server` hors d\'un `upstream` reste un BLOC', async () => {
      const lab = labo();
      await lab.front.executeCommand(ecrireConf(
        'upstream a {\n  server 10.0.0.2:9000;\n}\nserver 1.2.3.4;\n'));
      const out = await lab.front.executeCommand('nginx -t');
      expect(out).toContain('"server" directive is not allowed here');
    });

    it('une configuration de mandataire correcte passe', async () => {
      const lab = labo();
      await lab.front.executeCommand(ecrireConf(`upstream appli {
  server 10.0.0.2:9000;
}
server {
  listen 80;
  location / {
    proxy_pass http://appli;
    proxy_set_header Host $host;
  }
}
`));
      expect(await lab.front.executeCommand('nginx -t')).toContain('test is successful');
    });
  });
});

describe('une machine s\'atteint elle-même par sa PROPRE adresse', () => {
  it('curl vers sa propre adresse joint le serveur local', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    srv.powerOn();
    new Cable('a').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    await srv.executeCommand('systemctl start nginx');

    // Sur un vrai Linux la table de routage `local` porte une entrée
    // `local <adresse> dev lo` pour chaque adresse configurée. Seule la
    // boucle locale était traitée ici : `curl 127.0.0.1` répondait et
    // `curl 10.0.0.2` restait sur « Trying… » indéfiniment, sur la
    // machine même qui exécute le serveur.
    expect(await srv.executeCommand('curl -s http://127.0.0.1/')).toContain('Welcome to nginx');
    expect(await srv.executeCommand('curl -s http://10.0.0.2/')).toContain('Welcome to nginx');
  });
});

describe('§5 — les paramètres de `listen`, rangés en trois familles', () => {
  async function juger(ligne: string): Promise<string> {
    const s = new LinuxServer('linux-server', 'SRV');
    s.powerOn();
    await s.executeCommand(ecrireConf(`server {\n  ${ligne}\n  root /var/www/html;\n}\n`));
    return s.executeCommand('nginx -t');
  }

  it('`http2` est REFUSÉ, au lieu d\'être accepté en servant du HTTP/1.1', async () => {
    // Le cas le plus trompeur des trois familles : un opérateur qui a
    // écrit `http2` croit tenir du HTTP/2, et rien dans la machine ne
    // le détrompait — le paramètre n'était lu par personne.
    const out = await juger('listen 443 ssl http2;');
    expect(out).toContain('the "http2" parameter of the "listen" directive is not supported');
    expect(out).toContain('test failed');
  });

  it('`proxy_protocol` est refusé pour la même raison', async () => {
    // Il change le format sur le fil ET la provenance de l'adresse du
    // client : l'accepter sans le produire fausserait `$remote_addr`.
    expect(await juger('listen 80 proxy_protocol;'))
      .toContain('the "proxy_protocol" parameter of the "listen" directive is not supported');
  });

  it('un paramètre qui n\'existe pas reçoit le message de nginx', async () => {
    const out = await juger('listen 80 zorglub;');
    expect(out).toContain('invalid parameter "zorglub"');
    expect(out).not.toContain('not supported by this simulator');
  });

  it('les réglages de socket réels sont acceptés, comme dans toute configuration réelle', async () => {
    for (const ligne of [
      'listen 80 backlog=511;', 'listen 80 deferred;',
      'listen 80 reuseport;', 'listen 80 ipv6only=on;',
    ]) {
      expect(await juger(ligne), ligne).toContain('test is successful');
    }
  });

  it('un paramètre à valeur écrit sans sa valeur est refusé', async () => {
    expect(await juger('listen 80 backlog;')).toContain('invalid parameter "backlog"');
  });

  it('`default_server` et `ssl` continuent d\'agir', async () => {
    expect(await juger('listen 80 default_server;')).toContain('test is successful');
    expect(await juger('listen [::]:80 default_server;')).toContain('test is successful');
  });
});
