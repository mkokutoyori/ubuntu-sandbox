/**
 * `-F` et `--retry` — la fin de §P4, moins le proxy.
 *
 * `-F` est la seule option de cette famille qui demandait à ÉCRIRE
 * quelque chose : il n'existait nulle part de sérialiseur
 * `multipart/form-data`. Elle ne demandait pas de brique nouvelle pour
 * autant — lire un fichier et assembler des octets sont deux choses que
 * ce curl fait déjà.
 *
 * `--retry` mesure ce que le serveur VOIT : un amont qui échoue deux
 * fois puis répond prouve que la tentative a bien été refaite, là où
 * compter des lignes de trace ne prouverait que la trace.
 *
 * `-x` (proxy) reste refusée, et c'est la bonne décision : il n'existe
 * aucun mandataire DIRECT dans ce simulateur vers lequel pointer. On
 * pourrait écrire l'option ; on ne pourrait rien lui faire traverser.
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
/** Combien de fois l'amont capricieux a été appelé. */
let essais: number;

beforeEach(async () => {
  essais = 0;
  srv = new LinuxServer('linux-server', 'SRV');
  cli = new LinuxServer('linux-server', 'CLI');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  srv.powerOn();
  cli.powerOn();
  new Cable('a').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));

  // 8080 — un miroir qui rend le type et le corps reçus.
  new Http1ServerSession(srv.getTcpStack(), 8080, (req) => {
    const r = createResponse(200, 'OK');
    r.headers.set('Content-Type', 'text/plain');
    r.body = new TextEncoder().encode(
      `CT=[${req.headers.get('Content-Type') ?? '-'}]\n`
      + (req.body ? new TextDecoder().decode(req.body) : ''));
    return r;
  }).start();

  await cli.executeCommand(`sh -c 'printf "contenu-fichier" > /tmp/f.txt'`);
});

/** Un amont qui échoue `nEchecs` fois avant de répondre. */
function capricieux(port: number, nEchecs: number, statut = 503): void {
  new Http1ServerSession(srv.getTcpStack(), port, () => {
    essais++;
    if (essais <= nEchecs) {
      const r = createResponse(statut, 'Service Unavailable');
      r.headers.set('Content-Length', '0');
      return r;
    }
    const r = createResponse(200, 'OK');
    r.body = new TextEncoder().encode(`ok apres ${essais} essais`);
    return r;
  }).start();
}

describe('`-F` — un vrai corps multipart', () => {
  it('déclare la frontière dans le type ET l\'emploie dans le corps', async () => {
    const out = await cli.executeCommand('curl -s -F "nom=valeur" http://10.0.0.2:8080/');
    const frontiere = /boundary=(-+\d+)/.exec(out)?.[1];
    // La frontière est tirée au hasard, comme chez curl — une frontière
    // fixe finirait par apparaître dans un contenu et couperait le
    // corps en deux. Le cas s'accroche donc à sa FORME et à sa présence
    // des deux côtés, jamais à sa valeur.
    expect(frontiere).toBeDefined();
    expect(out).toContain(`--${frontiere}`);
    expect(out).toContain(`--${frontiere}--`);
  });

  it('un champ simple porte son nom et sa valeur', async () => {
    const out = await cli.executeCommand('curl -s -F "nom=valeur" http://10.0.0.2:8080/');
    expect(out).toContain('Content-Disposition: form-data; name="nom"');
    expect(out).toContain('valeur');
  });

  it('`@fichier` TÉLÉVERSE : nom de fichier et type', async () => {
    const out = await cli.executeCommand('curl -s -F "doc=@/tmp/f.txt" http://10.0.0.2:8080/');
    expect(out).toContain('name="doc"; filename="f.txt"');
    expect(out).toContain('Content-Type: text/plain');
    expect(out).toContain('contenu-fichier');
  });

  it('`<fichier` prend le CONTENU comme valeur, sans nom de fichier', async () => {
    // Les deux formes ne disent pas la même chose, et les confondre
    // serait le défaut : `<` est un champ ordinaire dont la valeur
    // vient d'ailleurs.
    const out = await cli.executeCommand('curl -s -F "txt=</tmp/f.txt" http://10.0.0.2:8080/');
    expect(out).toContain('contenu-fichier');
    expect(out).not.toContain('filename=');
  });

  it('`;type=` impose le type de la partie', async () => {
    const out = await cli.executeCommand(
      'curl -s -F "doc=@/tmp/f.txt;type=application/json" http://10.0.0.2:8080/');
    expect(out).toContain('Content-Type: application/json');
  });

  it('plusieurs `-F` donnent plusieurs parties, dans l\'ordre saisi', async () => {
    const out = await cli.executeCommand('curl -s -F "a=1" -F "b=2" http://10.0.0.2:8080/');
    expect(out.indexOf('name="a"')).toBeLessThan(out.indexOf('name="b"'));
  });

  it('`-F` fait un POST', async () => {
    expect(await cli.executeCommand('curl -s -F "a=1" http://10.0.0.2:8080/'))
      .toContain('multipart/form-data');
  });

  it('un fichier de partie absent échoue avant toute connexion', async () => {
    const out = await cli.executeCommand('curl -sS -F "d=@/tmp/pasla" http://10.0.0.2:8080/ 2>&1');
    expect(out).toContain('curl: (26) Failed to open/read local data');
    expect(out).not.toContain('CT=[');
  });

  it('`--form-string` ne donne AUCUN sens à `@`', async () => {
    // C'est sa raison d'être : envoyer une valeur qui commence par `@`
    // sans qu'elle soit prise pour un chemin.
    const out = await cli.executeCommand(
      'curl -s --form-string "a=@pas-un-fichier" http://10.0.0.2:8080/');
    expect(out).toContain('@pas-un-fichier');
    expect(out).not.toContain('curl: (26)');
  });

  it('un champ sans `=` est refusé', async () => {
    expect(await cli.executeCommand('curl -sS -F "zorglub" http://10.0.0.2:8080/ 2>&1'))
      .toContain('curl: (2) Illegally formatted input field');
  });
});

