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
  encodeEncTicketPart, encodeEncKdcRepPart, encodePaEncTsEnc, decodePaEncTsEnc,
} from './codec';
import {
  NO_TICKET_FLAGS, PA_ENC_TIMESTAMP, KrbErrorCode,
  type KdcReq, type KdcRep, type Ticket, type EncTicketPart, type EncKdcRepPart,
} from './types';
import {
  AES256_CTS_HMAC_SHA1_96, stringToKey, encryptWithUsage, decryptWithUsage,
  randomSessionKey, KU_PA_ENC_TIMESTAMP, KU_TICKET, KU_AS_REP_ENC_PART,
} from './crypto';

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
      // TGS-REQ handling arrives in PRD-Windows-Server-Advanced.md §5 P2.
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
}
