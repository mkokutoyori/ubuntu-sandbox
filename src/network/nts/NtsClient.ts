import {
  EF, NTP_HEADER_LENGTH, NTP_MAX_V4_MAC_LENGTH, NTS_MAX_COOKIES, NTS_MAX_TOTAL_COOKIE_LENGTH, NTS_MIN_UNIQ_ID_LENGTH,
  NTS_MIN_UNPADDED_NONCE_LENGTH, NTS_KOD_NAK, concat, decryptAuthField, encodeField, generateAuthField, parseFields,
} from './NtsNtp';

export interface NtsContext {
  readonly aead: number;
  readonly c2s: Uint8Array;
  readonly s2c: Uint8Array;
}

export interface NtsAuthReport {
  readonly keyId: number;
  readonly keyType: number;
  readonly keyLength: number;
  readonly keAttempts: number;
  readonly lastKeAgo: number;
  readonly cookies: number;
  readonly cookieLength: number;
  readonly nak: boolean;
}

export const KE_RETRY_FACTOR_CONNECT = 4;
export const KE_RETRY_FACTOR_TLS = 10;
export const KE_MAX_RETRY_EXPONENT = 19;

export type RandomBytes = (length: number) => Uint8Array;

export class NtsClient {
  private context: NtsContext | null = null;
  private contextId = 0;
  private cookies: Uint8Array[] = [];
  private authReady = false;
  private nakResponse = false;
  private okResponse = true;
  private nonce = new Uint8Array(NTS_MIN_UNPADDED_NONCE_LENGTH);
  private uniqueIdentifier = new Uint8Array(NTS_MIN_UNIQ_ID_LENGTH);
  keAttempts = 0;
  nextKeAttemptMs = 0;
  lastKeSuccessMs = 0;

  constructor(private readonly random: RandomBytes, public refreshMs: number) {}

  reset(): void {
    this.context = null;
    this.contextId = 0;
    this.cookies = [];
    this.authReady = false;
    this.nakResponse = false;
    this.okResponse = true;
    this.keAttempts = 0;
    this.nextKeAttemptMs = 0;
    this.lastKeSuccessMs = 0;
  }

  beginKeyExchange(nowMs: number): boolean {
    if (nowMs < this.nextKeAttemptMs) return false;
    this.keAttempts++;
    return true;
  }

  failKeyExchange(retryFactor: number, nowMs: number): void {
    const exponent = Math.min(retryFactor + this.keAttempts - 1, KE_MAX_RETRY_EXPONENT);
    this.nextKeAttemptMs = nowMs + 2 ** exponent * 1000;
  }

  snapshot(): { context: NtsContext; contextId: number; cookies: readonly Uint8Array[]; lastKeSuccessMs: number } | null {
    return this.context === null || this.cookies.length === 0 ? null
      : { context: this.context, contextId: this.contextId, cookies: this.cookies, lastKeSuccessMs: this.lastKeSuccessMs };
  }

  restore(context: NtsContext, contextId: number, cookies: readonly Uint8Array[], lastKeSuccessMs: number): void {
    this.context = context;
    this.contextId = contextId;
    this.cookies = cookies.slice(0, NTS_MAX_COOKIES);
    this.lastKeSuccessMs = lastKeSuccessMs;
  }

  hasCookies(): boolean { return this.cookies.length > 0; }

  install(context: NtsContext, cookies: readonly Uint8Array[], nowMs: number): void {
    this.context = context;
    this.contextId++;
    this.cookies = cookies.slice(0, NTS_MAX_COOKIES);
    this.lastKeSuccessMs = nowMs;
  }

  needsKeyExchange(nowMs: number): boolean {
    if (this.cookies.length > 0
      && ((this.nakResponse && !this.okResponse) || nowMs - this.lastKeSuccessMs > this.refreshMs)) {
      this.cookies = [];
    }
    return this.cookies.length === 0;
  }

  prepareForAuth(): void {
    this.authReady = false;
    this.uniqueIdentifier = this.random(NTS_MIN_UNIQ_ID_LENGTH);
    this.nonce = this.random(NTS_MIN_UNPADDED_NONCE_LENGTH);
  }

  markReady(): void {
    this.nakResponse = false;
    this.authReady = true;
  }

  appendRequestFields(header: Uint8Array): Uint8Array | null {
    if (!this.authReady || this.context === null || this.cookies.length === 0) return null;
    this.authReady = false;
    const cookie = this.cookies.shift()!;
    const requested = Math.min(NTS_MAX_COOKIES - this.cookies.length, Math.floor(NTS_MAX_TOTAL_COOKIE_LENGTH / (cookie.length + 4)));
    const parts: Uint8Array[] = [header, encodeField(EF.UNIQUE_IDENTIFIER, this.uniqueIdentifier), encodeField(EF.COOKIE, cookie)];
    for (let i = 0; i < requested - 1; i++) parts.push(encodeField(EF.COOKIE_PLACEHOLDER, new Uint8Array(cookie.length)));
    const associated = concat(parts);
    const auth = generateAuthField(associated, this.context.c2s, this.nonce, new Uint8Array(0), NTP_MAX_V4_MAC_LENGTH + 4);
    this.okResponse = false;
    return concat([associated, auth]);
  }

  checkResponse(packet: Uint8Array): boolean {
    if (packet.length <= NTP_HEADER_LENGTH || this.okResponse || this.authReady || this.context === null) return false;
    const fields = parseFields(packet, NTP_HEADER_LENGTH);
    if (fields === null) return false;
    let validUid = false;
    let plaintext: Uint8Array | null = null;
    for (const field of fields) {
      if (field.type === EF.UNIQUE_IDENTIFIER) {
        if (field.body.length !== this.uniqueIdentifier.length || field.body.some((b, i) => b !== this.uniqueIdentifier[i])) return false;
        validUid = true;
      } else if (field.type === EF.AUTH_AND_EEF) {
        if (field.start + field.length !== packet.length) return false;
        plaintext = decryptAuthField(packet, field, this.context.s2c);
        if (plaintext === null || parseFields(plaintext, 0) === null) return false;
      }
    }
    if (!validUid || plaintext === null) {
      const refId = String.fromCharCode(...packet.subarray(12, 16));
      if (validUid && packet[1] === 0 && refId === NTS_KOD_NAK) this.nakResponse = true;
      return false;
    }
    const received = parseFields(plaintext, 0)!.filter((f) => f.type === EF.COOKIE && f.length >= 16 && f.body.length <= 256);
    if (received.length === 0) return false;
    for (const field of received) {
      if (this.cookies.length >= NTS_MAX_COOKIES) break;
      this.cookies.push(field.body.slice());
    }
    this.okResponse = true;
    this.keAttempts = 0;
    this.nextKeAttemptMs = 0;
    return true;
  }

  report(nowMs: number): NtsAuthReport {
    const keyLength = this.context === null ? 0 : 8 * this.context.s2c.length;
    return {
      keyId: this.contextId,
      keyType: this.context?.aead ?? 0,
      keyLength,
      keAttempts: this.keAttempts,
      lastKeAgo: keyLength > 0 ? Math.floor((nowMs - this.lastKeSuccessMs) / 1000) : -1,
      cookies: this.cookies.length,
      cookieLength: this.cookies.length > 0 ? this.cookies[0].length : 0,
      nak: this.nakResponse,
    };
  }
}
