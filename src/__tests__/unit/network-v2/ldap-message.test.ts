/**
 * Real LDAPMessage tests: RFC 4511 §4 envelope + protocolOp CHOICE,
 * BER APPLICATION-tag encode/decode round-trip for every operation.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeLdapMessage, decodeLdapMessage, encodeProtocolOp, decodeProtocolOp,
  ldapResult, LdapResultCode,
  type LdapMessage, type ProtocolOp,
} from '@/network/devices/windows/server/ad/ldap/LdapMessage';
import { parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import { parseFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilter';

function roundTripOp(op: ProtocolOp): ProtocolOp {
  const bytes = encodeProtocolOp(op);
  return decodeProtocolOp(parseTLV(bytes, 0));
}

describe('LdapMessage — protocolOp round-trips', () => {
  it('bindRequest (simple bind)', () => {
    const op: ProtocolOp = { kind: 'bindRequest', version: 3, name: 'CN=Administrator,DC=lab,DC=local', password: 'P@ssw0rd' };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('bindResponse — success', () => {
    const op: ProtocolOp = { kind: 'bindResponse', result: ldapResult(LdapResultCode.success) };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('bindResponse — invalidCredentials with a diagnostic message', () => {
    const op: ProtocolOp = {
      kind: 'bindResponse',
      result: ldapResult(LdapResultCode.invalidCredentials, '', 'AcceptSecurityContext error, data 52e'),
    };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('unbindRequest', () => {
    const op: ProtocolOp = { kind: 'unbindRequest' };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('searchRequest — sub scope with a compound filter and explicit attribute selection', () => {
    const op: ProtocolOp = {
      kind: 'searchRequest',
      baseObject: 'DC=lab,DC=local',
      scope: 'sub',
      derefAliases: 0,
      sizeLimit: 0,
      timeLimit: 0,
      typesOnly: false,
      filter: parseFilter('(&(objectClass=user)(sAMAccountName=bob))'),
      attributes: ['cn', 'sAMAccountName'],
    };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('searchRequest — base scope with a presence filter and no attribute selection', () => {
    const op: ProtocolOp = {
      kind: 'searchRequest',
      baseObject: 'CN=Bob,OU=Users,DC=lab,DC=local',
      scope: 'base',
      derefAliases: 0,
      sizeLimit: 100,
      timeLimit: 30,
      typesOnly: true,
      filter: parseFilter('(objectClass=*)'),
      attributes: [],
    };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('searchResultEntry — multi-valued attributes', () => {
    const op: ProtocolOp = {
      kind: 'searchResultEntry',
      objectName: 'CN=Bob,OU=Users,DC=lab,DC=local',
      attributes: [
        { type: 'objectClass', values: ['top', 'person', 'user'] },
        { type: 'sAMAccountName', values: ['bob'] },
      ],
    };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('searchResultDone — success', () => {
    const op: ProtocolOp = { kind: 'searchResultDone', result: ldapResult(LdapResultCode.success) };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('modifyRequest — add/delete/replace changes together', () => {
    const op: ProtocolOp = {
      kind: 'modifyRequest',
      object: 'CN=Bob,OU=Users,DC=lab,DC=local',
      changes: [
        { operation: 'replace', modification: { type: 'mail', values: ['bob@lab.local'] } },
        { operation: 'add', modification: { type: 'telephoneNumber', values: ['555-1234'] } },
        { operation: 'delete', modification: { type: 'description', values: [] } },
      ],
    };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('modifyResponse — noSuchObject', () => {
    const op: ProtocolOp = { kind: 'modifyResponse', result: ldapResult(LdapResultCode.noSuchObject, 'OU=Ghost,DC=lab,DC=local') };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('addRequest — full user entry attributes', () => {
    const op: ProtocolOp = {
      kind: 'addRequest',
      entry: 'CN=Bob,OU=Users,DC=lab,DC=local',
      attributes: [
        { type: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user'] },
        { type: 'sAMAccountName', values: ['bob'] },
        { type: 'userPrincipalName', values: ['bob@lab.local'] },
      ],
    };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('addResponse — entryAlreadyExists', () => {
    const op: ProtocolOp = { kind: 'addResponse', result: ldapResult(LdapResultCode.entryAlreadyExists) };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('delRequest', () => {
    const op: ProtocolOp = { kind: 'delRequest', entry: 'CN=Bob,OU=Users,DC=lab,DC=local' };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('delResponse — notAllowedOnNonLeaf', () => {
    const op: ProtocolOp = { kind: 'delResponse', result: ldapResult(LdapResultCode.notAllowedOnNonLeaf) };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('compareRequest', () => {
    const op: ProtocolOp = { kind: 'compareRequest', entry: 'CN=Bob,OU=Users,DC=lab,DC=local', attributeDesc: 'sAMAccountName', assertionValue: 'bob' };
    expect(roundTripOp(op)).toEqual(op);
  });

  it('compareResponse — compareTrue / compareFalse', () => {
    expect(roundTripOp({ kind: 'compareResponse', result: ldapResult(LdapResultCode.compareTrue) }))
      .toEqual({ kind: 'compareResponse', result: ldapResult(LdapResultCode.compareTrue) });
    expect(roundTripOp({ kind: 'compareResponse', result: ldapResult(LdapResultCode.compareFalse) }))
      .toEqual({ kind: 'compareResponse', result: ldapResult(LdapResultCode.compareFalse) });
  });
});

describe('LdapMessage — full envelope (messageID + protocolOp)', () => {
  it('round-trips a bindRequest with a specific messageID', () => {
    const msg: LdapMessage = {
      messageID: 1,
      protocolOp: { kind: 'bindRequest', version: 3, name: '', password: '' },
    };
    const bytes = encodeLdapMessage(msg);
    expect(decodeLdapMessage(bytes)).toEqual(msg);
  });

  it('round-trips a searchRequest with a larger messageID', () => {
    const msg: LdapMessage = {
      messageID: 42,
      protocolOp: {
        kind: 'searchRequest', baseObject: 'DC=lab,DC=local', scope: 'sub', derefAliases: 0,
        sizeLimit: 0, timeLimit: 0, typesOnly: false, filter: parseFilter('(cn=*)'), attributes: ['*'],
      },
    };
    const bytes = encodeLdapMessage(msg);
    expect(decodeLdapMessage(bytes)).toEqual(msg);
  });

  it('round-trips an unbindRequest', () => {
    const msg: LdapMessage = { messageID: 7, protocolOp: { kind: 'unbindRequest' } };
    const bytes = encodeLdapMessage(msg);
    expect(decodeLdapMessage(bytes)).toEqual(msg);
  });

  it('different messageIDs produce distinguishable encodings', () => {
    const a = encodeLdapMessage({ messageID: 1, protocolOp: { kind: 'unbindRequest' } });
    const b = encodeLdapMessage({ messageID: 2, protocolOp: { kind: 'unbindRequest' } });
    expect(a).not.toEqual(b);
  });
});
