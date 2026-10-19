import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { certToPem, crlToPem, csrToPem, pemToCsr, type CertificateRequest } from '@/network/pki/pem';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';
import { bytesToBinaryString, binaryStringToBytes } from '@/crypto/encoding';

export const ENROLLMENT_PATH = '/cgi-bin/pkiclient.exe';

export type RequestState = 'pending' | 'granted' | 'rejected';

export interface EnrollmentRecord {
  readonly id: number;
  readonly subject: string;
  readonly request: CertificateRequest;
  readonly receivedMs: number;
  state: RequestState;
  certificate?: X509Certificate;
}

export interface CertificateServerLifetimes {
  certificateDays: number;
  caCertificateDays: number;
  crlHours: number;
}

export interface CertificateServerDeps {
  now(): number;
}

const DAY_MS = 24 * 3600 * 1000;

export class IosCertificateServer {
  issuerName: string | null = null;
  grantAuto = false;
  readonly lifetimes: CertificateServerLifetimes = { certificateDays: 365, caCertificateDays: 1825, crlHours: 168 };
  cdpUrl: string | null = null;
  private authority: CertificateAuthority | null = null;
  private running = false;
  private nextId = 1;
  private readonly records = new Map<number, EnrollmentRecord>();

  constructor(readonly name: string, private readonly deps: CertificateServerDeps) {}

  get isRunning(): boolean { return this.running; }
  get caCertificate(): X509Certificate | null { return this.authority?.rootCertificate ?? null; }
  get enrollments(): readonly EnrollmentRecord[] { return [...this.records.values()]; }

  start(): string | null {
    if (this.running) return null;
    if (this.authority === null) {
      if (this.issuerName === null) return '% Please enter the "issuer-name" before starting the server.';
      const now = this.deps.now();
      this.authority = CertificateAuthority.generate(this.issuerName, {
        now, validityMs: this.lifetimes.caCertificateDays * DAY_MS,
      });
    }
    this.running = true;
    return null;
  }

  stop(): void { this.running = false; }

  runningConfigLines(): string[] {
    const lines = [`crypto pki server ${this.name}`];
    if (this.issuerName) lines.push(` issuer-name ${this.issuerName}`);
    if (this.grantAuto) lines.push(' grant auto');
    if (this.lifetimes.certificateDays !== 365) lines.push(` lifetime certificate ${this.lifetimes.certificateDays}`);
    if (this.lifetimes.caCertificateDays !== 1825) lines.push(` lifetime ca-certificate ${this.lifetimes.caCertificateDays}`);
    if (this.lifetimes.crlHours !== 168) lines.push(` lifetime crl ${this.lifetimes.crlHours}`);
    if (this.cdpUrl) lines.push(` cdp-url ${this.cdpUrl}`);
    if (!this.running) lines.push(' shutdown');
    return lines;
  }

  granted(): EnrollmentRecord[] {
    return this.enrollments.filter((r) => r.state === 'granted');
  }

  private issue(record: EnrollmentRecord): void {
    const authority = this.authority;
    if (authority === null) return;
    const now = this.deps.now();
    const certificate = authority.signRequest(record.request, {
      notBefore: now,
      notAfter: now + this.lifetimes.certificateDays * DAY_MS,
      crlDistributionPoints: this.cdpUrl ? [this.cdpUrl] : undefined,
    });
    if (certificate === null) {
      record.state = 'rejected';
      return;
    }
    record.certificate = certificate;
    record.state = 'granted';
  }

  grant(target: 'all' | number): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state !== 'pending') continue;
      if (target !== 'all' && record.id !== target) continue;
      this.issue(record);
      count++;
    }
    return count;
  }

  reject(target: 'all' | number): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state !== 'pending') continue;
      if (target !== 'all' && record.id !== target) continue;
      record.state = 'rejected';
      count++;
    }
    return count;
  }

  revoke(serial: string): boolean {
    const hit = this.granted().find((r) => r.certificate?.serialNumber.toLowerCase() === serial.toLowerCase());
    if (!hit || !this.authority) return false;
    this.authority.revoke(hit.certificate!.serialNumber, this.deps.now());
    return true;
  }

  unrevoke(serial: string): boolean {
    const hit = this.granted().find((r) => r.certificate?.serialNumber.toLowerCase() === serial.toLowerCase());
    return hit !== undefined && this.authority !== null && this.authority.unrevoke(hit.certificate!.serialNumber);
  }

  remove(target: 'all' | number): number {
    let count = 0;
    for (const record of [...this.records.values()]) {
      if (target !== 'all' && record.id !== target) continue;
      this.records.delete(record.id);
      count++;
    }
    return count;
  }

  crl() {
    return this.authority?.publishCRL(this.deps.now(), this.lifetimes.crlHours * 3600 * 1000) ?? null;
  }

  private reply(status: number, reason: string, pkiStatus: string, body: string, extra?: Record<string, string>): HttpMessage {
    const response = createResponse(status, reason);
    response.headers.set('Content-Type', 'text/plain');
    response.headers.set('X-Pki-Status', pkiStatus);
    for (const [k, v] of Object.entries(extra ?? {})) response.headers.set(k, v);
    response.body = binaryStringToBytes(body);
    response.headers.set('Content-Length', String(body.length));
    return response;
  }

  private answerFor(record: EnrollmentRecord): HttpMessage {
    const extra = { 'X-Pki-Transaction': String(record.id) };
    if (record.state === 'granted') return this.reply(200, 'OK', 'SUCCESS', certToPem(record.certificate!), extra);
    if (record.state === 'rejected') return this.reply(200, 'OK', 'FAILURE', '', extra);
    return this.reply(200, 'OK', 'PENDING', '', extra);
  }

  handle(request: HttpMessage): HttpMessage {
    if (!this.running || this.authority === null) {
      return this.reply(503, 'Service Unavailable', 'FAILURE', '');
    }
    const target = request.target ?? '/';
    const query = new URLSearchParams(target.includes('?') ? target.slice(target.indexOf('?') + 1) : '');
    const operation = query.get('operation');
    if (operation === 'GetCACert') {
      return this.reply(200, 'OK', 'SUCCESS', certToPem(this.authority.rootCertificate));
    }
    if (operation === 'GetCRL') {
      const crl = this.crl();
      return crl ? this.reply(200, 'OK', 'SUCCESS', crlToPem(crl)) : this.reply(503, 'Service Unavailable', 'FAILURE', '');
    }
    if (operation === 'GetCertInitial') {
      const record = this.records.get(Number(query.get('transactionId')));
      return record ? this.answerFor(record) : this.reply(404, 'Not Found', 'FAILURE', '');
    }
    if (operation === 'PKIOperation' && (request.method ?? 'GET').toUpperCase() === 'POST') {
      const csr = pemToCsr(request.body ? bytesToBinaryString(request.body) : '');
      if (csr === null) return this.reply(400, 'Bad Request', 'FAILURE', '');
      const duplicate = this.enrollments.find((r) => r.state === 'pending' && csrToPem(r.request) === csrToPem(csr));
      if (duplicate) return this.answerFor(duplicate);
      const record: EnrollmentRecord = {
        id: this.nextId++, subject: csr.subject, request: csr, receivedMs: this.deps.now(), state: 'pending',
      };
      this.records.set(record.id, record);
      if (this.grantAuto) this.issue(record);
      return this.answerFor(record);
    }
    return this.reply(400, 'Bad Request', 'FAILURE', '');
  }
}
