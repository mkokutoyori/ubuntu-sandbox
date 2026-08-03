/**
 * docs/PRD-Curl.md §P2 (verbes et en-têtes) et §P3 (authentification,
 * résolution forcée).
 *
 * Le PRD demandait explicitement de cadrer P2 AVANT de l'écrire : « inutile
 * d'offrir `-X DELETE` si aucun serveur du simulateur ne distingue les
 * méthodes ». Le cadrage a donné ceci — et il a mené à une correction du
 * seul serveur HTTP livré avec le produit :
 *
 *   - `Http1ServerSession` transporte déjà la méthode, le corps et les
 *     en-têtes réels : `-X`, `-d`, `-H` n'ont rien à inventer, ils
 *     remplissent une requête qui part vraiment sur le câble ;
 *   - `WindowsIisRole.buildResponse()`, en revanche, IGNORAIT la méthode et
 *     servait le fichier pour un `DELETE` comme pour un `GET`. Un serveur
 *     statique réel répond `405` avec un en-tête `Allow`. C'est corrigé
 *     ici, sinon `-X` aurait été une option acceptée sans effet observable
 *     — exactement ce que §P0 interdit ;
 *   - `-L` a un vrai producteur de redirections
 *     (`createHttpToHttpsRedirectHandler`, et n'importe quel handler qui
 *     pose un `Location`), donc il suit une vraie chaîne sur le réseau.
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
import { verifyBasicCredentials } from '@/network/http/auth/BasicAuth';

const SRV_IP = '10.41.0.10';
const CLI_IP = '10.41.0.20';
const PORT = 8080;
const ALT_PORT = 8081;

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

interface Lab {
  client: LinuxPC;
  serve(port: number, handler: (req: HttpMessage) => HttpMessage): void;
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
    serve(port, handler) {
      new Http1ServerSession(server.getTcpStack(), port, (req) => {
        requests.push(req);
        return handler(req);
      }).start();
    },
    seen: () => requests,
  };
}

function ok(body = 'ok'): HttpMessage {
  const res = createResponse(200, 'OK');
  res.headers.set('Content-Type', 'text/plain');
  res.body = new TextEncoder().encode(body);
  return res;
}

function bodyText(req: HttpMessage): string {
  return req.body ? new TextDecoder().decode(req.body) : '';
}

const url = (path = '/', port = PORT) => `http://${SRV_IP}:${port}${path}`;

describe('§P2 — `-X` : la méthode part vraiment sur le câble', () => {
  it('le serveur reçoit le verbe demandé, pas un GET', async () => {
    const l = lab();
    l.serve(PORT, () => createResponse(204, 'No Content'));

    await l.client.executeCommand(`curl -s -X DELETE ${url('/thing')}`);

    expect(l.seen()[0].method).toBe('DELETE');
    expect(l.seen()[0].target).toBe('/thing');
  });

  it('un verbe que la couche HTTP ne connaît pas ne fabrique pas une requête muette', async () => {
    const l = lab();
    l.serve(PORT, () => ok());

    await l.client.executeCommand(`curl -s -X BREW ${url()}`);

    expect(l.seen()[0].method).toBe('GET');
  });
});

describe('§P2 — `-d` : un corps de requête réel', () => {
  it('-d implique POST, pose le Content-Type et transporte le corps', async () => {
    const l = lab();
    l.serve(PORT, () => createResponse(201, 'Created'));

    await l.client.executeCommand(`curl -s -d "name=alice" ${url('/users')}`);

    const req = l.seen()[0];
    expect(req.method).toBe('POST');
    expect(req.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(bodyText(req)).toBe('name=alice');
  });

  it('plusieurs -d sont joints par & comme le fait curl', async () => {
    const l = lab();
    l.serve(PORT, () => ok());

    await l.client.executeCommand(`curl -s -d "a=1" -d "b=2" ${url()}`);

    expect(bodyText(l.seen()[0])).toBe('a=1&b=2');
  });

  it('-X garde la main sur la méthode que -d aurait choisie', async () => {
    const l = lab();
    l.serve(PORT, () => ok());

    await l.client.executeCommand(`curl -s -X PUT -d "v=1" ${url()}`);

    expect(l.seen()[0].method).toBe('PUT');
    expect(bodyText(l.seen()[0])).toBe('v=1');
  });
});

describe('§P2 — `-H` : les en-têtes arrivent intacts', () => {
  it('un en-tête arbitraire traverse le réseau', async () => {
    const l = lab();
    l.serve(PORT, () => ok());

    await l.client.executeCommand(`curl -s -H "X-Trace: abc123" ${url()}`);

    expect(l.seen()[0].headers.get('X-Trace')).toBe('abc123');
  });

  it('-H remplace un en-tête que curl pose lui-même', async () => {
    const l = lab();
    l.serve(PORT, () => ok());

    await l.client.executeCommand(`curl -s -H "User-Agent: probe/1.0" ${url()}`);

    expect(l.seen()[0].headers.get('User-Agent')).toBe('probe/1.0');
  });

  it('un en-tête sans valeur RETIRE celui que curl aurait envoyé', async () => {
    const l = lab();
    l.serve(PORT, () => ok());

    await l.client.executeCommand(`curl -s -H "Accept:" ${url()}`);

    expect(l.seen()[0].headers.has('Accept')).toBe(false);
  });
});

describe('§P2 — `-L` : suivre une vraie redirection sur le réseau', () => {
  function redirectTo(location: string, status = 302): HttpMessage {
    const res = createResponse(status, status === 302 ? 'Found' : 'Permanent Redirect');
    res.headers.set('Location', location);
    res.headers.set('Content-Length', '0');
    return res;
  }

  it('sans -L, curl rend la réponse 302 elle-même', async () => {
    const l = lab();
    l.serve(PORT, () => redirectTo(url('/final', ALT_PORT)));

    const out = await l.client.executeCommand(`curl -i ${url('/start')}`);

    expect(out).toContain('HTTP/1.1 302 Found');
    expect(l.seen()).toHaveLength(1);
  });

  it('avec -L, la seconde requête part vraiment vers la cible', async () => {
    const l = lab();
    l.serve(PORT, () => redirectTo(url('/final', ALT_PORT)));
    l.serve(ALT_PORT, () => ok('arrived'));

    const out = await l.client.executeCommand(`curl -sS -L ${url('/start')}`);

    expect(out).toContain('arrived');
    expect(l.seen().map((r) => r.target)).toEqual(['/start', '/final']);
  });

  it('une Location relative est résolue contre l\'URL courante', async () => {
    const l = lab();
    l.serve(PORT, (req) => (req.target === '/here' ? redirectTo('/there') : ok('landed')));

    expect(await l.client.executeCommand(`curl -sS -L ${url('/here')}`)).toContain('landed');
    expect(l.seen().map((r) => r.target)).toEqual(['/here', '/there']);
  });

  it('un 302 sur un POST repasse en GET, un 308 garde la méthode', async () => {
    const l = lab();
    l.serve(PORT, (req) => (req.target === '/a' ? redirectTo('/b') : ok()));
    await l.client.executeCommand(`curl -sS -L -d "x=1" ${url('/a')}`);
    expect(l.seen().map((r) => r.method)).toEqual(['POST', 'GET']);

    const m = lab();
    m.serve(PORT, (req) => (req.target === '/a' ? redirectTo('/b', 308) : ok()));
    await m.client.executeCommand(`curl -sS -L -d "x=1" ${url('/a')}`);
    expect(m.seen().map((r) => r.method)).toEqual(['POST', 'POST']);
  });

  it('une boucle de redirections s\'arrête sur (47)', async () => {
    const l = lab();
    l.serve(PORT, () => redirectTo('/loop'));

    const out = await l.client.executeCommand(`curl -sS -L --max-redirs 3 ${url('/loop')}`);

    expect(out).toContain('curl: (47) Maximum (3) redirects followed');
    expect((await l.client.executeCommand('echo $?')).trim()).toBe('47');
  });

  it('%{num_redirects} compte ce qui a réellement été suivi', async () => {
    const l = lab();
    l.serve(PORT, (req) => (req.target === '/a' ? redirectTo('/b') : ok()));

    const out = await l.client.executeCommand(
      `curl -s -L -o /dev/null -w "%{num_redirects}\\n" ${url('/a')}`,
    );

    expect(out.trim()).toBe('1');
  });
});

describe('§P3 — `-u` : une vraie authentification HTTP Basic', () => {
  function guarded(user: string, pass: string) {
    return (req: HttpMessage): HttpMessage => {
      const auth = req.headers.get('Authorization');
      if (!auth || !verifyBasicCredentials(auth, user, pass)) {
        const res = createResponse(401, 'Unauthorized');
        res.headers.set('WWW-Authenticate', 'Basic realm="lab"');
        res.headers.set('Content-Length', '0');
        return res;
      }
      return ok('secret');
    };
  }

  it('sans -u, le serveur répond 401', async () => {
    const l = lab();
    l.serve(PORT, guarded('admin', 's3cret'));

    const out = await l.client.executeCommand(`curl -sS -f ${url('/private')}`);

    expect(out).toContain('curl: (22) The requested URL returned error: 401');
  });

  it('avec les bons identifiants, le corps protégé arrive', async () => {
    const l = lab();
    l.serve(PORT, guarded('admin', 's3cret'));

    expect(await l.client.executeCommand(`curl -sS -u admin:s3cret ${url('/private')}`))
      .toContain('secret');
  });

  it('un mauvais mot de passe reste refusé — les identifiants sont vraiment vérifiés', async () => {
    const l = lab();
    l.serve(PORT, guarded('admin', 's3cret'));

    const out = await l.client.executeCommand(`curl -s -o /dev/null -w "%{http_code}" -u admin:wrong ${url('/private')}`);

    expect(out.trim()).toBe('401');
  });
});

describe('§P3 — `--resolve` : séparer « le DNS est cassé » de « le service est cassé »', () => {
  it('sans --resolve, le nom ne résout pas', async () => {
    const l = lab();
    l.serve(PORT, () => ok('served'));

    expect(await l.client.executeCommand(`curl -sS http://intranet.lab:${PORT}/`))
      .toContain('curl: (6) Could not resolve host: intranet.lab');
  });

  it('avec --resolve, la requête part vers l\'adresse imposée et le Host reste le nom', async () => {
    const l = lab();
    l.serve(PORT, () => ok('served'));

    const out = await l.client.executeCommand(
      `curl -sS --resolve intranet.lab:${PORT}:${SRV_IP} http://intranet.lab:${PORT}/`,
    );

    expect(out).toContain('served');
    expect(l.seen()[0].headers.get('Host')).toBe(`intranet.lab:${PORT}`);
  });

  it('le service en panne se distingue alors du DNS en panne', async () => {
    const l = lab();

    // Rien n'écoute : le nom est résolu de force, donc l'échec ne peut plus
    // être imputé au DNS. C'est précisément le diagnostic que les TP
    // cherchent à faire acquérir.
    const out = await l.client.executeCommand(
      `curl -sS --resolve intranet.lab:${PORT}:${SRV_IP} http://intranet.lab:${PORT}/`,
    );

    expect(out).toContain(`curl: (7) Failed to connect to intranet.lab port ${PORT}`);
    expect(out).not.toContain('Could not resolve');
  });

  it('une entrée --resolve mal formée est refusée', async () => {
    const l = lab();

    const out = await l.client.executeCommand(`curl --resolve intranet.lab ${url()}`);

    expect(out).toContain("curl: (3) Couldn't parse CURLOPT_RESOLVE entry 'intranet.lab'");
  });
});

describe('deux défauts trouvés en relisant l\'analyseur, avant qu\'ils ne servent', () => {
  it('`-K` est `--config`, pas `--insecure` : il ne doit pas être avalé', async () => {
    const l = lab();
    l.serve(PORT, () => ok());

    // Aliasé par erreur sur `--insecure`, `-K fichier` aurait pris le
    // fichier pour une URL ET désactivé silencieusement la vérification
    // TLS — le mensonge exact que §P0 interdit, en pire.
    const out = await l.client.executeCommand(`curl -K /tmp/curlrc ${url()}`);

    expect(out).toContain('curl: option -K: is not implemented in this simulator');
    expect(l.seen()).toHaveLength(0);
  });

  it('`-X GET -d` envoie quand même le corps, comme le vrai curl', async () => {
    const l = lab();
    l.serve(PORT, () => ok());

    // Le corps était supprimé sur la seule foi du verbe. La bonne règle
    // est celle de curl : le corps suit la demande de l'opérateur, et
    // n'est abandonné que si une REDIRECTION change la méthode.
    await l.client.executeCommand(`curl -s -X GET -d "q=1" ${url('/search')}`);

    expect(l.seen()[0].method).toBe('GET');
    expect(bodyText(l.seen()[0])).toBe('q=1');
  });
});
