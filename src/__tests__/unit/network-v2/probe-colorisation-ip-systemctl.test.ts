/**
 * `ip -c` et `systemctl status` : les deux commandes que le parseur ANSI,
 * une fois réparé, n'avait toujours rien à colorier.
 *
 * Mesuré en capture d'écran : le terminal rendait `ip -c a` entièrement
 * blanc et `systemctl status ssh` avec une pastille blanche. Ce n'était
 * pas le rendu qui manquait — il sait tout afficher depuis la reprise du
 * parseur — mais l'ÉMISSION : `executeIpCommand` ignore en silence toute
 * option inconnue, donc `-c` tombait dans ce trou, et `renderUnitStatus`
 * n'a jamais écrit la moindre séquence.
 *
 * Les attentes ci-dessous ne sont pas déduites : elles viennent d'un vrai
 * `iproute2` 6.1 installé pour l'occasion et interrogé avec `cat -v`, plus
 * `lib/color.c` pour la palette IPv6 que ce conteneur (sans IPv6) ne
 * permettait pas de mesurer. Trois détails de disposition en sortent, et
 * aucun ne s'invente : l'espace séparateur est DANS la séquence, le
 * préfixe est dehors sur une adresse d'interface mais dedans sur une
 * route, et `-c` nu vaut `always` et non `auto`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeIpCommand,
  type IpNetworkContext,
  type IpInterfaceInfo,
  type IpRouteEntry,
  type IpNeighborEntry,
} from '@/network/devices/linux/LinuxIpCommand';
import { cmdSystemctl } from '@/network/devices/linux/LinuxProcessCommands';
import { LinuxServiceManager } from '@/network/devices/linux/LinuxServiceManager';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

// La palette « fond sombre » d'iproute2, celle qui s'applique à un
// terminal comme le nôtre.
const IFNAME = '[1;36m';
const MAC = '[1;33m';
const INET = '[1;35m';
const INET6 = '[1;94m';
const UP = '[1;32m';
const DOWN = '[1;31m';
const OFF = '[0m';

function ctxFactice(overrides: Partial<IpNetworkContext> = {}): IpNetworkContext {
  const interfaces: Map<string, IpInterfaceInfo> = new Map([
    ['lo', {
      name: 'lo', mac: '00:00:00:00:00:00',
      ip: '127.0.0.1', mask: '255.0.0.0', cidr: 8,
      mtu: 65536, isUp: true, isConnected: true, isDHCP: false,
      counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
    }],
    ['eth0', {
      name: 'eth0', mac: 'aa:bb:cc:dd:ee:01',
      ip: '192.168.1.10', mask: '255.255.255.0', cidr: 24,
      mtu: 1500, isUp: true, isConnected: true, isDHCP: false,
      ipv6: [{ address: '2001:db8::1', prefixLength: 64, scope: 'global' }],
      counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
    }],
    ['eth1', {
      name: 'eth1', mac: 'aa:bb:cc:dd:ee:02',
      ip: null, mask: null, cidr: null,
      mtu: 1500, isUp: false, isConnected: false, isDHCP: false,
      counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
    }],
  ] as unknown as [string, IpInterfaceInfo][]);

  const routes: IpRouteEntry[] = [
    { network: '192.168.1.0', cidr: 24, nextHop: null, iface: 'eth0', type: 'connected', metric: 0, isDHCP: false, srcIp: '192.168.1.10' },
    { network: '0.0.0.0', cidr: 0, nextHop: '192.168.1.1', iface: 'eth0', type: 'default', metric: 0, isDHCP: false },
  ];
  const neighbors: IpNeighborEntry[] = [
    { ip: '192.168.1.1', mac: 'aa:bb:cc:00:00:01', iface: 'eth0', state: 'REACHABLE' },
  ];

  return {
    getInterfaceNames: () => [...interfaces.keys()],
    getIfIndex: (name: string) => [...interfaces.keys()].indexOf(name) + 1,
    getInterfaceInfo: (name: string) => interfaces.get(name) || null,
    configureInterface: () => '',
    removeInterfaceIP: () => '',
    getRoutingTable: () => routes,
    addDefaultRoute: () => '',
    addStaticRoute: () => '',
    deleteDefaultRoute: () => '',
    deleteRoute: () => '',
    getNeighborTable: () => neighbors,
    addNeighbor: () => '',
    deleteNeighbor: () => '',
    flushNeighbors: () => '',
    setInterfaceUp: () => '',
    setInterfaceDown: () => '',
    setInterfaceMTU: () => '',
    ...overrides,
  };
}

describe('`ip -c` colorie, `ip` tout court reste nu', () => {
  let ctx: IpNetworkContext;
  beforeEach(() => { ctx = ctxFactice(); });

  it('sans `-c`, pas un seul octet d\'échappement', () => {
    for (const objet of [['addr'], ['link'], ['route'], ['neigh'], ['-br', 'addr']]) {
      expect(executeIpCommand(ctx, objet).includes(''), objet.join(' ')).toBe(false);
    }
  });

  it('le nom d\'interface porte son `: ` DANS la couleur', () => {
    const out = executeIpCommand(ctx, ['-c', 'addr', 'show', 'dev', 'eth0']);
    expect(out).toContain(`2: ${IFNAME}eth0: ${OFF}<`);
  });

  it('l\'état opérationnel emporte l\'espace qui le suit, vert ou rouge', () => {
    const out = executeIpCommand(ctx, ['-c', 'addr']);
    expect(out).toContain(`state ${UP}UP ${OFF}group`);
    expect(out).toContain(`state ${DOWN}DOWN ${OFF}group`);
  });

  it('l\'adresse est coloriée mais PAS son préfixe', () => {
    const out = executeIpCommand(ctx, ['-c', 'addr', 'show', 'dev', 'eth0']);
    expect(out).toContain(`inet ${INET}192.168.1.10${OFF}/24`);
    // Le `/24` hors couleur : une attente qu'on ne peut pas satisfaire par
    // hasard en enveloppant « l'adresse » au sens large.
    expect(out).not.toContain(`${INET}192.168.1.10/24`);
  });

  it('les deux adresses MAC de la ligne link/ether', () => {
    const out = executeIpCommand(ctx, ['-c', 'link', 'show', 'dev', 'eth0']);
    expect(out).toContain(`link/ether ${MAC}aa:bb:cc:dd:ee:01${OFF} brd ${MAC}ff:ff:ff:ff:ff:ff${OFF}`);
  });

  it('l\'IPv6 a sa propre teinte, distincte de l\'IPv4', () => {
    const out = executeIpCommand(ctx, ['-c', 'addr', 'show', 'dev', 'eth0']);
    expect(out).toContain(`inet6 ${INET6}2001:db8::1${OFF}/64`);
    expect(INET6).not.toBe(INET);
  });

  it('sur une route, le préfixe est DEDANS — l\'autre convention', () => {
    const out = executeIpCommand(ctx, ['-c', 'route']);
    expect(out).toContain(`${INET}192.168.1.0/24 ${OFF}dev ${IFNAME}eth0 ${OFF}proto kernel`);
    expect(out).toContain(`default via ${INET}192.168.1.1 ${OFF}dev ${IFNAME}eth0 ${OFF}proto`);
  });

  it('le voisin : adresse, interface et lladdr', () => {
    const out = executeIpCommand(ctx, ['-c', 'neigh']);
    expect(out).toContain(`${INET}192.168.1.1 ${OFF}dev ${IFNAME}eth0 ${OFF}lladdr ${MAC}aa:bb:cc:00:00:01 ${OFF}REACHABLE`);
  });

  it('en mode bref, la couleur enveloppe la COLONNE complétée', () => {
    const out = executeIpCommand(ctx, ['-c', '-br', 'addr']);
    expect(out).toContain(`${IFNAME}eth0            ${OFF}${UP}UP            ${OFF}${INET}192.168.1.10${OFF}/24`);
  });

  it('les orthographes que le vrai `ip` accepte par préfixe', () => {
    for (const opt of ['-c', '-co', '-col', '-color', '--color', '-c=always']) {
      expect(executeIpCommand(ctx, [opt, 'addr']).includes(IFNAME), opt).toBe(true);
    }
  });

  it('`-c=never` éteint, et la sortie redevient exactement celle sans option', () => {
    expect(executeIpCommand(ctx, ['-c=never', 'addr'])).toBe(executeIpCommand(ctx, ['addr']));
  });

  it('`-c=auto` suit le terminal : nu dans un tube, colorié au prompt', () => {
    expect(executeIpCommand(ctx, ['-c=auto', 'addr'], true).includes('')).toBe(false);
    expect(executeIpCommand(ctx, ['-c=auto', 'addr'], false)).toContain(IFNAME);
  });

  it('`-c` nu vaut `always`, pas `auto` — il colorie même dans un tube', () => {
    // Contre-intuitif, et mesuré : `ip -c a | cat` colorie quand même.
    expect(executeIpCommand(ctx, ['-c', 'addr'], true)).toContain(IFNAME);
  });

  it('une valeur inconnue est refusée avec le message du vrai binaire', () => {
    expect(executeIpCommand(ctx, ['-c=bogus', 'addr']))
      .toBe('Option "-c=bogus" is unknown, try "ip -help".');
  });

  it('le JSON n\'est jamais colorié — il serait illisible par une machine', () => {
    const out = executeIpCommand(ctx, ['-c', '-j', 'addr', 'show', 'dev', 'eth0']);
    expect(out.includes('')).toBe(false);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe('`systemctl status` colorie son état', () => {
  const gestionnaire = () =>
    new LinuxServiceManager(new VirtualFileSystem(), new LinuxProcessManager(), { isServer: false });

  it('la pastille et l\'état sont verts quand l\'unité tourne', () => {
    const sm = gestionnaire();
    sm.start('ssh');
    const out = cmdSystemctl(['status', 'ssh'], sm, true).output;
    expect(out).toContain('[0;1;32m●[0m ssh.service');
    expect(out).toContain('Active: [0;1;32mactive (running)[0m since ');
  });

  it('la date reste HORS de la couleur', () => {
    const sm = gestionnaire();
    sm.start('ssh');
    const out = cmdSystemctl(['status', 'ssh'], sm, true).output;
    const ligne = out.split('\n').find((l) => l.includes('Active:'))!;
    // Le vert se ferme avant le ` since ` : systemd n'habille que
    // `état (sous-état)`.
    expect(ligne).toContain('[0;1;32m');
    expect(ligne.indexOf('[0m')).toBeLessThan(ligne.indexOf(' since '));
  });

  it('une unité arrêtée n\'est ni verte ni rouge — systemd ne la colorie pas', () => {
    const sm = gestionnaire();
    sm.stop('ssh');
    const out = cmdSystemctl(['status', 'ssh'], sm, true).output;
    expect(out.includes('')).toBe(false);
    expect(out).toContain('○ ssh.service');
  });

  it('sans terminal, aucune séquence n\'entre dans le tube', () => {
    const sm = gestionnaire();
    sm.start('ssh');
    const nu = cmdSystemctl(['status', 'ssh'], sm, false).output;
    expect(nu.includes('')).toBe(false);
    expect(nu).toContain('● ssh.service');
    expect(nu).toContain('Active: active (running) since ');
  });

  it('la sortie coloriée, dépouillée de ses séquences, est celle d\'avant', () => {
    const sm = gestionnaire();
    sm.start('ssh');
    const couleur = cmdSystemctl(['status', 'ssh'], sm, true).output;
    const nu = cmdSystemctl(['status', 'ssh'], sm, false).output;
    // Sans cette ligne, deux sorties également nues satisferaient le test.
    expect(couleur).toContain('[');
    // eslint-disable-next-line no-control-regex
    expect(couleur.replace(/\[[0-9;]*m/g, '')).toBe(nu);
  });
});
