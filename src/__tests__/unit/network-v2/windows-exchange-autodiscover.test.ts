import { describe, it, expect } from 'vitest';
import {
  parseAutodiscoverRequestXml, renderAutodiscoverSuccessXml, renderAutodiscoverErrorXml, type AutodiscoverResponse,
} from '@/network/devices/windows/server/exchange/Autodiscover';

describe('parseAutodiscoverRequestXml (docs/PRD-Exchange.md §4.7, P8)', () => {
  it('extracts the EMailAddress element from a real MS-OXDSCLI request body', () => {
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">',
      '  <Request>',
      '    <EMailAddress>bob@mandeng.lan</EMailAddress>',
      '    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>',
      '  </Request>',
      '</Autodiscover>',
    ].join('\n');
    expect(parseAutodiscoverRequestXml(xml)).toBe('bob@mandeng.lan');
  });

  it('returns null when EMailAddress is missing', () => {
    expect(parseAutodiscoverRequestXml('<Autodiscover><Request/></Autodiscover>')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseAutodiscoverRequestXml('not xml at all')).toBeNull();
  });
});

describe('renderAutodiscoverSuccessXml (docs/PRD-Exchange.md §4.7, P8)', () => {
  it('serializes into the real MS-OXDSCLI response schema/namespace with Account/Protocol/Server/LoginName', () => {
    const response: AutodiscoverResponse = {
      smtpAddress: 'bob@mandeng.lan', displayName: 'Bob Smith', mailboxServer: 'DC01.mandeng.lan', protocol: 'Exchange',
    };
    const xml = renderAutodiscoverSuccessXml(response);
    expect(xml).toContain('http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a');
    expect(xml).toContain('<Server>DC01.mandeng.lan</Server>');
    expect(xml).toContain('<LoginName>bob@mandeng.lan</LoginName>');
    expect(xml).toContain('<Type>Exchange</Type>');
    expect(xml).toContain('<DisplayName>Bob Smith</DisplayName>');
  });
});

describe('renderAutodiscoverErrorXml (docs/PRD-Exchange.md §4.7, P8)', () => {
  it('serializes an Error element carrying the failure message', () => {
    const xml = renderAutodiscoverErrorXml("The email address can't be found.");
    expect(xml).toContain('<Error');
    expect(xml).toContain("The email address can't be found.");
  });
});
