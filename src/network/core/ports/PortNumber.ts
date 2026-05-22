/**
 * PortNumber — value object for a transport-layer port number.
 *
 * A bare `number` carries no rules; this value object encapsulates the
 * RFC 6335 invariants a real OS enforces: the 0–65535 range, the
 * well-known / registered / dynamic classification, and whether binding
 * the port needs elevated privilege.
 *
 * It is immutable and compared by value — two `PortNumber`s holding the
 * same integer are interchangeable. Construction fails fast on an
 * out-of-range value, so an invalid port can never propagate.
 */

/** The two transport protocols a port can be bound on. */
export type TransportProtocol = 'tcp' | 'udp';

/** A protocol-qualified listening endpoint — what a service binds. */
export interface PortSpec {
  port: number;
  protocol: TransportProtocol;
  /** Bind address; defaults to `0.0.0.0` (all interfaces) when omitted. */
  address?: string;
}

/** Lowest valid port number. */
export const MIN_PORT = 0;
/** Highest valid port number. */
export const MAX_PORT = 65535;
/** Ports below this conventionally require privilege to bind (POSIX). */
export const PRIVILEGED_PORT_CEILING = 1024;
/** First port of the RFC 6335 dynamic/ephemeral range. */
export const FIRST_DYNAMIC_PORT = 49152;

/** RFC 6335 port-range classification. */
export enum PortClass {
  /** 0–1023 — system / well-known ports, assigned by IANA. */
  WellKnown = 'well-known',
  /** 1024–49151 — user / registered ports. */
  Registered = 'registered',
  /** 49152–65535 — dynamic / private / ephemeral ports. */
  Dynamic = 'dynamic',
}

export class PortNumber {
  readonly value: number;

  constructor(value: number) {
    if (!PortNumber.isValid(value)) {
      throw new RangeError(
        `Invalid port number ${value}: must be an integer in ${MIN_PORT}–${MAX_PORT}`,
      );
    }
    this.value = value;
  }

  /** Construct from a raw integer (throws on an out-of-range value). */
  static of(value: number): PortNumber {
    return new PortNumber(value);
  }

  /** Parse a textual port, returning null on anything invalid. */
  static tryParse(text: string): PortNumber | null {
    if (!/^\d+$/.test(text.trim())) return null;
    const value = Number(text.trim());
    return PortNumber.isValid(value) ? new PortNumber(value) : null;
  }

  /** True when `value` is an integer within the valid port range. */
  static isValid(value: number): boolean {
    return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
  }

  /** RFC 6335 classification of this port. */
  get classification(): PortClass {
    if (this.value < PRIVILEGED_PORT_CEILING) return PortClass.WellKnown;
    if (this.value < FIRST_DYNAMIC_PORT) return PortClass.Registered;
    return PortClass.Dynamic;
  }

  get isWellKnown(): boolean {
    return this.classification === PortClass.WellKnown;
  }

  get isRegistered(): boolean {
    return this.classification === PortClass.Registered;
  }

  get isDynamic(): boolean {
    return this.classification === PortClass.Dynamic;
  }

  /** True when binding this port conventionally needs root/CAP_NET_BIND_SERVICE. */
  get isPrivileged(): boolean {
    return this.value < PRIVILEGED_PORT_CEILING;
  }

  /** True for the dynamic range an OS draws ephemeral source ports from. */
  get isEphemeral(): boolean {
    return this.value >= FIRST_DYNAMIC_PORT;
  }

  equals(other: PortNumber): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }
}