describe('`--retry` — le serveur voit la nouvelle tentative', () => {
  it('deux échecs transitoires puis un succès', async () => {
    capricieux(8081, 2);
    const out = await cli.executeCommand('curl -s --retry 3 http://10.0.0.2:8081/');
    // La mesure porte sur ce que l'AMONT a compté, pas sur la trace.
    expect(out).toContain('ok apres 3 essais');
    expect(essais).toBe(3);
  });

  it('`--retry N` fait N tentatives EN PLUS de la première', async () => {
    capricieux(8081, 99);
    await cli.executeCommand('curl -s --retry 2 http://10.0.0.2:8081/');
    // Se tromper d'un ferait échouer un `--retry 1` que le vrai
    // réussit.
    expect(essais).toBe(3);
  });

  it('sans `--retry`, une seule tentative', async () => {
    capricieux(8081, 99);
    await cli.executeCommand('curl -s http://10.0.0.2:8081/');
    expect(essais).toBe(1);
  });

  it('une connexion refusée est transitoire, et le code final reste 7', async () => {
    const out = await cli.executeCommand(
      'curl -sS --retry 2 http://10.0.0.2:9999/ 2>&1 ; echo code=$?');
    expect(out).toContain('curl: (7) Failed to connect');
    expect(out).toContain('code=7');
  });

  it('curl annonce chaque nouvelle tentative', async () => {
    capricieux(8081, 1);
    const out = await cli.executeCommand('curl -sS --retry 3 http://10.0.0.2:8081/ 2>&1');
    expect(out).toContain('Warning: Transient problem');
    expect(out).toContain('retries left');
  });

  it('un `404` n\'est PAS transitoire : insister n\'y changerait rien', async () => {
    new Http1ServerSession(srv.getTcpStack(), 8082, () => {
      essais++;
      const r = createResponse(404, 'Not Found');
      r.headers.set('Content-Length', '0');
      return r;
    }).start();
    await cli.executeCommand('curl -s --retry 3 http://10.0.0.2:8082/');
    expect(essais).toBe(1);
  });

  it('`--retry-all-errors` passe outre, ce qui est sa raison d\'être', async () => {
    new Http1ServerSession(srv.getTcpStack(), 8083, () => {
      essais++;
      const r = createResponse(404, 'Not Found');
      r.headers.set('Content-Length', '0');
      return r;
    }).start();
    await cli.executeCommand('curl -s -f --retry 2 --retry-all-errors http://10.0.0.2:8083/');
    expect(essais).toBe(3);
  });

  it('un `--retry` qui n\'est pas un nombre est refusé', async () => {
    expect(await cli.executeCommand('curl -sS --retry zorglub http://10.0.0.2:8080/ 2>&1'))
      .toContain('retry is not a valid number');
  });
});

describe('ce qui reste hors périmètre le dit encore', () => {
  it('`-x` reste refusée — rien à traverser', async () => {
    expect(await cli.executeCommand('curl -s -x http://10.0.0.2:3128 http://10.0.0.2:8080/'))
      .toContain('curl: option -x: is not implemented in this simulator');
  });
});
