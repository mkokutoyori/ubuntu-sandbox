import type { TcpStack } from '../../../tcp/TcpStack';
import type { VdomContext } from '../vdom/VdomRegistry';
import type { CertificateStore } from '../vpn/CertificateStore';
import { SslVpnPortal } from '../vpn/SslVpnPortal';
import {
  AuthPortal, buildAuthPortal, AUTH_PORTAL_PORT, AUTH_PORTAL_HTTPS_PORT,
  type RemoteAuthOutcome,
} from './AuthPortal';

export interface FirewallPortalDeps {
  readonly tcp: TcpStack;
  readonly now: () => number;
  readonly vdom: (name?: string) => VdomContext;
  readonly certificates: () => CertificateStore;
  readonly remoteAuthenticate: (
    server: string, user: string, password: string,
  ) => Promise<RemoteAuthOutcome>;
}

export interface PortalPorts {
  readonly http: number;
  readonly https: number;
}

export interface FirewallPortals {
  readonly auth: AuthPortal;
  readonly sslVpn: SslVpnPortal;
  ports(): PortalPorts;
  setPorts(http: number, https: number): void;
  startAuth(): boolean;
}

export function buildFirewallPortals(deps: FirewallPortalDeps): FirewallPortals {
  const auth = buildAuthPortal({
    tcp: deps.tcp,
    now: deps.now,
    vdom: deps.vdom,
    remoteAuthenticate: deps.remoteAuthenticate,
  });

  const sslVpn = new SslVpnPortal({
    tcp: deps.tcp,
    now: deps.now,
    authenticate: (address, credentials) => auth.authenticate(address, credentials),
    groupsOf: (user) => deps.vdom().users.groupsOf(user),
    certificate: (name) => {
      const declared = deps.certificates().local(name);
      return declared === undefined
        ? undefined
        : { certificate: declared.certificate, privateKey: declared.privateKey };
    },
  });

  let ports: PortalPorts = { http: AUTH_PORTAL_PORT, https: AUTH_PORTAL_HTTPS_PORT };

  return {
    auth,
    sslVpn,
    ports: () => ports,
    setPorts(http, https) {
      ports = { http, https };
      if (!auth.isListening()) return;
      auth.stop();
      auth.start(http);
    },
    startAuth: () => auth.start(ports.http),
  };
}
