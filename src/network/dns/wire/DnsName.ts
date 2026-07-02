export function normalizeDnsName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

export function parentName(name: string): string | null {
  const dot = name.indexOf('.');
  return dot === -1 ? null : name.slice(dot + 1);
}

export function isWithinDomain(name: string, domain: string): boolean {
  return domain === '' || name === domain || name.endsWith(`.${domain}`);
}
