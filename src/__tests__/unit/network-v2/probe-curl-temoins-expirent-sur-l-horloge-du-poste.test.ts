/**
 * Le bocal de temoins de `curl` juge l'expiration sur l'horloge de la MACHINE. `CookieJar` retombait sur
 * `simulationNowMs()` et `curl -b` relisait son fichier avec la meme heure globale : un temoin `Max-Age=3600` posé puis
 * relu apres un saut d'horloge de deux jours (`date -s`) etait toujours renvoye au serveur. Corrige : `CookieJar` prend une
 * horloge (par defaut l'heure globale pour ses autres usagers) et le transfert curl lui donne `TcpStack.nowMs` du poste, y
 * compris pour relire un fichier `-b`.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (poste avance de deux jours). Le TEMOIN (a
 * l'heure, le temoin est renvoye) passe des deux cotes.
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


const DAY = 24 * 3600 * 1000;

describe('le bocal de temoins expire sur l horloge du poste', () => {
  it('TEMOIN — a l heure, le temoin Max-Age=3600 est renvoye', async () => {
    miroir(8080, 'sid=abc123; Path=/; Max-Age=3600');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    expect(await cli.executeCommand('curl -s -b /tmp/jar http://10.0.0.2:8080/')).toContain('recu:[sid=abc123]');
  });

  it('un poste avance de deux jours n envoie plus le temoin expire', async () => {
    miroir(8080, 'sid=abc123; Path=/; Max-Age=3600');
    await cli.executeCommand('curl -s -c /tmp/jar http://10.0.0.2:8080/');
    cli._stepSystemClock(2 * DAY);
    expect(await cli.executeCommand('curl -s -b /tmp/jar http://10.0.0.2:8080/')).toContain('recu:[rien]');
  });
});
