export const PROJECT_NAME = 'Lumiere Boutique - e-commerce, siege, site de reprise, deux agences, Internet simule';

export const INTERNAL_DOMAIN = 'lumiere.local';
export const NETBIOS = 'LUMIERE';
export const PUBLIC_DOMAIN = 'lumiere-boutique.com';
export const DOMAIN_PASSWORD = 'DSRM@Lum1ere!';
export const PRE_SHARED_KEY = 'Lum1ere-VPN-2026';
export const RADIUS_SECRET = 'Lum1ere-AAA';
export const SYSLOG_PORT = 514;

export const ORACLE = {
  sid: 'ORCL',
  adminPassword: 'oracle',
  appUser: 'shop',
  appPassword: 'Shop#2026',
  listenerPort: 1521,
} as const;

export const INTERNET = {
  gateway: '203.0.113.254',
  network: '203.0.113.0',
  publicDns: '203.0.113.53',
  fgtHq: '203.0.113.1',
  fgtDr: '203.0.113.2',
  fgtAg1: '203.0.113.11',
  fgtAg2: '203.0.113.12',
  vipWeb: '203.0.113.10',
  externalNet: '198.51.100.0',
  externalGateway: '198.51.100.1',
  customer: '198.51.100.50',
  payment: '198.51.100.80',
} as const;

export const HQ = {
  fgtTransit: '10.10.255.1',
  routerTransit: '10.10.255.2',
  servers: { gateway: '10.10.10.1', network: '10.10.10.0', dc1: '10.10.10.10', log: '10.10.10.40' },
  users: { gateway: '10.10.20.1', network: '10.10.20.0', rangeStart: '10.10.20.100', rangeEnd: '10.10.20.200' },
  db: { gateway: '10.10.30.1', network: '10.10.30.0', oracle: '10.10.30.10', backup: '10.10.30.20' },
  dmz: { gateway: '172.16.10.1', network: '172.16.10.0', web1: '172.16.10.11', web2: '172.16.10.12', app: '172.16.10.21' },
} as const;

export const DR = {
  fgtTransit: '10.20.255.1',
  routerTransit: '10.20.255.2',
  servers: { gateway: '10.20.10.1', network: '10.20.10.0', dc2: '10.20.10.10' },
  db: { gateway: '10.20.30.1', network: '10.20.30.0', standby: '10.20.30.10', backup: '10.20.30.20' },
  dmz: { gateway: '172.17.10.1', network: '172.17.10.0', web: '172.17.10.11' },
} as const;

export interface Agency {
  readonly name: string;
  readonly label: string;
  readonly wan: string;
  readonly gateway: string;
  readonly network: string;
  readonly client: string;
  readonly tunnel: string;
}

export const AGENCIES: readonly Agency[] = [
  { name: 'AG1', label: 'Boutique Paris', wan: INTERNET.fgtAg1, gateway: '10.1.0.1', network: '10.1.0.0', client: '10.1.0.50', tunnel: 'to-ag1' },
  { name: 'AG2', label: 'Entrepot Lyon', wan: INTERNET.fgtAg2, gateway: '10.2.0.1', network: '10.2.0.0', client: '10.2.0.50', tunnel: 'to-ag2' },
];

export const DR_TUNNEL = 'to-dr';
