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

const TICKET_LIFETIME_SECONDS = 8 * 3600; // real Kerberos policy default-ish (10h in AD; kept simple here)
const CLOCK_SKEW_SECONDS = 5 * 60; // RFC 4120 §5.2.7.2's usual 5-minute default

export interface KdcContext {
  store: DirectoryStore;
}

export class KdcSessionHandler {
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

  private handleAsReq(socket: TcpSocket, req: KdcReq): void {
    const cname = req.reqBody.cname;
    if (!cname || cname.nameString.length === 0) {
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_C_PRINCIPAL_UNKNOWN);
      return;
    }
    const sam = cname.nameString[0];
    const secret = this.ctx.store.getUserSecret(sam);
    if (secret === null) {
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_C_PRINCIPAL_UNKNOWN);
      return;
    }
    const realm = this.ctx.store.getRealm();
    const clientKey = stringToKey(secret, realm);

    const paEncTs = req.padata.find((p) => p.type === PA_ENC_TIMESTAMP);
    if (!paEncTs) {
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_PREAUTH_REQUIRED, 'Additional pre-authentication required');
      return;
    }
    if (!this.verifyPreAuth(paEncTs.value, clientKey)) {
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_PREAUTH_FAILED, 'Pre-authentication information was invalid');
      return;
    }

    const krbtgtSecret = this.ctx.store.getUserSecret('krbtgt');
    if (krbtgtSecret === null) {
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN);
      return;
    }
    const krbtgtKey = stringToKey(krbtgtSecret, realm);

    const sessionKey = randomSessionKey();
    const sessionKeyValue = new TextEncoder().encode(sessionKey);
    const now = Math.floor(Date.now() / 1000);
    const endtime = Math.min(req.reqBody.till, now + TICKET_LIFETIME_SECONDS);
    const flags = { ...NO_TICKET_FLAGS, initial: true, preAuthent: true };

    const encTicketPart: EncTicketPart = {
      flags, key: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: sessionKeyValue },
      crealm: realm, cname, authtime: now, starttime: now, endtime,
    };
    const ticket: Ticket = {
      tktVno: 5, realm, sname: req.reqBody.sname,
      encPart: { etype: AES256_CTS_HMAC_SHA1_96, cipher: encryptWithUsage(krbtgtKey, KU_TICKET, encodeEncTicketPart(encTicketPart)) },
    };

    const encKdcRepPart: EncKdcRepPart = {
      key: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: sessionKeyValue },
      nonce: req.reqBody.nonce, flags, authtime: now, starttime: now, endtime,
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
      this.sendError(socket, req, KrbErrorCode.KDC_ERR_PREAUTH_REQUIRED, 'A TGT and Authenticator are required');
      return;
    }

    const realm = this.ctx.store.getRealm();

    let apReq: ReturnType<typeof decodeApReq>;
    try {
      apReq = decodeApReq(paTgsReq.value);
    } catch {
      this.sendError(socket, req, KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED, 'Decryption failed');
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
        this.sendError(socket, req, KrbErrorCode.KDC_ERR_POLICY, 'No trust path from the presenting realm');
        return;
      }
      ticketDecryptKey = deriveInterrealmKey(trust.interrealmKey, presentedRealm, realm);
    } else {
      const krbtgtSecret = this.ctx.store.getUserSecret('krbtgt');
      if (krbtgtSecret === null) {
        this.sendError(socket, req, KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN);
        return;
      }
      ticketDecryptKey = stringToKey(krbtgtSecret, realm);
    }

    let ticketPart: EncTicketPart;
    try {
      ticketPart = decodeEncTicketPart(decryptWithUsage(ticketDecryptKey, KU_TICKET, apReq.ticket.encPart.cipher));
    } catch {
      this.sendError(socket, req, KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED, 'Decryption failed');
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (ticketPart.endtime < now) {
      this.sendError(socket, req, KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED);
      return;
    }

    const ticketSessionKey = new TextDecoder().decode(ticketPart.key.keyValue);
    try {
      const authenticator = decodeAuthenticator(decryptWithUsage(ticketSessionKey, KU_TGS_REQ_AUTHENTICATOR, apReq.authenticator.cipher));
      const validCname = authenticator.cname.nameString.join('/') === ticketPart.cname.nameString.join('/');
      const validSkew = Math.abs(now - authenticator.ctime) <= CLOCK_SKEW_SECONDS;
      if (!validCname || !validSkew) throw new Error('authenticator mismatch');
    } catch {
      this.sendError(socket, req, KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED, 'Authenticator verification failed');
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
    if (isOutboundReferral) {
      const trust = this.ctx.store.getTrust(targetRealm);
      if (!trust || (trust.direction !== 'Outbound' && trust.direction !== 'Bidirectional')) {
        this.sendError(socket, req, KrbErrorCode.KDC_ERR_POLICY, 'No trust path to the target realm');
        return;
      }
      sname = referralPrincipal(targetRealm);
      serviceKey = deriveInterrealmKey(trust.interrealmKey, realm, targetRealm);
    } else {
      const serviceName = req.reqBody.sname.nameString[0];
      const serviceSecret = serviceName === 'krbtgt' ? this.ctx.store.getUserSecret('krbtgt') : this.ctx.store.getComputerSecret(serviceName);
      if (serviceSecret === null) {
        this.sendError(socket, req, KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN);
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
  }
}
