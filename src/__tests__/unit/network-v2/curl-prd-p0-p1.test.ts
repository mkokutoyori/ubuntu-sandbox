/**
 * docs/PRD-Curl.md §P0 (honnêteté) et §P1 (la commande devient scriptable).
 *
 * Le transport de `curl` était déjà réel — vraie pile TCP, vrais câbles,
 * vraies ACL. Ce qui manquait tenait dans deux phrases : **`-s` et `-v`
 * étaient parsés puis jetés** (`continue` dans la boucle d'arguments), et
 * **`run` rendait une `string`**, donc la commande n'avait aucun code de
 * sortie et `curl … || echo KO` ne pouvait pas fonctionner.
 *
 * C'est le motif que ce projet a déjà corrigé quatre fois ailleurs — `df`,
 * `ulimit -u`, `ulimit -n`, `MemoryMax=` : une option affichée que rien
 * n'honore. Ici c'était plus insidieux encore, puisqu'il n'y avait même pas
 * de valeur à lire, juste un silence.
 *
 * Le serveur de ces tests est un vrai `Http1ServerSession` sur la pile TCP
 * d'une vraie machine, joint par un vrai câble : aucune réponse n'est
 * fabriquée localement. C'est ce qui distingue ces cas de l'ancien
 * `cmdCurl`, supprimé ici, qui répondait `<h1>It works!</h1>` à tout
 * `curl localhost` sur une machine où rien n'écoutait.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';

const SRV_IP = '10.40.0.10';
const CLI_IP = '10.40.0.20';
const PORT = 8080;

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

interface Lab {
  client: LinuxPC;
  serve(handler: (req: HttpMessage) => HttpMessage): void;
  seen(): HttpMessage[];
}

function lab(): Lab {
  const server = new LinuxServer('linux-server', 'WEB');
  const client = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SRV_IP), mask);
  client.getPorts()[0].configureIP(new IPAddress(CLI_IP), mask);
  server.powerOn();
  client.powerOn();

  const requests: HttpMessage[] = [];
  return {
    client,
    serve(handler) {
      const session = new Http1ServerSession(server.getTcpStack(), PORT, (req) => {
        requests.push(req);
        return handler(req);
      });
      session.start();
    },
    seen: () => requests,
  };
}

function page(body: string, status = 200, reason = 'OK'): HttpMessage {
  const res = createResponse(status, reason);
  res.headers.set('Server', 'nginx/1.24.0');
  res.headers.set('Content-Type', 'text/html');
  res.body = new TextEncoder().encode(body);
  return res;
}

const url = (path = '/') => `http://${SRV_IP}:${PORT}${path}`;

describe('§P0 — aucune option acceptée n\'est sans effet observable', () => {
  it('une option inconnue est refusée avec le message de curl, pas avalée', async () => {
    const { client } = lab();

    const out = await client.executeCommand(`curl -Z ${url()}`);

    expect(out).toContain('curl: option -Z: is unknown');
    expect(out).toContain("curl: try 'curl --help' for more information");
    expect((await client.executeCommand('echo $?')).trim()).toBe('2');
  });

  it('une option que curl connaît mais que ce simulateur n\'implémente pas est refusée en le disant', async () => {
    const { client } = lab();

    // `curl: option -x: is unknown` serait faux dans l'autre sens : curl
    // connaît parfaitement `-x`. Le refus doit dire ce qui est vrai.
    const out = await client.executeCommand(`curl -x http://proxy:3128 ${url()}`);

    expect(out).toContain('curl: option -x: is not implemented in this simulator');
    expect(out).not.toContain('is unknown');
  });

  it('un protocole que ce simulateur n\'héberge pas est refusé, pas simulé', async () => {
    const { client } = lab();

    const out = await client.executeCommand('curl ftp://ftp.example.com/pub/file');

    expect(out).toContain('curl: (1) Protocol "ftp" not supported or disabled in libcurl');
    expect((await client.executeCommand('echo $?')).trim()).toBe('1');
  });

  it('sans URL, curl renvoie sa ligne d\'usage et sort en 2', async () => {
    const { client } = lab();

    expect(await client.executeCommand('curl'))
      .toContain("curl: try 'curl --help' for more information");
    expect((await client.executeCommand('echo $?')).trim()).toBe('2');
  });
});

describe('§P1 — le code de sortie fait partie de la commande', () => {
  it('un transfert réussi sort en 0 et rend le corps servi par le vrai serveur', async () => {
    const l = lab();
    l.serve(() => page('<h1>real</h1>'));

    const out = await l.client.executeCommand(`curl ${url()}`);

    expect(out).toContain('<h1>real</h1>');
    expect((await l.client.executeCommand('echo $?')).trim()).toBe('0');
  });

  it('rien n\'écoute : (7) et code 7, sur la vraie pile TCP', async () => {
    const { client } = lab();

    const out = await client.executeCommand(`curl ${url()}`);

    expect(out).toContain(`curl: (7) Failed to connect to ${SRV_IP} port ${PORT}: Connection refused`);
    expect((await client.executeCommand('echo $?')).trim()).toBe('7');
  });

  it('nom introuvable : (6) et code 6', async () => {
    const { client } = lab();

    const out = await client.executeCommand('curl http://nowhere.invalid/');

    expect(out).toContain('curl: (6) Could not resolve host: nowhere.invalid');
    expect((await client.executeCommand('echo $?')).trim()).toBe('6');
  });

  it('`curl … || echo KO` se comporte comme sur une vraie machine, dans les deux issues', async () => {
    const l = lab();

    // Avant ce chantier, `run()` rendait une string : $? valait toujours 0
    // et cette ligne n'imprimait jamais KO, quoi qu'il arrive.
    expect(await l.client.executeCommand(`curl -sS ${url()} || echo KO`)).toContain('KO');

    l.serve(() => page('ok'));
    expect(await l.client.executeCommand(`curl -s ${url()} || echo KO`)).not.toContain('KO');
  });
});

describe('§P1 — `-f` : un 404 devient un échec', () => {
  it('sans -f, un 404 est un transfert réussi qui rend la page d\'erreur', async () => {
    const l = lab();
    l.serve(() => page('<h1>404</h1>', 404, 'Not Found'));

    const out = await l.client.executeCommand(`curl ${url('/absent')}`);

    expect(out).toContain('<h1>404</h1>');
    expect((await l.client.executeCommand('echo $?')).trim()).toBe('0');
  });

  it('avec -f, le corps est supprimé et le code de sortie est 22', async () => {
    const l = lab();
    l.serve(() => page('<h1>404</h1>', 404, 'Not Found'));

    const out = await l.client.executeCommand(`curl -f ${url('/absent')}`);

    expect(out).not.toContain('<h1>404</h1>');
    expect(out).toContain('curl: (22) The requested URL returned error: 404');
    expect((await l.client.executeCommand('echo $?')).trim()).toBe('22');
  });
});

describe('§P1 — `-s` / `-S` : le silence, et comment le rompre', () => {
  it('-s tait l\'erreur mais garde le code de sortie', async () => {
    const { client } = lab();

    const out = await client.executeCommand(`curl -s ${url()}`);

    expect(out.trim()).toBe('');
    expect((await client.executeCommand('echo $?')).trim()).toBe('7');
  });

  it('-sS rétablit l\'erreur : c\'est l\'idiome réel', async () => {
    const { client } = lab();

    expect(await client.executeCommand(`curl -sS ${url()}`)).toContain('curl: (7)');
  });

  it('-s ne tait pas la sortie normale', async () => {
    const l = lab();
    l.serve(() => page('body'));

    expect(await l.client.executeCommand(`curl -s ${url()}`)).toContain('body');
  });
});

describe('§P1 — `-v` écrit sur stderr, et c\'est ce qui le distingue d\'une imitation', () => {
  it('le dialogue apparaît au terminal, requête et réponse', async () => {
    const l = lab();
    l.serve(() => page('hello'));

    const out = await l.client.executeCommand(`curl -v ${url()}`);

    expect(out).toContain(`*   Trying ${SRV_IP}:${PORT}...`);
    expect(out).toContain(`* Connected to ${SRV_IP} (${SRV_IP}) port ${PORT}`);
    expect(out).toContain('> GET / HTTP/1.1');
    expect(out).toContain(`> Host: ${SRV_IP}:${PORT}`);
    expect(out).toContain('> User-Agent: curl/8.5.0');
    expect(out).toContain('< HTTP/1.1 200 OK');
    expect(out).toContain('< Server: nginx/1.24.0');
    expect(out).toContain('hello');
  });

  it('`curl -v url > f` ne met QUE le corps dans le fichier', async () => {
    const l = lab();
    l.serve(() => page('payload-only'));

    // Le détail qui compte : le dialogue part sur fd 2, donc la
    // redirection de stdout ne l'emporte pas. Une trace écrite sur stdout
    // polluerait le fichier — c'est ce qui sépare une vraie implémentation
    // d'une imitation.
    await l.client.executeCommand(`curl -v ${url()} > /tmp/body.html`);
    const file = await l.client.executeCommand('cat /tmp/body.html');

    expect(file).toContain('payload-only');
    expect(file).not.toContain('> GET /');
    expect(file).not.toContain('* Connected to');
  });
});

describe('§P1 — `-o` / `-O` : écrire dans un fichier', () => {
  it('-o écrit le corps et n\'imprime rien', async () => {
    const l = lab();
    l.serve(() => page('to-file'));

    const out = await l.client.executeCommand(`curl -o /tmp/page.html ${url()}`);

    expect(out.trim()).toBe('');
    expect(await l.client.executeCommand('cat /tmp/page.html')).toContain('to-file');
  });

  it('-O prend le nom de la ressource distante', async () => {
    const l = lab();
    l.serve(() => page('named'));

    await l.client.executeCommand(`cd /tmp && curl -O ${url('/report.txt')}`);

    expect(await l.client.executeCommand('cat /tmp/report.txt')).toContain('named');
  });

  it('-O sur une URL sans nom de fichier échoue comme le vrai curl', async () => {
    const l = lab();
    l.serve(() => page('x'));

    const out = await l.client.executeCommand(`curl -O ${url('/')}`);

    expect(out).toContain('curl: Remote filename has no length!');
    expect((await l.client.executeCommand('echo $?')).trim()).toBe('23');
  });
});

describe('§P1 — `-w` : le mode script', () => {
  it('%{http_code} est le code réellement renvoyé par le serveur', async () => {
    const l = lab();
    l.serve(() => page('x', 503, 'Service Unavailable'));

    const out = await l.client.executeCommand(`curl -s -o /dev/null -w "%{http_code}\\n" ${url()}`);

    expect(out.trim()).toBe('503');
  });

  it('les autres variables décrivent le transfert qui a vraiment eu lieu', async () => {
    const l = lab();
    l.serve(() => page('12345'));

    const out = await l.client.executeCommand(
      `curl -s -o /dev/null -w "%{remote_ip}|%{remote_port}|%{size_download}|%{content_type}|%{method}\\n" ${url()}`,
    );

    expect(out.trim()).toBe(`${SRV_IP}|${PORT}|5|text/html|GET`);
  });

  it('une variable inconnue est signalée, pas inventée', async () => {
    const l = lab();
    l.serve(() => page('x'));

    const out = await l.client.executeCommand(`curl -s -o /dev/null -w "%{no_such_thing}" ${url()}`);

    expect(out).toContain("curl: unknown --write-out variable: 'no_such_thing'");
  });
});

describe('§P1 — `-I` envoie une VRAIE requête HEAD', () => {
  it('le serveur reçoit HEAD, et la sortie est la ligne de statut plus les en-têtes', async () => {
    const l = lab();
    l.serve(() => page('<h1>body</h1>'));

    const out = await l.client.executeCommand(`curl -I ${url()}`);

    expect(l.seen()[0].method).toBe('HEAD');
    expect(out).toContain('HTTP/1.1 200 OK');
    expect(out).toContain('Server: nginx/1.24.0');
    expect(out).not.toContain('<h1>body</h1>');
  });

  it('-i garde le corps ET montre les en-têtes, en GET', async () => {
    const l = lab();
    l.serve(() => page('<h1>body</h1>'));

    const out = await l.client.executeCommand(`curl -i ${url()}`);

    expect(l.seen()[0].method).toBe('GET');
    expect(out).toContain('HTTP/1.1 200 OK');
    expect(out).toContain('<h1>body</h1>');
  });
});

describe('la commande n\'invente plus de réponse pour localhost', () => {
  it('`curl localhost` sur une machine où rien n\'écoute est un refus', async () => {
    const { client } = lab();

    // L'ancien `cmdCurl` répondait `<h1>It works!</h1>` — une page servie
    // par personne. C'est exactement le mensonge que le PRD supprime.
    const out = await client.executeCommand('curl localhost');

    expect(out).not.toContain('It works');
    expect(out).toContain('curl: (7) Failed to connect to localhost port 80');
  });
});
