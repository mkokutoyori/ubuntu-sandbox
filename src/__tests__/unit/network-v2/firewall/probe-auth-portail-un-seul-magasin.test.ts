/**
 * Le port du portail d'authentification avait DEUX magasins, et le second
 * ecrasait le premier en silence.
 *
 * `auth-http-port` et `auth-https-port` etaient declares DEUX FOIS --
 * sous `config system global` et sous `config user setting` -- chacun
 * avec son propre consommateur appelant `setAuthPortalPorts`. Mesure de
 * depart, et c'est elle qui donne le prix du defaut :
 *
 *   config system global / set auth-http-port 8080  -> portail 8080/8443
 *   config user setting  / set auth-timeout 30      -> portail 1000/1003
 *
 * La seconde commande ne parle PAS des ports. Elle remettait pourtant le
 * portail sur les valeurs d'usine, pendant que `show full-configuration
 * system global` continuait d'afficher `set auth-http-port 8080` : la
 * machine se contredisait sur son propre port, et rien ne le disait. La
 * configuration rendue portait l'attribut sur les DEUX tables, avec deux
 * valeurs differentes, et un import de topologie les rejouait toutes les
 * deux -- la derniere ecrite gagnant selon l'ordre de rendu.
 *
 * La reference tranche laquelle des deux copies survit :
 * `official_docs/forti-cli-ref-60.txt` donne `config user setting` avec
 * ses dix-huit attributs, ou figurent `auth-timeout`, `auth-timeout-type`
 * et `auth-secure-http` mais NI les deux ports NI `auth-keepalive` ; les
 * trois sont sous `config system global` (« User authentication HTTP
 * port », « User authentication HTTPS port », « Enable to prevent user
 * authentication sessions from timing out when idle »). Le consommateur
 * de `system global` ATTENDAIT deja les deux ports -- `applyGlobalSettings`
 * les projetait -- mais l'attribut n'y etant pas declare, il retombait
 * toujours sur 1000/1003 code en dur.
 *
 * Les DEFAUTS 1000 et 1003 sont ceux de FortiOS 7.x et sont conserves ;
 * la reference 6.0.4 ecrit 80 et 443, qui sont les anciens. Notre boitier
 * annonce 7.6.3, donc les valeurs en place etaient justes -- c'est la
 * TABLE qui ne l'etait pas, et il ne fallait pas corriger l'une en
 * croyant corriger l'autre.
 *
 * `auth-keepalive` etait de surcroit INERTE : porte par le type de
 * correctif (`FortiAuthSettingPatch.keepAlive`), rendu dans la
 * configuration, et lu par PERSONNE -- exactement le « critere range que
 * l'on n'evalue pas » que ce depot refuse. Il gouverne desormais le
 * delai d'INACTIVITE, et lui seul : une session au-dela de son delai ne
 * tombe plus tant que le keepalive est arme, tandis qu'un `hard-timeout`,
 * qui est absolu, continue d'expirer. Limite assumee : nous ne modelisons
 * pas la page de rafraichissement que le vrai FortiGate tient ouverte
 * dans le navigateur ; « le delai d'inactivite ne se declenche pas » en
 * est l'equivalent observable.
 *
 * Discrimine par `git stash` sur les six fichiers cables : 6 cas
 * tombent. Les 2 qui passent des deux cotes sont nommes ici avec leur
 * raison :
 *  - le TEMOIN, dont c'est l'objet : le port pose en global prend effet
 *    tout de suite, ce qui a toujours ete vrai et prouve que le
 *    laboratoire fonctionne ;
 *  - « les defauts restent 1000 et 1003 », qui passe des deux cotes
 *    puisque les deux magasins portaient les memes valeurs d'usine.
 *
 * J'avais annonce 5 cas tombants et compte « un hard-timeout expire
 * MALGRE le keepalive » parmi ceux qui passent des deux cotes. C'etait
 * faux, et la mesure l'a corrige : ce cas appelle `setKeepAlive`, que le
 * correctif AJOUTE, donc il ne peut pas s'executer sans lui. Il reste
 * utile -- il garde que le keepalive ne coupe QUE le delai d'inactivite
 * -- mais il ne prouve rien de l'etat d'avant.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { IdentityTable } from '@/network/devices/firewall/identity/IdentityTable';

async function boitier(...lignes: string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FGT');
  for (const l of lignes) await fw.executeCommand(l);
  return fw;
}

describe('FortiGate : le portail d authentification n a qu un magasin', () => {
  it('TEMOIN : le port pose en global prend effet', async () => {
    const fw = await boitier('config system global',
      'set auth-http-port 8080', 'set auth-https-port 8443', 'end');
    expect(fw.getAuthPortalPorts()).toEqual({ http: 8080, https: 8443 });
  });

  it('toucher `user setting` ne renverse plus le port pose en global', async () => {
    const fw = await boitier('config system global',
      'set auth-http-port 8080', 'set auth-https-port 8443', 'end');
    await fw.executeCommand('config user setting');
    await fw.executeCommand('set auth-timeout 30');
    await fw.executeCommand('end');
    expect(fw.getAuthPortalPorts()).toEqual({ http: 8080, https: 8443 });
  });

  it('`user setting` REFUSE les ports, qui ne sont pas de sa table', async () => {
    const fw = await boitier('config user setting');
    const dit = await fw.executeCommand('set auth-http-port 9090');
    expect(dit).toContain('unknown attribute "auth-http-port"');
    expect(await fw.executeCommand('set auth-keepalive enable'))
      .toContain('unknown attribute "auth-keepalive"');
    await fw.executeCommand('end');
  });

  it('la configuration rendue ne porte les trois QUE sous system global', async () => {
    const fw = await boitier('config system global',
      'set auth-http-port 8080', 'set auth-keepalive enable', 'end');
    const global = await fw.executeCommand('show full-configuration system global');
    const user = await fw.executeCommand('show full-configuration user setting');
    expect(global).toContain('set auth-http-port 8080');
    expect(global).toContain('set auth-keepalive enable');
    expect(user).not.toMatch(/auth-http-port|auth-https-port|auth-keepalive/);
  });

  it('`auth-keepalive` atteint la table d identites', async () => {
    const fw = await boitier('config system global', 'set auth-keepalive enable', 'end');
    expect(fw.getIdentityTable().keepsAlive()).toBe(true);
  });

  it('le keepalive empeche le delai d INACTIVITE de tomber', () => {
    let t = 0;
    const table = new IdentityTable({ now: () => t });
    table.setTimeoutPolicy('idle-timeout', 300);
    table.bind({ address: '10.0.0.5', user: 'zoe', source: 'local',
      groups: ['GRP'], timeoutSec: 300 });

    t = 301_000;
    expect(table.lookup('10.0.0.5')).toBeUndefined();

    t = 0;
    const gardee = new IdentityTable({ now: () => t });
    gardee.setTimeoutPolicy('idle-timeout', 300);
    gardee.setKeepAlive(true);
    gardee.bind({ address: '10.0.0.6', user: 'zoe', source: 'local',
      groups: ['GRP'], timeoutSec: 300 });
    t = 301_000;
    expect(gardee.lookup('10.0.0.6')?.user).toBe('zoe');
  });

  it('un hard-timeout expire MALGRE le keepalive, parce qu il est absolu', () => {
    let t = 0;
    const table = new IdentityTable({ now: () => t });
    table.setTimeoutPolicy('hard-timeout', 300);
    table.setKeepAlive(true);
    table.bind({ address: '10.0.0.7', user: 'zoe', source: 'local',
      groups: ['GRP'], timeoutSec: 300 });
    t = 301_000;
    expect(table.lookup('10.0.0.7')).toBeUndefined();
  });

  it('les defauts restent 1000 et 1003', async () => {
    const fw = await boitier();
    expect(fw.getAuthPortalPorts()).toEqual({ http: 1000, https: 1003 });
  });
});
