export interface RootHint {
  readonly name: string;
  readonly address: string;
}

export const IANA_ROOT_HINTS: readonly RootHint[] = [
  { name: 'a.root-servers.net.', address: '198.41.0.4' },
  { name: 'b.root-servers.net.', address: '170.247.170.2' },
  { name: 'c.root-servers.net.', address: '192.33.4.12' },
  { name: 'd.root-servers.net.', address: '199.7.91.13' },
  { name: 'e.root-servers.net.', address: '192.203.230.10' },
  { name: 'f.root-servers.net.', address: '192.5.5.241' },
  { name: 'g.root-servers.net.', address: '192.112.36.4' },
  { name: 'h.root-servers.net.', address: '198.97.190.53' },
  { name: 'i.root-servers.net.', address: '192.36.148.17' },
  { name: 'j.root-servers.net.', address: '192.58.128.30' },
  { name: 'k.root-servers.net.', address: '193.0.14.129' },
  { name: 'l.root-servers.net.', address: '199.7.83.42' },
  { name: 'm.root-servers.net.', address: '202.12.27.33' },
];

const ROOT_TTL = 3600000;

export function renderRootHintsFile(hints: readonly RootHint[]): string {
  const names = [...new Set(hints.map(h => h.name))];
  const lines = names.map(name => `.                        ${ROOT_TTL} NS    ${name}`);
  for (const hint of hints) lines.push(`${hint.name} ${ROOT_TTL} A     ${hint.address}`);
  return `${lines.join('\n')}\n`;
}
