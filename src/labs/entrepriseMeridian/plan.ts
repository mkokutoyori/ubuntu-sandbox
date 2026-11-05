export const PROJECT_NAME = 'Entreprise Meridian - siege, trois agences, Internet simule';

export const INTERNAL_DOMAIN = 'meridian.local';
export const PUBLIC_DOMAIN = 'meridian-industries.com';
export const DOMAIN_PASSWORD = 'DSRM@Mer1dian!';
export const PRE_SHARED_KEY = 'Mer1dian-VPN-2026';

export interface Site {
  readonly name: string;
  readonly wan: string;
  readonly lanGateway: string;
  readonly lanNetwork: string;
  readonly lanRoute: string;
  readonly tunnelOnHub: string;
  readonly tunnelOnSpoke: string;
}

const site = (index: number): Site => ({
  name: `AGENCE${index}`,
  wan: `203.0.113.${index + 1}`,
  lanGateway: `10.${index}.0.1`,
  lanNetwork: `10.${index}.0.0/24`,
  lanRoute: `10.${index}.0.0 255.255.255.0`,
  tunnelOnHub: `to-ag${index}`,
  tunnelOnSpoke: 'to-hq',
});

export const SITES: readonly Site[] = [site(1), site(2), site(3)];

export const HQ = {
  wan: '203.0.113.1',
  wanVip: { web: '203.0.113.10', mail: '203.0.113.25' },
  lanGateway: '10.0.0.1',
  dmzGateway: '172.16.0.1',
  dc1: '10.0.0.10',
  oracle: '10.0.0.30',
  workstation: '10.0.0.50',
  web: '172.16.0.10',
  mail: '172.16.0.25',
} as const;

export const INTERNET = {
  web: '203.0.113.80',
  visitor: '203.0.113.99',
} as const;
