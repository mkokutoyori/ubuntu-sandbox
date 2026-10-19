export interface PrincipalsPathContext {
  readonly user: string;
  readonly uid: number;
  readonly home: string;
}

export function expandPrincipalsPath(pattern: string, context: PrincipalsPathContext): string {
  const expanded = pattern.replace(/%([%huU])/g, (_match, token: string) => {
    if (token === '%') return '%';
    if (token === 'h') return context.home;
    if (token === 'u') return context.user;
    return String(context.uid);
  });
  return expanded.startsWith('/') ? expanded : `${context.home.replace(/\/$/, '')}/${expanded}`;
}
