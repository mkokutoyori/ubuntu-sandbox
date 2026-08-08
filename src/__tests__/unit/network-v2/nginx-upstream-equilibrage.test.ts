/**
 * docs/PRD-Nginx.md §9.10 — l'équilibrage de charge d'un `upstream`.
 *
 * §9.5 nommait la limite plutôt que de la taire : « un seul membre est
 * utilisé, le premier qui n'est pas `down` », et refusait d'annoncer un
 * tour de rôle en servant toujours le même — « une répartition suppose
 * de mesurer, et rien ici ne mesure encore ». Ce lot mesure.
 *
 * Le principe qui gouverne chaque cas : l'équilibrage doit être
 * OBSERVABLE. Chaque amont rend son propre port dans le corps, si bien
 * qu'une suite de requêtes se lit à l'œil — un équilibrage qu'on ne peut
 * pas voir est indiscernable d'un décor, ce que ce PRD supprime
 * partout.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse } from '@/network/http/semantics/types';

let front: LinuxServer;
let back: LinuxServer;

function ecrireConf(texte: string): string {
  const e = texte.replace(/\n/g, '\\n').replace(/"/g, '\\"').replace(/\$/g, '\\$');
  return `sh -c 'printf "${e}" > /etc/nginx/sites-available/default'`;
}

/** Trois amonts vivants, chacun se nommant : 9001, 9002, 9003. */
function amonts(): void {
  for (const port of [9001, 9002, 9003]) {
    new Http1ServerSession(back.getTcpStack(), port, () => {
      const r = createResponse(200, 'OK');
      r.headers.set('Content-Type', 'text/plain');
      r.body = new TextEncoder().encode(`amont-${port}`);
      return r;
    }).start();
  }
}

