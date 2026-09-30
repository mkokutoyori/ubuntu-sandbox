/**
 * Sémantique de `update-policy` de named (règles grant/deny dans l'ordre, types
 * par défaut, ANY, types de nom, identité signataire). Module neuf : tous les
 * cas échouent avant, par absence du module ; le témoin « non signé refusé »
 * prouve que le laboratoire ne se contente pas de tout accepter.
 */
import { describe, it, expect } from 'vitest';
import { RRType } from '@/network/dns/wire/RRType';
import { parseNamedConf } from '@/network/devices/linux/bind9/NamedConfParser';
import { parseUpdatePolicyRule, updatePolicyPermits } from '@/network/devices/linux/bind9/NamedUpdatePolicy';

function rules(...lines: string[]) {
  const statements = parseNamedConf(`policy { ${lines.join(' ')} };`, { file: 'test.conf', readInclude: () => null });
  return statements[0].block!.map(parseUpdatePolicyRule);
}

describe('update-policy', () => {
  it('témoin : une requête non signée n’est jamais permise', () => {
    expect(updatePolicyPermits(rules('grant * zonesub ANY;'), null, 'example.com', 'a.example.com', RRType.A)).toBe(false);
  });

  it('zonesub : toute la zone, rien en dehors', () => {
    const r = rules('grant k zonesub ANY;');
    expect(updatePolicyPermits(r, 'k', 'example.com', 'a.b.example.com', RRType.A)).toBe(true);
    expect(updatePolicyPermits(r, 'k', 'example.com', 'other.org', RRType.A)).toBe(false);
  });

  it('types omis : tout sauf SOA, NS, RRSIG, NSEC ; ANY : tout sauf NSEC', () => {
    const byDefault = rules('grant k zonesub;');
    expect(updatePolicyPermits(byDefault, 'k', 'example.com', 'a.example.com', RRType.A)).toBe(true);
    expect(updatePolicyPermits(byDefault, 'k', 'example.com', 'example.com', RRType.NS)).toBe(false);
    const any = rules('grant k zonesub ANY;');
    expect(updatePolicyPermits(any, 'k', 'example.com', 'example.com', RRType.NS)).toBe(true);
    expect(updatePolicyPermits(any, 'k', 'example.com', 'example.com', RRType.NSEC)).toBe(false);
  });

  it('les règles s’évaluent dans l’ordre : un deny placé avant l’emporte', () => {
    const r = rules('deny k name secret.example.com. ANY;', 'grant k zonesub ANY;');
    expect(updatePolicyPermits(r, 'k', 'example.com', 'secret.example.com', RRType.A)).toBe(false);
    expect(updatePolicyPermits(r, 'k', 'example.com', 'public.example.com', RRType.A)).toBe(true);
  });

  it('self, selfsub, selfwild, subdomain et wildcard', () => {
    expect(updatePolicyPermits(rules('grant h.example.com self * A;'), 'h.example.com', 'example.com', 'h.example.com', RRType.A)).toBe(true);
    expect(updatePolicyPermits(rules('grant h.example.com self * A;'), 'h.example.com', 'example.com', 'x.example.com', RRType.A)).toBe(false);
    expect(updatePolicyPermits(rules('grant h.example.com selfsub * A;'), 'h.example.com', 'example.com', 'x.h.example.com', RRType.A)).toBe(true);
    expect(updatePolicyPermits(rules('grant h.example.com selfwild * A;'), 'h.example.com', 'example.com', 'x.h.example.com', RRType.A)).toBe(true);
    expect(updatePolicyPermits(rules('grant h.example.com selfwild * A;'), 'h.example.com', 'example.com', 'y.x.h.example.com', RRType.A)).toBe(false);
    expect(updatePolicyPermits(rules('grant k subdomain dyn.example.com. A;'), 'k', 'example.com', 'a.dyn.example.com', RRType.A)).toBe(true);
    expect(updatePolicyPermits(rules('grant k wildcard *.dyn.example.com. A;'), 'k', 'example.com', 'dyn.example.com', RRType.A)).toBe(false);
  });

  it('un type de nom qu’on ne sait pas décider (krb5-self) n’accorde rien', () => {
    const r = rules('grant EXAMPLE.COM krb5-self * A;', 'grant k zonesub TXT;');
    expect(updatePolicyPermits(r, 'EXAMPLE.COM', 'example.com', 'a.example.com', RRType.A)).toBe(false);
  });
});
