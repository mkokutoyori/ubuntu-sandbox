/**
 * Sonde de la validation DNSSEC de named (RFC 4035 §3.2.2, §3.2.3, RFC 6840 §5.7).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 5 cas sur 6 tombent.
 *   - named.conf refusait « trust-anchors » : named ne démarre pas
 *   - aucun résolveur n'était construit avec des ancres, donc jamais de
 *     validation, jamais de bit AD, et une réponse falsifiée passait
 *   - le bit CD de la requête n'était pas renvoyé
 * Passe avant et après (témoin) : sans ancre, une réponse est servie sans AD.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import { lab, ask } from './_bindDnssecLab';
beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('named — validation DNSSEC', () => {
  it('témoin : sans ancre, la réponse est servie sans bit AD', async () => {
    const { pc } = await lab({ anchor: false });
    const r = await ask(pc, { dnssecOk: true });
    expect(r?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r?.flags.ad).toBe(false);
  });

  it('avec ancre et DO, la réponse validée porte AD et ses RRSIG', async () => {
    const { pc, start } = await lab({ anchor: true });
    expect(start).not.toContain('Failed');
    const r = await ask(pc, { dnssecOk: true });
    expect(r?.flags.ad).toBe(true);
    expect(r?.answers.some((rr) => rr.data.type === RRType.RRSIG)).toBe(true);
  });

  it('sans DO ni AD dans la requête, pas de bit AD et pas de RRSIG', async () => {
    const { pc } = await lab({ anchor: true });
    const r = await ask(pc, {});
    expect(r?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r?.flags.ad).toBe(false);
    expect(r?.answers.some((rr) => rr.data.type === RRType.RRSIG)).toBe(false);
  });

  it('une requête avec AD (RFC 6840 §5.7) obtient AD sans DO', async () => {
    const { pc } = await lab({ anchor: true });
    const r = await ask(pc, { ad: true });
    expect(r?.flags.ad).toBe(true);
  });

  it('une réponse falsifiée est bogus : SERVFAIL', async () => {
    const { pc } = await lab({ anchor: true, tamper: true });
    const r = await ask(pc, { dnssecOk: true });
    expect(r?.flags.rcode).toBe(DnsRcode.SERVFAIL);
  });

  it('avec CD, la même réponse falsifiée est rendue et CD est renvoyé', async () => {
    const { pc } = await lab({ anchor: true, tamper: true });
    const r = await ask(pc, { dnssecOk: true, cd: true });
    expect(r?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r?.flags.cd).toBe(true);
    expect(r?.flags.ad).toBe(false);
  });
});
