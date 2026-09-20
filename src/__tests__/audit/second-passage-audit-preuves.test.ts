/**
 * AUDIT SECURITE — SECOND PASSAGE, constats S-02 a S-05.
 *
 * `docs/AUDIT-SECURITE-INFRA.md' §5 nommait huit controles poses,
 * acceptes, et qu'AUCUNE attaque n'avait eprouves. Le second passage les
 * attaque un par un (releve :
 * `src/__tests__/debug/infra/second-passage-attaques.debug.test.ts').
 * Trois des attaques restantes ont trouve quelque chose.
 *
 * S-02 — SAUT DE VLAN PAR DOUBLE ETIQUETAGE.
 *   Mesure AVANT : une trame portant une etiquette exterieure egale au
 *   VLAN natif et une etiquette interieure VLAN 10, injectee sur un port
 *   d'acces, ressortait du trunk DEPOUILLEE de son etiquette exterieure
 *   et gardait l'interieure — le commutateur d'en face la classait donc
 *   en VLAN 10. `switchport trunk native vlan 999' refermait le cas OU
 *   LE PIRATE N'EST PAS DANS LE NATIF ; quand il y est, le saut
 *   aboutissait toujours, et la seule parade qui le refermerait —
 *   `vlan dot1q tag native' — n'existait pas (`% Invalid VLAN ID').
 *   APRES : la commande existe, se rend dans la configuration, etiquette
 *   le VLAN natif a la sortie des trunks, et une trame NON etiquetee
 *   arrivant sur un trunk est rejetee.
 *
 * S-03 — REPLI `local' APRES UN GROUPE RADIUS INJOIGNABLE.
 *   Mesure AVANT : `aaa authentication login default group GRP local'
 *   avec un serveur RADIUS injoignable REFUSAIT la session au lieu de
 *   replier sur `local' — un routeur dont le serveur tombe verrouillait
 *   donc dehors tous ses administrateurs. Cause : `RadiusClientAgent'
 *   distingue en interne accept / reject / timeout, `authenticate()'
 *   ecrasait les trois en un booleen, et `tryRadiusGroup' relisait ce
 *   booleen comme un REJET faisant autorite. `tryTacacsGroup', a deux
 *   ecrans de la, tenait deja la bonne forme.
 *
 * S-04 — `radius-server timeout' / `retransmit' JAMAIS APPLIQUES.
 *   Mesure AVANT : un serveur declare par `radius server <nom>' naissait
 *   avec `timeoutSec: 5, retransmit: 3' inscrits DANS SON ENREGISTREMENT,
 *   si bien que la chaine `server.timeoutSec ?? defauts.timeoutSec'
 *   choisissait toujours la valeur du serveur. Les reglages globaux
 *   etaient acceptes, rendus par `show running-config', et sans effet :
 *   20 s d'attente la ou l'operateur avait demande 1 s. La forme heritee
 *   `radius-server host ...' ne souffrait pas du defaut — elle laisse ces
 *   champs indefinis, ce qui est la bonne forme.
 *
 * S-05 — LA COLONNE `Vlan' DE `show ip arp inspection statistics'.
 *   L'attaque DAI, elle, a montre que le controle APPLIQUE : les deux
 *   ARP gratuits a liaison fausse sont rejetes et la victime n'est pas
 *   empoisonnee. Mais le tableau des compteurs annoncait une colonne
 *   `Vlan' et y ecrivait le mot `(all)' : les statistiques etaient
 *   tenues PAR PORT seulement, donc le VLAN — que le journal
 *   `show ip arp inspection log' connait, lui — etait perdu. Deux vues
 *   d'un meme fait dont une seule sait repondre (CLAUDE.md §3). Les
 *   compteurs sont desormais tenus aussi par VLAN.
 *
 * Discrimination : 7 cas sur 13 tombent sous `git stash push -- src/network'.
 * Les six autres, et pourquoi ils passent des deux cotes :
 *
 *   - << un trunk non durci laisse passer le saut >> : c'est la mesure
 *     AVANT elle-meme, et elle doit rester vraie apres — c'est le
 *     comportement d'un vrai commutateur. Elle est ici comme TEMOIN du
 *     labo : sans elle, les cas qui refusent le saut ne prouveraient pas
 *     qu'une attaque etait seulement possible.
 *   - << un VLAN natif distinct referme le saut >> : ce controle-la
 *     appliquait DEJA. Non-regression : la parade qu'on ajoute ne doit
 *     pas casser celle qui marchait.
 *   - << une trame simple traverse le trunk >> : TEMOIN de non-regression.
 *     Etiqueter le natif ne doit pas couper le trunk. Sur la base il
 *     passe pour une autre raison — la commande y est refusee, donc le
 *     trunk reste nu ; c'est un temoin STRUCTUREL, et c'est dit ici.
 *   - << sans `local' la chaine refuse >> : sur la base elle refusait
 *     TOUT, donc elle avait raison par accident. Il garde que la
 *     correction n'a pas ouvert la porte a l'inverse.
 *   - << un mauvais mot de passe est refuse, repli autorise >> : TEMOIN
 *     de non-faux-positif. Le repli ne doit pas accorder a n'importe qui.
 *   - << l'ARP gratuit a liaison fausse est REJETE >> : le controle DAI
 *     appliquait deja. Sans ce temoin, le cas sur la colonne `Vlan' ne
 *     distinguerait pas << les compteurs sont ranges par VLAN >> de
 *     << il n'y a rien a compter >>.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function cli(
  d: { executeCommand(c: string): Promise<string> }, lignes: string[],
): Promise<string> {
  let out = '';
  for (const c of lignes) out = await d.executeCommand(c);
  return out;
}

const PIRATE = '02:00:00:00:de:ad';
const SAGE = '02:00:00:00:be:ef';

async function labDeuxCommutateurs(natif: number, vlanPirate: number, tagNatif: boolean) {
  const sw1 = new CiscoSwitch('switch-cisco', `SW1-${natif}-${vlanPirate}`, 24, 0, 0);
  const sw2 = new CiscoSwitch('switch-cisco', `SW2-${natif}-${vlanPirate}`, 24, 200, 0);
  sw1.powerOn(); sw2.powerOn();
  new Cable(`t${natif}-${vlanPirate}`).connect(
    sw1.getPort('FastEthernet0/24')!, sw2.getPort('FastEthernet0/24')!);
  for (const sw of [sw1, sw2]) {
    await cli(sw, ['enable', 'configure terminal',
      'vlan 10', 'exit', `vlan ${natif}`, 'exit', `vlan ${vlanPirate}`, 'exit',
      'interface FastEthernet0/24',
      'switchport trunk encapsulation dot1q', 'switchport mode trunk',
      `switchport trunk native vlan ${natif}`, 'end']);
    if (tagNatif) await cli(sw, ['enable', 'configure terminal', 'vlan dot1q tag native', 'end']);
  }
  await cli(sw1, ['enable', 'configure terminal', 'interface FastEthernet0/1',
    'switchport mode access', `switchport access vlan ${vlanPirate}`, 'end']);
  return { sw1, sw2 };
}

type TrameBrute = Parameters<ReturnType<CiscoSwitch['getPort']>['receiveFrame']>[0];

function injecter(sw: CiscoSwitch, mac: string, etiquettes: object): void {
  sw.getPort('FastEthernet0/1')!.receiveFrame({
    srcMAC: new MACAddress(mac),
    dstMAC: MACAddress.broadcast(),
    etherType: 0x0800,
    ...etiquettes,
    payload: { type: 'test' },
  } as unknown as TrameBrute);
}

const doubleEtiquette = (exterieure: number) => ({
  outerDot1q: { tpid: 0x88a8, pcp: 0, dei: 0, vid: exterieure },
  dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: 10 },
});

async function vlanAppris(sw: CiscoSwitch, mac: string): Promise<number | null> {
  const table = await sw.executeCommand('show mac address-table');
  const motif = new RegExp(mac.replace(/:/g, '[.:]?'), 'i');
  const ligne = table.split('\n').find((l) => motif.test(l));
  if (!ligne) return null;
  const vlan = parseInt(ligne.trim().split(/\s+/)[0], 10);
  return Number.isFinite(vlan) ? vlan : null;
}

describe('S-02 — le saut de VLAN par double etiquetage', () => {
  it('TEMOIN DU LABO — trunk non durci : le saut ABOUTIT, la trame atterrit en VLAN 10', async () => {
    const { sw1, sw2 } = await labDeuxCommutateurs(1, 1, false);
    injecter(sw1, PIRATE, doubleEtiquette(1));
    expect(await vlanAppris(sw2, PIRATE)).toBe(10);
  });

  it('un VLAN natif distinct du VLAN du pirate referme le saut', async () => {
    const { sw1, sw2 } = await labDeuxCommutateurs(999, 1, false);
    injecter(sw1, PIRATE, doubleEtiquette(1));
    expect(await vlanAppris(sw2, PIRATE)).toBe(1);
  });

  it('`vlan dot1q tag native` referme le saut MEME quand le pirate est dans le VLAN natif', async () => {
    const { sw1, sw2 } = await labDeuxCommutateurs(1, 1, true);
    injecter(sw1, PIRATE, doubleEtiquette(1));
    expect(await vlanAppris(sw2, PIRATE)).toBe(1);
  });

  it('TEMOIN — `vlan dot1q tag native` ne coupe pas le trunk : une trame simple passe', async () => {
    const { sw1, sw2 } = await labDeuxCommutateurs(1, 1, true);
    injecter(sw1, SAGE, {});
    expect(await vlanAppris(sw2, SAGE)).toBe(1);
  });

  it('la commande se rend dans la configuration et `no` la retire', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    sw.powerOn();
    await cli(sw, ['enable', 'configure terminal', 'vlan dot1q tag native', 'end']);
    expect(await sw.executeCommand('show running-config')).toMatch(/^vlan dot1q tag native$/m);
    await cli(sw, ['enable', 'configure terminal', 'no vlan dot1q tag native', 'end']);
    expect(await sw.executeCommand('show running-config')).not.toMatch(/dot1q tag native/);
  });

  it('`?` annonce le mot a chaque niveau, et la forme complete s`execute', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    sw.powerOn();
    await cli(sw, ['enable', 'configure terminal']);
    expect(await sw.executeCommand('vlan ?')).toMatch(/dot1q/);
    expect(await sw.executeCommand('vlan dot1q ?')).toMatch(/tag/);
    expect(await sw.executeCommand('vlan dot1q tag ?')).toMatch(/native/);
    expect(await sw.executeCommand('vlan dot1q tag native')).toBe('');
  });
});

async function nasAvecRadiusInjoignable(methodes: string) {
  const rt = new CiscoRouter(`NAS-${methodes.replace(/\s+/g, '-')}`, 0, 0);
  rt.powerOn();
  await cli(rt, ['enable', 'configure terminal',
    'username local15 privilege 15 secret Local@2025',
    'aaa new-model',
    'radius server INJOIGNABLE',
    'address ipv4 192.0.2.99 auth-port 1812 acct-port 1813',
    'key Radius@2025', 'exit',
    'aaa group server radius GRP', 'server name INJOIGNABLE', 'exit',
    'radius-server timeout 1', 'radius-server retransmit 0',
    `aaa authentication login default ${methodes}`, 'end']);
  return rt;
}

describe('S-03 — le repli `local` apres un groupe RADIUS injoignable', () => {
  it('un serveur RADIUS injoignable laisse la chaine repliER sur `local`', async () => {
    const rt = await nasAvecRadiusInjoignable('group GRP local');
    expect(await rt.authenticateViaAaa('local15', 'Local@2025')).toBe(true);
  }, 30000);

  it('sans `local` dans la liste, la meme chaine REFUSE', async () => {
    const rt = await nasAvecRadiusInjoignable('group GRP');
    expect(await rt.authenticateViaAaa('local15', 'Local@2025')).toBe(false);
  }, 30000);

  it('TEMOIN — le repli n`accorde pas a un mauvais mot de passe', async () => {
    const rt = await nasAvecRadiusInjoignable('group GRP local');
    expect(await rt.authenticateViaAaa('local15', 'MauvaisMotDePasse')).toBe(false);
  }, 30000);

});

describe('S-04 — `radius-server timeout` / `retransmit` globaux', () => {
  it('un serveur declare par `radius server <nom>` ne prend pas les defauts a la place des globaux', async () => {
    const rt = await nasAvecRadiusInjoignable('group GRP local');
    const serveur = [...getSecurityConfig(rt).radiusServers.values()][0];
    expect(serveur.timeoutSec).toBeUndefined();
    expect(serveur.retransmit).toBeUndefined();
  }, 30000);

  it('le delai global est REELLEMENT applique : une chaine vers un serveur muet rend sous 5 s', async () => {
    const rt = await nasAvecRadiusInjoignable('group GRP local');
    const debut = Date.now();
    await rt.authenticateViaAaa('local15', 'Local@2025');
    expect(Date.now() - debut).toBeLessThan(5000);
  }, 30000);
});

describe('S-05 — la colonne `Vlan` de `show ip arp inspection statistics`', () => {
  async function labDai() {
    const sw = new CiscoSwitch('switch-cisco', 'SW-DAI', 24, 0, 0);
    const victime = new LinuxPC('linux-pc', 'VICTIME', -150, -50);
    const pirate = new LinuxPC('linux-pc', 'PIRATE', -150, 50);
    sw.powerOn(); victime.powerOn(); pirate.powerOn();
    new Cable('dv').connect(victime.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('dp').connect(pirate.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await victime.executeCommand('ip addr add 10.0.0.10/24 dev eth0');
    await victime.executeCommand('ip link set eth0 up');
    await pirate.executeCommand('ip addr add 10.0.0.66/24 dev eth0');
    await pirate.executeCommand('ip link set eth0 up');
    await cli(sw, ['enable', 'configure terminal', 'ip arp inspection vlan 1', 'end']);
    return { sw, pirate };
  }

  it('les compteurs se rangent par VLAN, et non sous un `(all)` qui n`est pas un VLAN', async () => {
    const { sw, pirate } = await labDai();
    await pirate.executeCommand('arping -c 2 -U -s 10.0.0.10 -I eth0 10.0.0.10');
    const sortie = await sw.executeCommand('show ip arp inspection statistics');
    expect(sortie).not.toMatch(/\(all\)/);
    expect(sortie).toMatch(/^\s*1\s+\d+\s+[1-9]\d*\s/m);
  }, 30000);

  it('TEMOIN — l`ARP gratuit a liaison fausse est bien REJETE, pas seulement compte', async () => {
    const { sw, pirate } = await labDai();
    await pirate.executeCommand('arping -c 2 -U -s 10.0.0.10 -I eth0 10.0.0.10');
    expect(await sw.executeCommand('show ip arp inspection log'))
      .toMatch(/10\.0\.0\.10\s+2\s+DHCP Deny/);
  }, 30000);
});