beforeEach(() => {
  front = new LinuxServer('linux-server', 'FRONT');
  back = new LinuxServer('linux-server', 'BACK');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  front.powerOn();
  back.powerOn();
  new Cable('a').connect(front.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(back.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  front.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  back.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  amonts();
});

async function groupe(corps: string): Promise<void> {
  await front.executeCommand(ecrireConf(
    `upstream appli {\n${corps}}\nserver {\n  listen 80;\n  location / {\n    proxy_pass http://appli;\n  }\n}\n`));
  await front.executeCommand('systemctl restart nginx');
}

/** Ce que N requêtes successives ont réellement atteint. */
async function suite(n: number): Promise<string[]> {
  const vus: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = (await back.executeCommand('curl -s http://10.0.0.1/')).trim();
    vus.push(r.includes('502') ? '502' : r);
  }
  return vus;
}

describe('§9.10 — le tour de rôle', () => {
  it('deux membres se relaient vraiment', async () => {
    await groupe('  server 10.0.0.2:9001;\n  server 10.0.0.2:9002;\n');
    expect(await suite(6)).toEqual([
      'amont-9001', 'amont-9002', 'amont-9001',
      'amont-9002', 'amont-9001', 'amont-9002',
    ]);
  });

  it('trois membres tournent dans l\'ordre du fichier', async () => {
    await groupe('  server 10.0.0.2:9001;\n  server 10.0.0.2:9002;\n  server 10.0.0.2:9003;\n');
    expect(await suite(6)).toEqual([
      'amont-9001', 'amont-9002', 'amont-9003',
      'amont-9001', 'amont-9002', 'amont-9003',
    ]);
  });

  it('`weight=3` prend trois tours sur quatre', async () => {
    // Le poids était PARSÉ par personne : `weight=3` était un mot que
    // rien ne lisait, donc un réglage qui ne réglait rien.
    await groupe('  server 10.0.0.2:9001 weight=3;\n  server 10.0.0.2:9002;\n');
    const vus = await suite(8);
    expect(vus.filter((v) => v === 'amont-9001')).toHaveLength(6);
    expect(vus.filter((v) => v === 'amont-9002')).toHaveLength(2);
  });

  it('`down` retire le membre du cycle sans le faire échouer', async () => {
    await groupe('  server 10.0.0.2:9001 down;\n  server 10.0.0.2:9002;\n');
    expect(await suite(3)).toEqual(['amont-9002', 'amont-9002', 'amont-9002']);
  });
});

describe('§9.10 — la détection passive de panne', () => {
  it('un membre mort est écarté APRÈS avoir déçu, pas avant', async () => {
    await groupe('  server 10.0.0.2:9001;\n  server 10.0.0.2:9999;\n');
    const vus = await suite(6);
    // nginx n'interroge pas ses amonts : il apprend en servant du
    // trafic réel. Le premier client paie donc l'échec — c'est ce que
    // « passive » veut dire, et le cacher serait faux.
    expect(vus[0]).toBe('amont-9001');
    expect(vus[1]).toBe('502');
    // Ensuite le membre mort sort du cycle et le vivant sert tout.
    expect(vus.slice(2)).toEqual(['amont-9001', 'amont-9001', 'amont-9001', 'amont-9001']);
  });

  it('sans détection, un membre mort renverrait 502 une fois sur deux', async () => {
    await groupe('  server 10.0.0.2:9001;\n  server 10.0.0.2:9999;\n');
    const vus = await suite(10);
    // Le garde-fou qui donne son sens au cas précédent : `max_fails`
    // était une valeur stockée et lue par personne.
    expect(vus.filter((v) => v === '502')).toHaveLength(1);
  });

  it('`max_fails=2` laisse une seconde chance avant d\'écarter', async () => {
    await groupe('  server 10.0.0.2:9001;\n  server 10.0.0.2:9999 max_fails=2;\n');
    const vus = await suite(8);
    expect(vus.filter((v) => v === '502')).toHaveLength(2);
  });

  it('`max_fails=0` désarme la détection : le membre reste dans le cycle', async () => {
    await groupe('  server 10.0.0.2:9001;\n  server 10.0.0.2:9999 max_fails=0;\n');
    const vus = await suite(6);
    // C'est la valeur qui dit « ne l'écarte jamais », et elle doit donc
    // faire échouer une requête sur deux, indéfiniment.
    expect(vus.filter((v) => v === '502')).toHaveLength(3);
  });

  it('un rechargement remet les compteurs à zéro', async () => {
    await groupe('  server 10.0.0.2:9001;\n  server 10.0.0.2:9999;\n');
    await suite(4);
    await front.executeCommand('systemctl reload nginx');
    // Un rechargement fait naître de nouveaux processus de travail, et
    // sans `zone` chacun part avec des compteurs vierges. Le premier
    // client d'après paie donc à nouveau — mesuré, et corrigé après
    // avoir constaté l'inverse.
    expect((await suite(2))).toContain('502');
  });
});

describe('§9.10 — `backup`', () => {
  it('ne sert que lorsque les membres ordinaires sont hors service', async () => {
    await groupe('  server 10.0.0.2:9999;\n  server 10.0.0.2:9002 backup;\n');
    const vus = await suite(5);
    expect(vus[0]).toBe('502');
    expect(vus.slice(1)).toEqual([
      'amont-9002', 'amont-9002', 'amont-9002', 'amont-9002',
    ]);
  });

  it('reste inutilisé tant qu\'un membre ordinaire répond', async () => {
    // Un repli qui prendrait sa part du trafic ordinaire ne serait pas
    // un repli.
    await groupe('  server 10.0.0.2:9001;\n  server 10.0.0.2:9002 backup;\n');
    expect(await suite(4)).toEqual([
      'amont-9001', 'amont-9001', 'amont-9001', 'amont-9001',
    ]);
  });
});

describe('§9.10 — `ip_hash`', () => {
  it('la même adresse retombe toujours sur le même membre', async () => {
    await groupe('  ip_hash;\n  server 10.0.0.2:9001;\n  server 10.0.0.2:9002;\n');
    const vus = await suite(5);
    expect(new Set(vus).size).toBe(1);
  });
});

describe('§9.10 — ce que `nginx -t` refuse', () => {
  async function juger(corps: string): Promise<string> {
    await front.executeCommand(ecrireConf(
      `upstream appli {\n${corps}}\nserver {\n  listen 80;\n  location / {\n    proxy_pass http://appli;\n  }\n}\n`));
    return front.executeCommand('nginx -t');
  }

  it('`least_conn` est refusée plutôt qu\'aliasée sur le tour de rôle', async () => {
    // Elle choisit le membre qui a le moins de connexions EN COURS, et
    // rien ici n'en tient : la livraison est synchrone, il n'y a jamais
    // deux requêtes en vol. L'accepter reviendrait à faire du tour de
    // rôle en l'appelant autrement.
    expect(await juger('  least_conn;\n  server 10.0.0.2:9001;\n'))
      .toContain('directive "least_conn" is not supported by this simulator');
  });

  it('un paramètre inconnu de `server` est refusé', async () => {
    expect(await juger('  server 10.0.0.2:9001 zorglub;\n'))
      .toContain('invalid parameter "zorglub"');
  });

  it('un poids qui n\'est pas un entier est refusé', async () => {
    expect(await juger('  server 10.0.0.2:9001 weight=zero;\n'))
      .toContain('invalid parameter "weight=zero"');
  });

  it('les paramètres réels sont acceptés', async () => {
    expect(await juger(
      '  server 10.0.0.2:9001 weight=2 max_fails=3 fail_timeout=30s;\n'
      + '  server 10.0.0.2:9002 backup;\n'))
      .toContain('test is successful');
  });
});
