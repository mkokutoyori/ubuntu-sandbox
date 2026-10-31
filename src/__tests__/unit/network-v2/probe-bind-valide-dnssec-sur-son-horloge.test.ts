/**
 * La fenetre de validite d'une signature DNSSEC (RFC 4035 §5.3.1 : inception <= maintenant <= expiration) est lue sur
 * l'horloge du validateur. Les resolveurs construits par BIND (`Bind9Service`), par `systemd-resolved` (`LinuxMachine`) et
 * par le role DNS de Windows Server donnaient `{ anchors }` sans `now`, donc le validateur lisait l'heure globale : un named
 * dont on avait avance l'horloge de deux ans validait toujours des signatures de trente jours. Corrige : les trois passent
 * l'horloge de leur machine.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (named en avance de deux ans). Le TEMOIN (a l'heure,
 * la reponse est validee, bit AD) passe des deux cotes. `systemd-resolved` et Windows Server partagent le mecanisme sans
 * sonde propre ici ; leur propre sonde de validation (`probe-resolvectl-02-dnssec`, `windows-dns-dnssec-validation-probe`) passe
 * avant et apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { lab, ask } from './_bindDnssecLab';

const TWO_YEARS = 2 * 365 * 24 * 3600 * 1000;

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

describe('named valide les signatures DNSSEC sur son horloge', () => {
  it('TEMOIN — a l heure, la reponse est validee (AD)', async () => {
    const { pc } = await lab({ anchor: true });
    const r = await ask(pc, { dnssecOk: true });
    expect(r?.flags.ad).toBe(true);
  });

  it('un named avance de deux ans trouve les signatures expirees : SERVFAIL', async () => {
    const { pc, ns } = await lab({ anchor: true });
    ns._stepSystemClock(TWO_YEARS);
    const r = await ask(pc, { dnssecOk: true });
    expect(r?.flags.rcode).toBe(DnsRcode.SERVFAIL);
  });
});
