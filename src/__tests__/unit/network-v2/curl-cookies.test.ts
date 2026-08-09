/**
 * `curl -b` / `-c` — les témoins, et la porte d'un moteur qui n'en
 * avait pas.
 *
 * `docs/PRD-Curl.md` §P4 rangeait les témoins avec le proxy et les
 * formulaires, « à traiter seulement si un TP les demande ». La mesure
 * a changé le calcul : `src/network/http/cookies/` contient un moteur
 * RFC 6265 **complet** — correspondance de domaine et de chemin,
 * `Secure`, `HttpOnly`, `SameSite`, `Max-Age`, `Expires` — et **aucun
 * appelant hors de son propre répertoire**. Ce n'était donc pas une
 * fonctionnalité à écrire mais une porte à ouvrir, sur un code que
 * rien n'avait jamais vérifié.
 *
 * Ces cas mesurent le comportement OBSERVABLE : ce que le serveur
 * reçoit. Un serveur miroir rapporte l'en-tête `Cookie` dans son
 * corps, si bien qu'aucune assertion ne porte sur l'état interne du
 * bocal — un témoin stocké et jamais envoyé ne prouverait rien.
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
});

/**
 * Un serveur qui pose `setCookie` et RAPPORTE l'en-tête `Cookie` reçu.
 * C'est le rapport qui fait la mesure : sans lui on ne vérifierait que
 * l'état d'un bocal, c'est-à-dire rien d'observable.
 */
function miroir(port: number, setCookie?: string): void {
  new Http1ServerSession(srv.getTcpStack(), port, (req) => {
    const r = createResponse(200, 'OK');
    r.headers.set('Content-Type', 'text/plain');
    if (setCookie) r.headers.set('Set-Cookie', setCookie);
    r.body = new TextEncoder().encode(`recu:[${req.headers.get('Cookie') ?? 'rien'}]`);
    return r;
  }).start();
}

