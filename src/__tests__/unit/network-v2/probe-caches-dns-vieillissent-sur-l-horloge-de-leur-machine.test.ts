/**
 * Un cache DNS vieillit sur l'horloge de SA machine. `DnsCache` retombait sur `simulationNowMs()` quand on ne lui donnait pas
 * d'horloge, ce que faisaient le client DNS d'un poste Windows (`WindowsPC.dnsCache`), le resolveur de BIND (`Bind9Service`)
 * et `systemd-resolved` (`getResolvedService()` ne passait pas `now`) : apres `date -s` de +2 mois, un enregistrement de TTL
 * 300 s restait « vivant » et `ipconfig /displaydns` / `dig` en rendaient la valeur perimee. Corrige : les trois lisent
 * `getSystemClockMs()` / `executor.simulatedDate()` de leur machine, comme le cache du resolveur Windows Server, celui du
 * pare-feu et le `now` deja passe a `WindowsDnsServerRole`.
 *
 * Discrimine par `git stash` sur src/network : 2 des 3 cas tombent avant (poste Windows et BIND). Le TEMOIN (l'entree vit
 * avant l'echeance de son TTL) passe des deux cotes. `systemd-resolved` n'a pas de sonde propre ici : son cache est interrogeable
 * par `resolvectl statistics` apres une vraie resolution, hors de portee d'un test unitaire sans serveur amont.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType } from '@/network/dns/wire/RRType';

const SECOND = 1000;

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('un cache DNS vieillit sur l horloge de sa machine', () => {
  it('TEMOIN — avant l echeance du TTL, l entree du poste Windows est servie', () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    pc.dnsCache.storePositive([makeARecord('www.example.com', 300, '192.0.2.10')]);
    pc._stepSystemClock(100 * SECOND);
    expect(pc.dnsCache.lookup('www.example.com', RRType.A).kind).toBe('hit');
  });

  it('un poste Windows avance de 301 s a perdu l entree de TTL 300', () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    pc.dnsCache.storePositive([makeARecord('www.example.com', 300, '192.0.2.10')]);
    pc._stepSystemClock(301 * SECOND);
    expect(pc.dnsCache.lookup('www.example.com', RRType.A).kind).not.toBe('hit');
  });

  it('le resolveur de BIND vieillit aussi sur l horloge du serveur', () => {
    const srv = new LinuxServer('linux-server', 'DNS1');
    const cache = (srv as unknown as { bind9: { cache: { storePositive(r: unknown[]): void; lookup(n: string, t: number): { kind: string } } } }).bind9.cache;
    cache.storePositive([makeARecord('www.example.com', 300, '192.0.2.10')]);
    srv._stepSystemClock(301 * SECOND);
    expect(cache.lookup('www.example.com', RRType.A).kind).not.toBe('hit');
  });
});
