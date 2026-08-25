/**
 * KdcSession — server-side endpoint for TCP/88 (RFC 4120 §5.4.1/§7.2.1):
 * decodes each inbound KDC-REQ and drives the AS exchange (§3.1) against a
 * real `DirectoryStore` — genuine ASN.1 KDC-REP/KRB-ERROR replies over the
 * raw `Uint8Array` channel `TcpSocket.send()`/`onData()` expose, one
 * request per `onData()` delivery (same convention as `LdapServerHandler`).
 *
 * PRD-Windows-Server-Advanced.md §5 P1 — AS exchange only (no PA-DATA
 * types beyond PA-ENC-TIMESTAMP, no TGS-REQ yet — that's §5 P2).
 */
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import type { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';
import {
  encodeKdcRep, decodeKdcReq, encodeKrbError, decodeEncryptedData,
  encodeEncTicketPart, decodeEncTicketPart, encodeEncKdcRepPart, encodePaEncTsEnc, decodePaEncTsEnc,
  decodeApReq, decodeAuthenticator,
} from './codec';
import {
  NO_TICKET_FLAGS, PA_ENC_TIMESTAMP, PA_TGS_REQ, KrbErrorCode,
  type KdcReq, type KdcRep, type Ticket, type EncTicketPart, type EncKdcRepPart, type PrincipalName,
} from './types';
import {
  AES256_CTS_HMAC_SHA1_96, stringToKey, encryptWithUsage, decryptWithUsage,
  randomSessionKey, KU_PA_ENC_TIMESTAMP, KU_TICKET, KU_AS_REP_ENC_PART,
  KU_TGS_REQ_AUTHENTICATOR, KU_TGS_REP_ENC_PART,
} from './crypto';
import { deriveInterrealmKey, referralPrincipal } from './crossRealm';
import { type IEventBus } from '@/events/EventBus';
import { BusHolder } from '@/events/BusHolder';

const TICKET_LIFETIME_SECONDS = 10 * 3600; // AD's default domain Kerberos policy: "Maximum lifetime for user ticket" = 10 hours
const RENEWABLE_LIFETIME_SECONDS = 7 * 24 * 3600; // AD's default: "Maximum lifetime for user ticket renewal" = 7 days
const CLOCK_SKEW_SECONDS = 5 * 60; // RFC 4120 §5.2.7.2's usual 5-minute default

export interface KdcContext {
  store: DirectoryStore;
  /** Device id of this KDC — only used for event payloads (PRD-Windows-Server-Advanced.md §5 P12), defaults to the realm name if omitted. */
  deviceId?: string;
  /** Event bus to publish `kerberos.*` events on (§5 P12) — a `KerberosSignalRefreshActor` subscribing elsewhere is what actually feeds a `KerberosSignalStore`; defaults to the process-wide default bus. */
  bus?: IEventBus;
  /** Writes the real Windows Security-log entry (4768/4769/4771/4772) an AS/TGS exchange produces on a real DC — optional so a KDC used purely for the protocol engine (no device-level event log) still works. */
  writeSecurityEvent?: (eventId: number, entryType: 'SuccessAudit' | 'FailureAudit', message: string, data?: Record<string, string>) => void;
}

/** Kerberos error codes as the two-hex-digit Status/SubStatus AD's Security log actually shows (Get-WinEvent's `Status`/`SubStatus` EventData fields), not the bare RFC 4120 error-code integer. */
function kerberosStatusHex(errorCode: number): string {
  return `0x${errorCode.toString(16)}`;
}

export class KdcSessionHandler {
  private readonly fallbackBus = new BusHolder();

  constructor(private readonly ctx: KdcContext) {}

  register(socket: TcpSocket): void {
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      let req: KdcReq;
      try { req = decodeKdcReq(data); } catch { return; }
      if (req.msgType === 'AS-REQ') this.handleAsReq(socket, req);
      else this.handleTgsReq(socket, req);
    });
  }

  private sendError(socket: TcpSocket, req: KdcReq, errorCode: number, eText?: string): void {
    socket.send(encodeKrbError({
      stime: Math.floor(Date.now() / 1000), susec: 0, errorCode,
      realm: this.ctx.store.getRealm(), sname: req.reqBody.sname, eText,
    }));
  }

  private kdcRef(): { deviceId: string; realm: string } {
    const realm = this.ctx.store.getRealm();
    return { deviceId: this.ctx.deviceId ?? realm, realm };
  }

  /** Bus to publish `kerberos.*` events on (§5 P12) — a `KerberosSignalRefreshActor` subscribing elsewhere, not this handler, is what feeds a `KerberosSignalStore`. */
  private bus(): IEventBus {
    return this.ctx.bus ?? this.fallbackBus.get();
  }

  /** Sends the KRB-ERROR and, unless it's the expected first-round PREAUTH_REQUIRED (part of every normal AS exchange, not a real failure), publishes an `as.failed` event (§5 P12) and writes the real Security-log entry (4771 for a bad password, 4772 otherwise). */
  private failAs(socket: TcpSocket, req: KdcReq, cname: string, errorCode: number, eText?: string): void {
    this.sendError(socket, req, errorCode, eText);
    if (errorCode === KrbErrorCode.KDC_ERR_PREAUTH_REQUIRED) return;
    this.bus().publish({ topic: 'kerberos.as.failed', payload: { ...this.kdcRef(), cname, errorCode } });
    const eventId = errorCode === KrbErrorCode.KDC_ERR_PREAUTH_FAILED ? 4771 : 4772;
    this.ctx.writeSecurityEvent?.(eventId, 'FailureAudit',
      `Kerberos pre-authentication failed.\n\nAccount Information:\n\tSecurity ID:\t\t${cname}\n\tAccount Name:\t\t${cname}\n\nStatus:\t\t\t${kerberosStatusHex(errorCode)}`,
      { TargetUserName: cname, Status: kerberosStatusHex(errorCode) });
  }

  /** Publishes a `tgs.failed` event (§5 P12) alongside the KRB-ERROR already sent by `sendError`. */
  private failTgs(socket: TcpSocket, req: KdcReq, cname: string, errorCode: number, eText?: string): void {
    this.sendError(socket, req, errorCode, eText);
    const serviceName = req.reqBody.sname.nameString.join('/');
    this.bus().publish({ topic: 'kerberos.tgs.failed', payload: { ...this.kdcRef(), cname, serviceName, errorCode } });
  }

  private handleAsReq(socket: TcpSocket, req: KdcReq): void {
    const cname = req.reqBody.cname;
    if (!cname || cname.nameString.length === 0) {
      this.failAs(socket, req, '', KrbErrorCode.KDC_ERR_C_PRINCIPAL_UNKNOWN);
      return;
    }
    const cnameStr = cname.nameString.join('/');
    const sam = cname.nameString[0];
    /**
     * A computer account (sam ending in `$`) is as much a Kerberos
     * principal as a user is — a delegating service needs its own TGT
     * for S4U2Proxy (PRD-Windows-Server-Advanced.md §5 P10), obtained
     * exactly the same way a user's is.
     */
    const secret = sam.endsWith('$') ? this.ctx.store.getComputerSecret(sam.slice(0, -1)) : this.ctx.store.getUserSecret(sam);
    if (secret === null) {
      this.failAs(socket, req, cnameStr, KrbErrorCode.KDC_ERR_C_PRINCIPAL_UNKNOWN);
      return;
    }
    const realm = this.ctx.store.getRealm();
    const clientKey = stringToKey(secret, realm);

    const paEncTs = req.padata.find((p) => p.type === PA_ENC_TIMESTAMP);
    if (!paEncTs) {
      this.failAs(socket, req, cnameStr, KrbErrorCode.KDC_ERR_PREAUTH_REQUIRED, 'Additional pre-authentication required');
      return;
    }
    if (!this.verifyPreAuth(paEncTs.value, clientKey)) {
      if (!sam.endsWith('$')) this.ctx.store.recordBadPasswordAttempt(sam);
      this.failAs(socket, req, cnameStr, KrbErrorCode.KDC_ERR_PREAUTH_FAILED, 'Pre-authentication information was invalid');
      return;
    }
    if (!sam.endsWith('$')) this.ctx.store.resetBadPasswordCount(sam);

    const krbtgtSecret = this.ctx.store.getUserSecret('krbtgt');
    if (krbtgtSecret === null) {
      this.failAs(socket, req, cnameStr, KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN);
      return;
    }
    const krbtgtKey = stringToKey(krbtgtSecret, realm);

    const sessionKey = randomSessionKey();
    const sessionKeyValue = new TextEncoder().encode(sessionKey);
    const now = Math.floor(Date.now() / 1000);
    const endtime = Math.min(req.reqBody.till, now + TICKET_LIFETIME_SECONDS);
    const renewTill = now + RENEWABLE_LIFETIME_SECONDS;
    const flags = { ...NO_TICKET_FLAGS, initial: true, preAuthent: true, renewable: true, forwardable: true };

    const encTicketPart: EncTicketPart = {
      flags, key: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: sessionKeyValue },
      crealm: realm, cname, authtime: now, starttime: now, endtime, renewTill,
    };
    const ticket: Ticket = {
      tktVno: 5, realm, sname: req.reqBody.sname,
      encPart: { etype: AES256_CTS_HMAC_SHA1_96, cipher: encryptWithUsage(krbtgtKey, KU_TICKET, encodeEncTicketPart(encTicketPart)) },
    };

    const encKdcRepPart: EncKdcRepPart = {
      key: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: sessionKeyValue },
      nonce: req.reqBody.nonce, flags, authtime: now, starttime: now, endtime, renewTill,
      srealm: realm, sname: req.reqBody.sname,
    };
    const rep: KdcRep = {
      msgType: 'AS-REP', padata: [], crealm: realm, cname, ticket,
      encPart: {
        etype: AES256_CTS_HMAC_SHA1_96,
        cipher: encryptWithUsage(clientKey, KU_AS_REP_ENC_PART, encodeEncKdcRepPart('AS-REP', encKdcRepPart)),
      },
    };
    socket.send(encodeKdcRep(rep));
    this.bus().publish({ topic: 'kerberos.as.succeeded', payload: { ...this.kdcRef(), cname: cnameStr } });
    this.ctx.writeSecurityEvent?.(4768, 'SuccessAudit',
      `A Kerberos authentication ticket (TGT) was requested.\n\nAccount Information:\n\tAccount Name:\t\t${cnameStr}\n\tSupplied Realm Name:\t${realm}\n\nResult Code:\t\t0x0`,
      { TargetUserName: cnameStr, Status: '0x0' });
  }

  /** RFC 4120 §5.2.7.2: decrypt PA-ENC-TIMESTAMP with the client's key and check it's within the allowed clock skew. */
  private verifyPreAuth(paValue: Uint8Array, clientKey: string): boolean {
    try {
      const encData = decodeEncryptedData(parseTLV(paValue, 0));
      const plaintext = decryptWithUsage(clientKey, KU_PA_ENC_TIMESTAMP, encData.cipher);
      const ts = decodePaEncTsEnc(plaintext);
      return Math.abs(Math.floor(Date.now() / 1000) - ts) <= CLOCK_SKEW_SECONDS;
    } catch {
      return false;
    }
  }

  /**
   * RFC 4120 §3.3/§5.4/§5.5.1 — the TGS exchange: the client presents its
   * TGT plus a fresh Authenticator (PA-TGS-REQ) instead of a long-term
   * secret, and receives a new service ticket for `req.reqBody.sname`.
   * Service tickets are issued for a computer principal (its account
   * secret is the service key) — this simulator has no separate SPN/
   * service-account registry yet, so `sname`'s bare name must match an
   * existing computer account (the common real-world case for HOST/CIFS-
   * style SPNs, which map to the machine account itself).
   */
  private handleTgsReq(socket: TcpSocket, req: KdcReq): void {
    const paTgsReq = req.padata.find((p) => p.type === PA_TGS_REQ);
    if (!paTgsReq) {
      this.failTgs(socket, req, '', KrbErrorCode.KDC_ERR_PREAUTH_REQUIRED, 'A TGT and Authenticator are required');
      return;
    }

    const realm = this.ctx.store.getRealm();

    let apReq: ReturnType<typeof decodeApReq>;
    try {
      apReq = decodeApReq(paTgsReq.value);
    } catch {
      this.failTgs(socket, req, '', KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED, 'Decryption failed');
      return;
    }

    /**
     * RFC 4120 §3.3.3 — a ticket whose own `realm` differs from ours is an
     * inter-realm TGT presented back to us by a client that got it from
     * `presentedRealm`'s KDC as a referral; it's encrypted under the
     * shared interrealm key (PRD §5 P9), not our krbtgt secret.
     */
    const presentedRealm = apReq.ticket.realm;
    const isInboundReferral = presentedRealm.toUpperCase() !== realm.toUpperCase();
    let ticketDecryptKey: string;
    if (isInboundReferral) {
      const trust = this.ctx.store.getTrust(presentedRealm);
      if (!trust || (trust.direction !== 'Inbound' && trust.direction !== 'Bidirectional')) {
        this.failTgs(socket, req, '', KrbErrorCode.KDC_ERR_POLICY, 'No trust path from the presenting realm');
        return;
      }
      ticketDecryptKey = deriveInterrealmKey(trust.interrealmKey, presentedRealm, realm);
    } else {
      const krbtgtSecret = this.ctx.store.getUserSecret('krbtgt');
      if (krbtgtSecret === null) {
        this.failTgs(socket, req, '', KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN);
        return;
      }
      ticketDecryptKey = stringToKey(krbtgtSecret, realm);
    }

    let ticketPart: EncTicketPart;
    try {
      ticketPart = decodeEncTicketPart(decryptWithUsage(ticketDecryptKey, KU_TICKET, apReq.ticket.encPart.cipher));
    } catch {
      this.failTgs(socket, req, '', KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED, 'Decryption failed');
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (ticketPart.endtime < now) {
      this.failTgs(socket, req, ticketPart.cname.nameString.join('/'), KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED);
      return;
    }

    const ticketSessionKey = new TextDecoder().decode(ticketPart.key.keyValue);
    try {
      const authenticator = decodeAuthenticator(decryptWithUsage(ticketSessionKey, KU_TGS_REQ_AUTHENTICATOR, apReq.authenticator.cipher));
      const validCname = authenticator.cname.nameString.join('/') === ticketPart.cname.nameString.join('/');
      const validSkew = Math.abs(now - authenticator.ctime) <= CLOCK_SKEW_SECONDS;
      if (!validCname || !validSkew) throw new Error('authenticator mismatch');
    } catch {
      this.failTgs(socket, req, ticketPart.cname.nameString.join('/'), KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED, 'Authenticator verification failed');
      return;
    }

    /**
     * MS-SFU S4U2Proxy (PRD-Windows-Server-Advanced.md §5 P10): the
     * already-verified ticket above is the *delegating service's own TGT*
     * (its cname is that service's computer account), and
     * `additionalTickets[0]` is the "evidence ticket" — the service
     * ticket a user presented to that service, proving they're already
     * authenticated. Decrypting it with the delegating service's own key
     * (the same key it would use to accept an ordinary AP-REQ) recovers
     * the user's real identity; `msDS-AllowedToDelegateTo` then gates
     * whether that service may obtain a ticket to `req.reqBody.sname` on
     * the user's behalf.
     */
    if (req.reqBody.additionalTickets && req.reqBody.additionalTickets.length > 0) {
      this.handleS4U2Proxy(socket, req, realm, ticketPart);
      return;
    }

    const sessionKey = randomSessionKey();
    const sessionKeyValue = new TextEncoder().encode(sessionKey);
    const endtime = Math.min(req.reqBody.till, ticketPart.endtime);
    const flags = { ...NO_TICKET_FLAGS, renewable: ticketPart.flags.renewable };

    /**
     * RFC 4120 §3.3.3 — the client wants a ticket for a realm other than
     * ours: if a trust allows it, issue an inter-realm referral TGT
     * (`krbtgt/<targetRealm>`, encrypted under the shared interrealm key)
     * instead of resolving `sname` against our own computer accounts.
     */
    const targetRealm = req.reqBody.realm;
    const isOutboundReferral = targetRealm.toUpperCase() !== realm.toUpperCase();
    let sname: PrincipalName;
    let serviceKey: string;
    const cnameStr = ticketPart.cname.nameString.join('/');
    if (isOutboundReferral) {
      const trust = this.ctx.store.getTrust(targetRealm);
      if (!trust || (trust.direction !== 'Outbound' && trust.direction !== 'Bidirectional')) {
        this.failTgs(socket, req, cnameStr, KrbErrorCode.KDC_ERR_POLICY, 'No trust path to the target realm');
        return;
      }
      sname = referralPrincipal(targetRealm);
      serviceKey = deriveInterrealmKey(trust.interrealmKey, realm, targetRealm);
    } else {
      const serviceName = req.reqBody.sname.nameString[0];
      const serviceSecret = serviceName === 'krbtgt' ? this.ctx.store.getUserSecret('krbtgt') : this.ctx.store.getComputerSecret(serviceName);
      if (serviceSecret === null) {
        this.failTgs(socket, req, cnameStr, KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN);
        return;
      }
      sname = req.reqBody.sname;
      serviceKey = stringToKey(serviceSecret, realm);
    }

    const encTicketPart: EncTicketPart = {
      flags, key: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: sessionKeyValue },
      crealm: ticketPart.crealm, cname: ticketPart.cname, authtime: ticketPart.authtime, starttime: now, endtime,
    };
    const ticket: Ticket = {
      tktVno: 5, realm, sname,
      encPart: { etype: AES256_CTS_HMAC_SHA1_96, cipher: encryptWithUsage(serviceKey, KU_TICKET, encodeEncTicketPart(encTicketPart)) },
    };

    const encKdcRepPart: EncKdcRepPart = {
      key: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: sessionKeyValue },
      nonce: req.reqBody.nonce, flags, authtime: ticketPart.authtime, starttime: now, endtime,
      srealm: realm, sname,
    };
    const rep: KdcRep = {
      msgType: 'TGS-REP', padata: [], crealm: ticketPart.crealm, cname: ticketPart.cname, ticket,
      encPart: {
        etype: AES256_CTS_HMAC_SHA1_96,
        cipher: encryptWithUsage(ticketSessionKey, KU_TGS_REP_ENC_PART, encodeEncKdcRepPart('TGS-REP', encKdcRepPart)),
      },
    };
    socket.send(encodeKdcRep(rep));
    const snameStr = sname.nameString.join('/');
    this.bus().publish({
      topic: 'kerberos.tgs.succeeded',
      payload: { ...this.kdcRef(), cname: cnameStr, serviceName: snameStr, referral: isOutboundReferral },
    });
    // 4769 "A Kerberos service ticket was requested" — TargetDomainName is
    // the trusted domain's real NetBIOS name for a cross-realm referral
    // (discovered over LDAP at New-ADTrust time, §1.3 grounding; falls
    // back to the DNS realm, never fabricated, if that discovery never
    // happened), or this DC's own domain for an ordinary same-realm ticket.
    const targetDomainName = isOutboundReferral
      ? (this.ctx.store.getTrust(targetRealm)?.remoteNetbiosName ?? targetRealm.toUpperCase())
      : this.ctx.store.netbiosName;
    this.ctx.writeSecurityEvent?.(4769, 'SuccessAudit',
      `A Kerberos service ticket was requested.\n\nAccount Information:\n\tAccount Name:\t\t${cnameStr}\n\nService Information:\n\tService Name:\t\t${snameStr}\n\nNetwork Information:\n\tTarget Domain Name:\t${targetDomainName}`,
      { TargetUserName: cnameStr, TargetDomainName: targetDomainName, ServiceName: snameStr, Status: '0x0' });
  }

  /**
   * MS-SFU S4U2Proxy (PRD-Windows-Server-Advanced.md §5 P10): `ticketPart`
   * is the delegating service's own already-verified TGT contents (its
   * `cname` is that service's computer account); `req.reqBody.
   * additionalTickets[0]` is the evidence ticket. On success, the issued
   * ticket's `cname`/`crealm` are the *user's* (from the evidence ticket),
   * not the delegating service's — exactly as if the user had asked
   * directly.
   */
  private handleS4U2Proxy(socket: TcpSocket, req: KdcReq, realm: string, ticketPart: EncTicketPart): void {
    const delegatingService = ticketPart.cname.nameString[0].replace(/\$$/, '');
    const delegatingSecret = this.ctx.store.getComputerSecret(delegatingService);
    if (delegatingSecret === null) {
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_C_PRINCIPAL_UNKNOWN);
      return;
    }
    const delegatingKey = stringToKey(delegatingSecret, realm);

    const evidenceTicket = req.reqBody.additionalTickets![0];
    let evidencePart: EncTicketPart;
    try {
      evidencePart = decodeEncTicketPart(decryptWithUsage(delegatingKey, KU_TICKET, evidenceTicket.encPart.cipher));
    } catch {
      this.sendError(socket, req, KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED, 'Evidence ticket decryption failed');
      return;
    }

    const targetServiceName = req.reqBody.sname.nameString[0];
    if (!this.ctx.store.isDelegationAllowedFrom(delegatingService, targetServiceName)) {
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_BADOPTION, 'Delegation to this service is not permitted');
      this.bus().publish({
        topic: 'kerberos.delegation.denied', payload: { ...this.kdcRef(), delegatingService, targetService: targetServiceName },
      });
      return;
    }
    const targetSecret = this.ctx.store.getComputerSecret(targetServiceName);
    if (targetSecret === null) {
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN);
      return;
    }
    const targetKey = stringToKey(targetSecret, realm);

    const now = Math.floor(Date.now() / 1000);
    const sessionKey = randomSessionKey();
    const sessionKeyValue = new TextEncoder().encode(sessionKey);
    const endtime = Math.min(req.reqBody.till, evidencePart.endtime);
    const flags = { ...NO_TICKET_FLAGS, forwarded: true };

    const encTicketPart: EncTicketPart = {
      flags, key: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: sessionKeyValue },
      crealm: evidencePart.crealm, cname: evidencePart.cname, authtime: evidencePart.authtime, starttime: now, endtime,
    };
    const ticket: Ticket = {
      tktVno: 5, realm, sname: req.reqBody.sname,
      encPart: { etype: AES256_CTS_HMAC_SHA1_96, cipher: encryptWithUsage(targetKey, KU_TICKET, encodeEncTicketPart(encTicketPart)) },
    };

    const delegatingTicketSessionKey = new TextDecoder().decode(ticketPart.key.keyValue);
    const encKdcRepPart: EncKdcRepPart = {
      key: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: sessionKeyValue },
      nonce: req.reqBody.nonce, flags, authtime: evidencePart.authtime, starttime: now, endtime,
      srealm: realm, sname: req.reqBody.sname,
    };
    const rep: KdcRep = {
      msgType: 'TGS-REP', padata: [], crealm: evidencePart.crealm, cname: evidencePart.cname, ticket,
      encPart: {
        etype: AES256_CTS_HMAC_SHA1_96,
        cipher: encryptWithUsage(delegatingTicketSessionKey, KU_TGS_REP_ENC_PART, encodeEncKdcRepPart('TGS-REP', encKdcRepPart)),
      },
    };
    socket.send(encodeKdcRep(rep));
    const onBehalfOf = evidencePart.cname.nameString.join('/');
    this.bus().publish({
      topic: 'kerberos.delegation.granted',
      payload: { ...this.kdcRef(), delegatingService, onBehalfOf, targetService: targetServiceName },
    });
  }
}