describe('§P4 — `-c` garde, `-b` renvoie', () => {
  it('sans option, aucun témoin ne part', async () => {
    miroir(8080, 'sid=abc123; Path=/; Max-Age=3600');
    expect(await cli.executeCommand('curl -s http://10.0.0.2:8080/')).toContain('recu:[rien]');
  });

  it('`-c` écrit un vrai fichier au format Netscape', async () => {
    miroir(8080, 'sid=abc123; Path=/; Max-Age=3600');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');

    const bocal = await cli.executeCommand('cat /tmp/jar');
    // Le format est celui de curl parce que `-b` doit pouvoir le relire :
    // un `-c` qui écrirait un format à lui produirait un fichier que
    // rien ne consomme.
    expect(bocal).toContain('# Netscape HTTP Cookie File');
    expect(bocal).toMatch(/10\.0\.0\.2\tFALSE\t\/\tFALSE\t\d+\tsid\tabc123/);
  });

  it('`-b` relit le bocal et le renvoie au serveur', async () => {
    miroir(8080, 'sid=abc123; Path=/; Max-Age=3600');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    expect(await cli.executeCommand('curl -s -b /tmp/jar http://10.0.0.2:8080/'))
      .toContain('recu:[sid=abc123]');
  });

  it('l\'échéance d\'un `Max-Age` survit à l\'écriture', async () => {
    // `Cookie.expires` est vide quand le témoin vient d'un `Max-Age` :
    // sérialiser depuis là en aurait fait un témoin de SESSION, qui
    // disparaît à la relecture. C'est `expiryMs` qui porte l'échéance.
    miroir(8080, 'sid=abc123; Path=/; Max-Age=3600');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    const ligne = (await cli.executeCommand('cat /tmp/jar'))
      .split('\n').find((l) => l.includes('sid'))!;
    expect(Number(ligne.split('\t')[4])).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('`-b` accepte aussi une chaîne littérale', async () => {
    miroir(8080);
    // curl distingue les deux formes exactement ainsi : un argument
    // contenant `=` est une chaîne, tout le reste est un fichier.
    expect(await cli.executeCommand('curl -s -b "manuel=oui" http://10.0.0.2:8080/'))
      .toContain('recu:[manuel=oui]');
  });

  it('plusieurs témoins littéraux partent ensemble', async () => {
    miroir(8080);
    const out = await cli.executeCommand('curl -s -b "a=1; b=2" http://10.0.0.2:8080/');
    expect(out).toContain('a=1');
    expect(out).toContain('b=2');
  });

  it('un fichier de bocal absent n\'est pas une erreur', async () => {
    miroir(8080);
    // C'est le cas NORMAL du premier appel d'une séquence
    // `-b jar -c jar`, que tout script écrit ainsi.
    const out = await cli.executeCommand('curl -s -b /tmp/pasla http://10.0.0.2:8080/');
    expect(out).toContain('recu:[rien]');
    expect(out).not.toContain('curl:');
  });

  it('`-v` montre l\'en-tête `Cookie` qui part', async () => {
    miroir(8080, 'sid=abc123; Path=/; Max-Age=3600');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    expect(await cli.executeCommand('curl -sv -b /tmp/jar http://10.0.0.2:8080/ 2>&1'))
      .toContain('> Cookie: sid=abc123');
  });
});

describe('§P4 — le bocal vit pendant tout le transfert', () => {
  it('un témoin posé par une redirection part avec la requête suivante', async () => {
    // Le cas d'usage même de l'option : une session s'ouvre par un
    // `302` qui pose le témoin, et la page d'après doit le porter. Le
    // récolter seulement sur la réponse FINALE le perdrait.
    new Http1ServerSession(srv.getTcpStack(), 8090, (req) => {
      if ((req.target ?? '/') === '/login') {
        const r = createResponse(302, 'Found');
        r.headers.set('Set-Cookie', 'session=xyz; Path=/');
        r.headers.set('Location', '/accueil');
        r.headers.set('Content-Length', '0');
        return r;
      }
      const r = createResponse(200, 'OK');
      r.headers.set('Content-Type', 'text/plain');
      r.body = new TextEncoder().encode(`accueil:[${req.headers.get('Cookie') ?? 'rien'}]`);
      return r;
    }).start();

    expect(await cli.executeCommand('curl -sL http://10.0.0.2:8090/login'))
      .toContain('accueil:[session=xyz]');
  });
});

describe('§P4 — le bocal FILTRE, il ne récite pas', () => {
  it('un témoin d\'un autre chemin ne part pas', async () => {
    miroir(8080, 'admin=1; Path=/admin');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    // C'est ce filtrage qui distingue un témoin d'une simple chaîne
    // d'en-tête : `-H "Cookie: …"` serait envoyé partout.
    expect(await cli.executeCommand('curl -s -b /tmp/jar http://10.0.0.2:8080/'))
      .toContain('recu:[rien]');
  });

  it('un témoin `Secure` ne part pas en clair', async () => {
    miroir(8080, 'tok=s3cr3t; Path=/; Secure');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    // La quatrième colonne du format Netscape EST le drapeau `Secure`.
    const ligne = (await cli.executeCommand('cat /tmp/jar'))
      .split('\n').find((l) => l.includes('tok'))!;
    expect(ligne.split('\t')[3]).toBe('TRUE');
    expect(await cli.executeCommand('curl -s -b /tmp/jar http://10.0.0.2:8080/'))
      .toContain('recu:[rien]');
  });

  it('un témoin expiré n\'est ni gardé ni renvoyé', async () => {
    miroir(8080, 'vieux=x; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    expect(await cli.executeCommand('cat /tmp/jar')).not.toContain('vieux');
  });

  it('`HttpOnly` est conservé avec la marque de curl', async () => {
    miroir(8080, 'sess=z; Path=/; HttpOnly');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    // curl préfixe le domaine par `#HttpOnly_`, ce qui ressemble à un
    // commentaire et n'en est pas — un lecteur naïf perdrait le témoin.
    expect(await cli.executeCommand('cat /tmp/jar')).toContain('#HttpOnly_10.0.0.2');
    expect(await cli.executeCommand('curl -s -b /tmp/jar http://10.0.0.2:8080/'))
      .toContain('recu:[sess=z]');
  });
});

describe('§P4 — ce que la ligne de commande accepte', () => {
  it('`--cookie` et `--cookie-jar` valent `-b` et `-c`', async () => {
    miroir(8080, 'sid=abc; Path=/');
    await cli.executeCommand('curl -s --cookie-jar /tmp/jar http://10.0.0.2:8080/');
    expect(await cli.executeCommand('curl -s --cookie /tmp/jar http://10.0.0.2:8080/'))
      .toContain('recu:[sid=abc]');
  });

  it('les options du §P4 encore absentes restent refusées, et le disent', async () => {
    // Le garde-fou du lot : ouvrir la porte des témoins ne doit pas
    // faire croire que le reste de §P4 est là.
    for (const option of ['-x', '--retry', '-F']) {
      expect(await cli.executeCommand(`curl -s ${option} zorglub http://10.0.0.2:8080/`), option)
        .toContain(`curl: option ${option}: is not implemented in this simulator`);
    }
  });
});
