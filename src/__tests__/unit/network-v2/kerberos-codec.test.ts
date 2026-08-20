/**
 * PRD-Windows-Server-Advanced.md §2.1.1/§2.1.2 — Kerberos V5 (RFC 4120)
 * ASN.1 DER codec, tested standalone (pure encode/decode, no network),
 * mirroring how `quic-frames.test.ts`/`ldap` message tests validate their
 * own wire codecs before any session-level test exists.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeKdcReq, decodeKdcReq, encodeKdcRep, decodeKdcRep,
  encodeEncTicketPart, decodeEncTicketPart, encodeEncKdcRepPart, decodeEncKdcRepPart,
  encodeKrbError, decodeKrbError, encodeEncryptedData, decodeEncryptedData,
  encodePaEncTsEnc, decodePaEncTsEnc, isKrbError,
  encodeAuthenticator, decodeAuthenticator, encodeApReq, decodeApReq, ticketFlagsToHex,
} from '@/network/kerberos/codec';
import { principalName, PrincipalNameType, NO_TICKET_FLAGS, PA_ENC_TIMESTAMP, type KdcReq, type KdcRep, type Ticket } from '@/network/kerberos/types';
import { parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';

const NOW = Math.floor(Date.now() / 1000);

describe('Kerberos codec — KDC-REQ / AS-REQ / TGS-REQ (RFC 4120 §5.4.1)', () => {
  it('round-trips an AS-REQ with PA-ENC-TIMESTAMP pre-authentication', () => {
    const req: KdcReq = {
      msgType: 'AS-REQ',
      padata: [{ type: PA_ENC_TIMESTAMP, value: new Uint8Array([1, 2, 3, 4]) }],
      reqBody: {
        kdcOptions: 0,
        cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'),
        realm: 'LAB.LOCAL',
        sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'),
        till: NOW + 3600,
        nonce: 123456,
        etype: [18],
      },
    };
    const decoded = decodeKdcReq(encodeKdcReq(req));
    expect(decoded.msgType).toBe('AS-REQ');
    expect(decoded.padata).toHaveLength(1);
    expect(decoded.padata[0].type).toBe(PA_ENC_TIMESTAMP);
    expect(decoded.padata[0].value).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decoded.reqBody.cname?.nameString).toEqual(['alice']);
    expect(decoded.reqBody.realm).toBe('LAB.LOCAL');
    expect(decoded.reqBody.sname.nameString).toEqual(['krbtgt', 'LAB.LOCAL']);
    expect(decoded.reqBody.till).toBe(req.reqBody.till);
    expect(decoded.reqBody.nonce).toBe(123456);
    expect(decoded.reqBody.etype).toEqual([18]);
  });

  it('round-trips an AS-REQ with no padata at all', () => {
    const req: KdcReq = {
      msgType: 'AS-REQ',
      padata: [],
      reqBody: { kdcOptions: 0, realm: 'LAB.LOCAL', sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'), till: NOW + 3600, nonce: 1, etype: [18] },
    };
    const decoded = decodeKdcReq(encodeKdcReq(req));
    expect(decoded.padata).toEqual([]);
    expect(decoded.reqBody.cname).toBeUndefined();
  });

  it('round-trips PA-ENC-TS-ENC (the plaintext timestamp before encryption)', () => {
    const decoded = decodePaEncTsEnc(encodePaEncTsEnc(NOW));
    expect(decoded).toBe(NOW);
  });
});

describe('Kerberos codec — Ticket / EncTicketPart (RFC 4120 §5.3)', () => {
  it('round-trips an EncTicketPart with all optional fields present', () => {
    const decoded = decodeEncTicketPart(encodeEncTicketPart({
      flags: { ...NO_TICKET_FLAGS, initial: true, preAuthent: true, renewable: true },
      key: { keyType: 18, keyValue: new Uint8Array([9, 9, 9]) },
      crealm: 'LAB.LOCAL',
      cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'),
      authtime: NOW,
      starttime: NOW,
      endtime: NOW + 3600,
      renewTill: NOW + 7200,
    }));
    expect(decoded.flags.initial).toBe(true);
    expect(decoded.flags.preAuthent).toBe(true);
    expect(decoded.flags.renewable).toBe(true);
    expect(decoded.flags.forwardable).toBe(false);
    expect(decoded.key.keyType).toBe(18);
    expect(decoded.key.keyValue).toEqual(new Uint8Array([9, 9, 9]));
    expect(decoded.crealm).toBe('LAB.LOCAL');
    expect(decoded.cname.nameString).toEqual(['alice']);
    expect(decoded.authtime).toBe(NOW);
    expect(decoded.starttime).toBe(NOW);
    expect(decoded.endtime).toBe(NOW + 3600);
    expect(decoded.renewTill).toBe(NOW + 7200);
  });

  it('round-trips an EncTicketPart with optional starttime/renewTill absent', () => {
    const decoded = decodeEncTicketPart(encodeEncTicketPart({
      flags: NO_TICKET_FLAGS,
      key: { keyType: 18, keyValue: new Uint8Array([1]) },
      crealm: 'LAB.LOCAL',
      cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'bob'),
      authtime: NOW,
      endtime: NOW + 3600,
    }));
    expect(decoded.starttime).toBeUndefined();
    expect(decoded.renewTill).toBeUndefined();
  });
});

describe('Kerberos codec — KDC-REP / AS-REP / TGS-REP (RFC 4120 §5.4.2)', () => {
  function sampleTicket(): Ticket {
    return {
      tktVno: 5,
      realm: 'LAB.LOCAL',
      sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'),
      encPart: { etype: 18, cipher: new Uint8Array([1, 2, 3, 255, 0, 128]) },
    };
  }

  it('round-trips an AS-REP carrying a Ticket with arbitrary binary cipher bytes', () => {
    const rep: KdcRep = {
      msgType: 'AS-REP',
      padata: [],
      crealm: 'LAB.LOCAL',
      cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'),
      ticket: sampleTicket(),
      encPart: { etype: 18, cipher: new Uint8Array([255, 0, 128, 64, 32, 16, 8]) },
    };
    const decoded = decodeKdcRep(encodeKdcRep(rep));
    expect(decoded.msgType).toBe('AS-REP');
    expect(decoded.crealm).toBe('LAB.LOCAL');
    expect(decoded.cname.nameString).toEqual(['alice']);
    expect(decoded.ticket.realm).toBe('LAB.LOCAL');
    expect(decoded.ticket.sname.nameString).toEqual(['krbtgt', 'LAB.LOCAL']);
    expect(decoded.ticket.encPart.cipher).toEqual(new Uint8Array([1, 2, 3, 255, 0, 128]));
    expect(decoded.encPart.cipher).toEqual(new Uint8Array([255, 0, 128, 64, 32, 16, 8]));
  });

  it('round-trips EncASRepPart (the client-key-encrypted plaintext)', () => {
    const decoded = decodeEncKdcRepPart(encodeEncKdcRepPart('AS-REP', {
      key: { keyType: 18, keyValue: new Uint8Array([7, 7]) },
      nonce: 42,
      flags: { ...NO_TICKET_FLAGS, initial: true },
      authtime: NOW,
      endtime: NOW + 3600,
      srealm: 'LAB.LOCAL',
      sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'),
    }));
    expect(decoded.nonce).toBe(42);
    expect(decoded.flags.initial).toBe(true);
    expect(decoded.srealm).toBe('LAB.LOCAL');
    expect(decoded.sname.nameString).toEqual(['krbtgt', 'LAB.LOCAL']);
  });
});

describe('Kerberos codec — KRB-ERROR (RFC 4120 §5.9.1)', () => {
  it('round-trips a KDC_ERR_PREAUTH_REQUIRED error with explanatory text', () => {
    const decoded = decodeKrbError(encodeKrbError({
      stime: NOW, susec: 0, errorCode: 25, realm: 'LAB.LOCAL',
      sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'),
      eText: 'Additional pre-authentication required',
    }));
    expect(decoded.errorCode).toBe(25);
    expect(decoded.realm).toBe('LAB.LOCAL');
    expect(decoded.eText).toBe('Additional pre-authentication required');
  });

  it('isKrbError distinguishes a KRB-ERROR from a KDC-REP on the wire', () => {
    const errorBytes = encodeKrbError({
      stime: NOW, susec: 0, errorCode: 25, realm: 'LAB.LOCAL',
      sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'),
    });
    const repBytes = encodeKdcRep({
      msgType: 'AS-REP', padata: [], crealm: 'LAB.LOCAL',
      cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'),
      ticket: { tktVno: 5, realm: 'LAB.LOCAL', sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'), encPart: { etype: 18, cipher: new Uint8Array([1]) } },
      encPart: { etype: 18, cipher: new Uint8Array([1]) },
    });
    expect(isKrbError(errorBytes)).toBe(true);
    expect(isKrbError(repBytes)).toBe(false);
  });
});

describe('Kerberos codec — EncryptedData (RFC 4120 §5.2.9)', () => {
  it('round-trips with an explicit kvno', () => {
    const bytes = encodeEncryptedData({ etype: 18, kvno: 3, cipher: new Uint8Array([1, 2, 3]) });
    const decoded = decodeEncryptedData(parseTLV(bytes, 0));
    expect(decoded.etype).toBe(18);
    expect(decoded.kvno).toBe(3);
    expect(decoded.cipher).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('Kerberos codec — Authenticator / AP-REQ (RFC 4120 §5.5.1)', () => {
  it('round-trips an Authenticator', () => {
    const decoded = decodeAuthenticator(encodeAuthenticator({
      crealm: 'LAB.LOCAL', cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'), ctime: NOW, cusec: 12345,
    }));
    expect(decoded.crealm).toBe('LAB.LOCAL');
    expect(decoded.cname.nameString).toEqual(['alice']);
    expect(decoded.ctime).toBe(NOW);
    expect(decoded.cusec).toBe(12345);
  });

  it('round-trips an AP-REQ carrying a Ticket with arbitrary binary cipher bytes', () => {
    const ticket: Ticket = {
      tktVno: 5, realm: 'LAB.LOCAL',
      sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'),
      encPart: { etype: 18, cipher: new Uint8Array([9, 8, 7, 255, 0]) },
    };
    const decoded = decodeApReq(encodeApReq({
      apOptions: 0, ticket,
      authenticator: { etype: 18, cipher: new Uint8Array([1, 2, 3]) },
    }));
    expect(decoded.apOptions).toBe(0);
    expect(decoded.ticket.realm).toBe('LAB.LOCAL');
    expect(decoded.ticket.encPart.cipher).toEqual(new Uint8Array([9, 8, 7, 255, 0]));
    expect(decoded.authenticator.cipher).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('Kerberos codec — ticketFlagsToHex (klist rendering helper)', () => {
  it('renders no flags as 0x00000000', () => {
    expect(ticketFlagsToHex(NO_TICKET_FLAGS)).toBe('0x00000000');
  });

  it('renders forwardable+renewable+initial+preAuthent as the matching bit pattern', () => {
    const flags = { ...NO_TICKET_FLAGS, forwardable: true, renewable: true, initial: true, preAuthent: true };
    expect(ticketFlagsToHex(flags)).toBe('0x40e00000');
  });
});
