/**
 * `ufw limit' comptait pour TOUT LE MONDE au lieu de compter par source.
 *
 * MESURE DE DEPART sur `56137253'. `ufw limit 22/tcp' puis `ufw enable'
 * injectaient UNE seule regle :
 *
 *   -A ufw-user-input -p tcp --dport 22 -m limit --limit 6/minute
 *      --limit-burst 6 -j ufw-user-limit-accept
 *
 * `-m limit' est un seau a jetons GLOBAL : il ne regarde pas qui emet. Six
 * connexions par minute, toutes sources confondues. Un seul attaquant qui
 * martele le port epuise donc le seau, et c'est le trafic LEGITIME des
 * autres machines qui tombe avec lui — l'inverse exact de ce qu'un garde
 * anti-force-brute doit faire.
 *
 * Et la machine le SAVAIT : `LinuxFirewallManager' portait un second
 * magasin, `rateLimitHits', avec ce commentaire — « Rate limiting (managed
 * at UFW level since iptables limit module is stateless — we need stateful
 * per-source tracking) » — et une methode `evaluateRateLimit(srcIP,
 * ruleIdx)' dont l'en-tete annonce « Called by the iptables manager via the
 * rate limit callback ». Ce rappel n'existe pas. La methode n'avait AUCUN
 * appelant. Le comptage par source etait ecrit, jamais consulte.
 *
 * AUTORITE. `ufw' 0.36.2, `backend_iptables.py' l. 651-663 : `-j LIMIT' est
 * developpe en TROIS regles, et jamais en `-m limit' :
 *
 *   tmp1 = ' -m conntrack --ctstate NEW -m recent --set'
 *   tmp2 = ' -m conntrack --ctstate NEW -m recent --update --seconds 30'
 *          ' --hitcount 6 -j <prefix>-user-limit'
 *   tmp3 = ' -j <prefix>-user-limit-accept'
 *
 * Releve sur la machine hote, `iptables -S' apres `ufw limit 25/tcp' :
 *
 *   -A ufw-user-input -p tcp -m tcp --dport 25 -m conntrack --ctstate NEW
 *      -m recent --set --name DEFAULT --mask 255.255.255.255 --rsource
 *   -A ufw-user-input -p tcp -m tcp --dport 25 -m conntrack --ctstate NEW
 *      -m recent --update --seconds 30 --hitcount 6 --name DEFAULT
 *      --mask 255.255.255.255 --rsource -j ufw-user-limit
 *   -A ufw-user-input -p tcp -m tcp --dport 25 -j ufw-user-limit-accept
 *   -A ufw-user-limit -j REJECT --reject-with icmp-port-unreachable
 *   -A ufw-user-limit-accept -j ACCEPT
 *
 * Quand `recent-set'/`recent-update' manquent au noyau, ufw ne retombe PAS
 * sur `-m limit' : `caps['limit']['4']' passe a faux et `set_rule' repond
 * « Skipping unsupported IPv4 'limit' rule » (`backend.py' l. 103-106,
 * `backend_iptables.py' l. 972-978). `-m limit' n'a jamais fait partie de
 * `ufw limit'.
 *
 * `-m recent' etait d'ailleurs deja dans la liste des modules que
 * l'analyseur ACCEPTE, sans qu'aucun evaluateur ne le lise : range, rendu
 * par `iptables -S', et sans effet. La semantique vient du noyau,
 * `net/netfilter/xt_recent.c:recent_mt()' :
 *
 *   --set     cree l'entree si absente, sinon l'horodate ; rend VRAI ;
 *   --update  rend FAUX si l'entree est absente ; sinon compte les
 *             horodatages dans la fenetre `--seconds' et rend VRAI des que
 *             ce compte atteint `--hitcount' — puis horodate a nouveau
 *             (`XT_RECENT_UPDATE && ret' -> `recent_entry_update'), ce qui
 *             fait glisser la fenetre tant que la source insiste ;
 *   `--rsource' (defaut) regarde l'adresse SOURCE, `--rdest' la
 *   destination, et `--mask' groupe les adresses.
 *
 * Et `-m limit' lui-meme etait FAUX dans l'autre sens : le moteur le
 * comptait par adresse source (`${pkt.srcIP}:${proto}:${dport}'), alors que
 * `xt_limit' tient un seau par REGLE — `struct xt_limit_priv' est l'etat
 * prive de la regle, jamais indexe par une adresse
 * (`net/netfilter/xt_limit.c:limit_mt' : credits pleins a `--limit-burst',
 * recharges par le temps ecoule, un credit depense par correspondance).
 * Les deux modules echangeaient donc leurs semantiques : celui qui devait
 * compter par source ne comptait rien, et celui qui devait compter
 * globalement comptait par source.
 *
 * MESURE : 6 cas tombent sur 9 (`git stash' sur LinuxFirewallManager.ts et
 * LinuxIptablesManager.ts). Les trois cas qui passent des deux cotes :
 *   - TEMOIN : la premiere connexion d'une source neuve passe — sans lui,
 *     une sonde faite de refus ne prouverait pas que le lab est joignable ;
 *   - « une AUTRE source passe encore » passe DES DEUX COTES, et c'est
 *     exactement pour la raison ci-dessus : le `-m limit' du moteur comptait
 *     deja par source, par accident. Le cas ne discrimine donc pas — ce qui
 *     discrimine, c'est le RANG du refus : seau plein a 6 jetons, l'ancien
 *     laissait passer six coups et refusait le septieme ; `--hitcount 6'
 *     refuse le SIXIEME, qui est la regle de ufw ;
 *   - NON-REGRESSION : `ufw status' montre toujours la regle en LIMIT, et
 *     les chaines `ufw-user-limit' et `ufw-user-limit-accept' gardent leur
 *     REJECT et leur ACCEPT.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const SRV = '10.0.0.2';

async function lab(): Promise<{ a: LinuxPC; b: LinuxPC; srv: LinuxServer }> {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const a = new LinuxPC('linux-pc', 'PCA', 0, 0);
  const b = new LinuxPC('linux-pc', 'PCB', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1', 0, 0);
  new Cable('c1').connect(a.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(b.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(srv.getPorts()[0], sw.getPorts()[2]);
  const m = new SubnetMask('255.255.255.0');
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.11'), m);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.12'), m);
  srv.getPorts()[0].configureIP(new IPAddress(SRV), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo ufw limit 22/tcp');
  await srv.executeCommand('sudo ufw enable');
  return { a, b, srv };
}

const knock = async (pc: LinuxPC): Promise<boolean> => {
  const out = String(await pc.executeCommand(`nc -zv ${SRV} 22`));
  return /succeeded|open/i.test(out);
};

async function knockUntilRefused(pc: LinuxPC, max = 12): Promise<number> {
  for (let i = 1; i <= max; i++) {
    if (!await knock(pc)) return i;
  }
  return 0;
}

const userInput = async (srv: LinuxServer): Promise<string> =>
  String(await srv.executeCommand('iptables -S ufw-user-input'));

describe('`ufw limit` compte les connexions PAR SOURCE', () => {
  it('TEMOIN : la premiere connexion d une source neuve passe', async () => {
    const { a } = await lab();
    expect(await knock(a)).toBe(true);
  }, 30000);

  it('la SIXIEME tentative dans la fenetre est la premiere refusee', async () => {
    const { a } = await lab();
    expect(await knockUntilRefused(a)).toBe(6);
  }, 30000);

  it('une AUTRE source passe encore quand la premiere est bloquee', async () => {
    const { a, b } = await lab();
    expect(await knockUntilRefused(a)).toBeGreaterThan(0);
    expect(await knock(b)).toBe(true);
  }, 30000);

  it('`ufw limit` injecte les TROIS regles de ufw', async () => {
    const { srv } = await lab();
    const rules = (await userInput(srv)).split('\n').filter(l => l.includes('--dport 22'));
    expect(rules.length).toBe(3);
  }, 30000);

  it('la premiere regle ENREGISTRE la source, sans cible', async () => {
    const { srv } = await lab();
    const rules = (await userInput(srv)).split('\n').filter(l => l.includes('--dport 22'));
    expect(rules[0]).toContain('-m conntrack --ctstate NEW');
    expect(rules[0]).toContain('-m recent --set');
    expect(rules[0]).not.toContain('-j ');
  }, 30000);

  it('la deuxieme regle COMPTE dans la fenetre et renvoie vers ufw-user-limit', async () => {
    const { srv } = await lab();
    const rules = (await userInput(srv)).split('\n').filter(l => l.includes('--dport 22'));
    expect(rules[1]).toContain('-m recent --update --seconds 30 --hitcount 6');
    expect(rules[1]).toContain('-j ufw-user-limit');
  }, 30000);

  it('la troisieme regle accepte le reste', async () => {
    const { srv } = await lab();
    const rules = (await userInput(srv)).split('\n').filter(l => l.includes('--dport 22'));
    expect(rules[2]).toContain('-j ufw-user-limit-accept');
  }, 30000);

  it('aucune regle de ufw n emploie le seau global `-m limit`', async () => {
    const { srv } = await lab();
    expect(await userInput(srv)).not.toContain('-m limit');
  }, 30000);

  it('NON-REGRESSION : status montre LIMIT, et les chaines gardent REJECT/ACCEPT', async () => {
    const { srv } = await lab();
    expect(String(await srv.executeCommand('ufw status'))).toMatch(/22\/tcp\s+LIMIT/);
    expect(String(await srv.executeCommand('iptables -S ufw-user-limit')))
      .toContain('-j REJECT --reject-with icmp-port-unreachable');
    expect(String(await srv.executeCommand('iptables -S ufw-user-limit-accept')))
      .toContain('-j ACCEPT');
  }, 30000);
});
