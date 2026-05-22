/**
 * PortProxyRule — one `netsh interface portproxy` forwarding entry.
 *
 * Windows' port-proxy service (`iphlpsvc`) accepts a connection on a
 * local listen address/port and relays it to a connect address/port,
 * optionally bridging address families. This immutable value object
 * models a single such rule.
 */

/** Address-family pairing of a port-proxy rule. */
export type PortProxyFamily = 'v4tov4' | 'v4tov6' | 'v6tov4' | 'v6tov6';

/** The four families `netsh interface portproxy` accepts. */
export const PORT_PROXY_FAMILIES: readonly PortProxyFamily[] = [
  'v4tov4', 'v4tov6', 'v6tov4', 'v6tov6',
];

export class PortProxyRule {
  constructor(
    /** Address-family pairing (listen-side → connect-side). */
    readonly family: PortProxyFamily,
    /** Address the proxy listens on (`0.0.0.0` / `::` = all interfaces). */
    readonly listenAddress: string,
    /** TCP port the proxy listens on. */
    readonly listenPort: number,
    /** Address connections are relayed to. */
    readonly connectAddress: string,
    /** TCP port connections are relayed to. */
    readonly connectPort: number,
  ) {}

  /** Whether the listen side is IPv6. */
  get listenIsV6(): boolean {
    return this.family === 'v6tov4' || this.family === 'v6tov6';
  }

  /** Whether the connect side is IPv6. */
  get connectIsV6(): boolean {
    return this.family === 'v4tov6' || this.family === 'v6tov6';
  }

  /**
   * Uniqueness key — `netsh` keys a rule on its family plus its listen
   * endpoint, so two rules may share a listen port on different
   * addresses or families.
   */
  get key(): string {
    return `${this.family}|${this.listenAddress}|${this.listenPort}`;
  }

  /** A human-readable one-line description, for logs. */
  describe(): string {
    return `${this.listenAddress}:${this.listenPort} → ` +
      `${this.connectAddress}:${this.connectPort} (${this.family})`;
  }
}
