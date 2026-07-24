import { describe, it, expect } from 'vitest';
import { parseBinding, ipAllowedByRanges, matchesAddressSpace, selectSendConnector, type SendConnectorDef } from '@/network/devices/windows/server/exchange/TransportConnector';

describe('parseBinding() (docs/PRD-Exchange.md §4.4, P5)', () => {
  it('parses host:port', () => {
    expect(parseBinding('0.0.0.0:25')).toEqual({ host: '0.0.0.0', port: 25 });
  });

  it('returns null for a malformed binding', () => {
    expect(parseBinding('not-a-binding')).toBeNull();
    expect(parseBinding('0.0.0.0:notaport')).toBeNull();
  });
});

describe('ipAllowedByRanges()', () => {
  it('allows any IP when no ranges are configured', () => {
    expect(ipAllowedByRanges('203.0.113.5', [])).toBe(true);
  });

  it('allows an IP inside a configured CIDR range', () => {
    expect(ipAllowedByRanges('203.0.113.5', ['203.0.113.0/24'])).toBe(true);
  });

  it('rejects an IP outside every configured range', () => {
    expect(ipAllowedByRanges('198.51.100.9', ['203.0.113.0/24'])).toBe(false);
  });

  it('allows a bare IP (implicit /32) exact match', () => {
    expect(ipAllowedByRanges('203.0.113.5', ['203.0.113.5'])).toBe(true);
    expect(ipAllowedByRanges('203.0.113.6', ['203.0.113.5'])).toBe(false);
  });
});

describe('matchesAddressSpace() / selectSendConnector()', () => {
  it('"*" matches any domain', () => {
    expect(matchesAddressSpace('anything.example', ['*'])).toBe(true);
  });

  it('a specific domain only matches itself, case-insensitively', () => {
    expect(matchesAddressSpace('Partner.Mandeng.LAN', ['partner.mandeng.lan'])).toBe(true);
    expect(matchesAddressSpace('other.example', ['partner.mandeng.lan'])).toBe(false);
  });

  it('selectSendConnector picks the lowest-cost matching connector', () => {
    const connectors: SendConnectorDef[] = [
      { name: 'Wildcard', addressSpaces: ['*'], smartHosts: [], costMetric: 10 },
      { name: 'Partner', addressSpaces: ['partner.mandeng.lan'], smartHosts: ['10.0.0.5'], costMetric: 1 },
    ];
    const selected = selectSendConnector('partner.mandeng.lan', connectors);
    expect(selected?.name).toBe('Partner');
  });

  it('falls back to the wildcard connector when no specific match exists', () => {
    const connectors: SendConnectorDef[] = [
      { name: 'Wildcard', addressSpaces: ['*'], smartHosts: [], costMetric: 10 },
      { name: 'Partner', addressSpaces: ['partner.mandeng.lan'], smartHosts: ['10.0.0.5'], costMetric: 1 },
    ];
    const selected = selectSendConnector('elsewhere.example', connectors);
    expect(selected?.name).toBe('Wildcard');
  });

  it('returns null when nothing matches', () => {
    const connectors: SendConnectorDef[] = [
      { name: 'Partner', addressSpaces: ['partner.mandeng.lan'], smartHosts: [], costMetric: 1 },
    ];
    expect(selectSendConnector('elsewhere.example', connectors)).toBeNull();
  });
});
