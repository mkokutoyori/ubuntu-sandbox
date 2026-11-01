/**
 * Ce qu'un hote Linux retient d'une annonce de routeur (RFC 4861 §6.3.4, RFC 4191). Mesure de depart : la route par defaut apprise s'affichait `metric 0 pref medium` sans
 * echeance, la preference annoncee et les durees de vie etaient ignorees, une annonce de duree de vie zero ne retirait rien, une option Route Information n'etait jamais lue et la route
 * du prefixe n'expirait pas avec sa duree de vie. Ce que le noyau fixe et que ce fichier mesure : route par defaut `proto ra metric 1024 expires <duree> pref <low|medium|high>` ;
 * route de prefixe `metric 256 expires <duree de validite>` ; une duree de vie zero retire la route ; l'option Route Information n'est lue que si sa longueur de prefixe tient dans
 * [accept_ra_rt_info_min_plen, accept_ra_rt_info_max_plen] (defauts 0 et 0, donc ignoree pour un /48) ; accept_ra_rtr_pref=0 ramene toute preference a medium ; une route expiree
 * disparait de `ip -6 route` et ne sert plus a l'acheminement. Reserves (TODO.md) : RDNSS, DNSSL, MTU et saut limite d'une annonce ne sont pas lus par l'hote.
 *
 * Discrimine par `git stash` sur src/network : 7 cas tombent avant (les deux de la route par defaut dont le temoin, la decroissance, le retrait, les deux de la route de prefixe, la route d'information installee, son retrait).
 * Les 4 autres passent avant comme apres : TEMOIN la route par defaut existe ; TEMOIN le /48 est ignore avec les defauts du noyau (vrai avant par ignorance de l'option, vrai apres par la borne max_plen=0) ;
 * min_plen=56 et accept_ra_rtr_pref=0 passent avant POUR UNE MAUVAISE RAISON (l'option ou la preference n'etait pas lue) : leur sens repose sur les cas freres qui installent la route
 * ou affichent `high` avec les memes reglages sauf le bouton.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock } from '../../support/ntpTime';
import { radvdLab } from '../../support/radvdLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  EquipmentRegistry.getInstance().clear();
});

const lab = (config: string) => radvdLab(clock, config);

const SLOW = (body: string, extra = '') =>
  `interface eth0 {\n  AdvSendAdvert on;\n  MinRtrAdvInterval 600;\n  MaxRtrAdvInterval 1800;\n  ${extra}\n  ${body}\n};`;

const advance = async (seconds: number): Promise<void> => { await clock.advance(seconds * 1000); };

describe('the default router', () => {
  it('is installed with the kernel metric, the advertised lifetime and preference', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };', 'AdvDefaultLifetime 1800; AdvDefaultPreference high;'));
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).toMatch(/^default via fe80::\S+ dev eth0 proto ra metric 1024 expires 1800sec pref high$/m);
  });

  it('WITNESS — the route exists and shows no expiry only on a static default', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };'));
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).toMatch(/^default via fe80::/m);
  });

  it('counts down on the simulated clock', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };', 'AdvDefaultLifetime 1800;'));
    await onRouter('systemctl start radvd');
    await advance(32);
    await advance(100);
    const left = Number(/^default .* expires (\d+)sec/m.exec(await onHost('ip -6 route show'))?.[1]);
    expect(left).toBeGreaterThan(1600);
    expect(left).toBeLessThan(1720);
  });

  it('is withdrawn by the final advertisement of lifetime zero', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };'));
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).toMatch(/^default/m);
    await onRouter('systemctl stop radvd');
    expect(await onHost('ip -6 route show')).not.toMatch(/^default/m);
  });

  it('accept_ra_rtr_pref=0 brings every preference back to medium', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };', 'AdvDefaultPreference high;'));
    await onHost('sysctl -w net.ipv6.conf.eth0.accept_ra_rtr_pref=0');
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).toMatch(/^default .* pref medium$/m);
  });
});

describe('the prefix route', () => {
  it('is on-link with the kernel metric and expires with the valid lifetime', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { AdvValidLifetime 100; AdvPreferredLifetime 50; };'));
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).toMatch(/^2001:db8:77::\/64 dev eth0 proto ra metric 256 expires 100sec pref medium$/m);
    await advance(100);
    expect(await onHost('ip -6 route show')).toContain('2001:db8:77::/64');
    await advance(50);
    expect(await onHost('ip -6 route show')).not.toContain('2001:db8:77::/64');
  });

  it('an expired route no longer forwards: the destination is unreachable again', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { AdvValidLifetime 100; AdvPreferredLifetime 50; AdvAutonomous off; };', 'AdvDefaultLifetime 0;'));
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route get 2001:db8:77::5')).not.toContain('Network is unreachable');
    await advance(200);
    expect(await onHost('ip -6 route get 2001:db8:77::5')).toContain('Network is unreachable');
  });
});

describe('Route Information (RFC 4191)', () => {
  const ROUTE = 'route 2001:db8:ff::/48 { AdvRouteLifetime 1200; AdvRoutePreference low; };';

  it('WITNESS — with the kernel defaults a /48 is ignored', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };', ROUTE));
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).not.toContain('2001:db8:ff::/48');
  });

  it('is installed once accept_ra_rt_info_max_plen allows its length', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };', ROUTE));
    await onHost('sysctl -w net.ipv6.conf.eth0.accept_ra_rt_info_max_plen=64');
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).toMatch(/^2001:db8:ff::\/48 via fe80::\S+ dev eth0 proto ra metric 1024 expires 1200sec pref low$/m);
  });

  it('is ignored below accept_ra_rt_info_min_plen', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };', ROUTE));
    await onHost('sysctl -w net.ipv6.conf.eth0.accept_ra_rt_info_max_plen=64');
    await onHost('sysctl -w net.ipv6.conf.eth0.accept_ra_rt_info_min_plen=56');
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).not.toContain('2001:db8:ff::/48');
  });

  it('a lifetime of zero withdraws it', async () => {
    const { onRouter, onHost } = await lab(SLOW('prefix 2001:db8:77::/64 { };', ROUTE));
    await onHost('sysctl -w net.ipv6.conf.eth0.accept_ra_rt_info_max_plen=64');
    await onRouter('systemctl start radvd');
    expect(await onHost('ip -6 route show')).toContain('2001:db8:ff::/48');
    await onRouter('systemctl stop radvd');
    expect(await onHost('ip -6 route show')).not.toContain('2001:db8:ff::/48');
  });
});
