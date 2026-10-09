export function isJournalFollow(tokens: readonly string[]): boolean {
  return tokens[0] === 'journalctl' && (tokens.includes('-f') || tokens.includes('--follow'));
}

export function followArguments(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '-f' || token === '--follow') continue;
    if (token === '-n' || token === '--lines') {
      i++;
      continue;
    }
    if (token.startsWith('--lines=') || /^-n\d+$/.test(token)) continue;
    kept.push(token);
  }
  return kept;
}

export function snapshotCommand(args: readonly string[]): string {
  const withoutFollow = args.filter((token) => token !== '-f' && token !== '--follow');
  const hasLines = args.some((token) => token === '-n' || token === '--lines' || token.startsWith('--lines=') || /^-n\d+$/.test(token));
  return ['journalctl', ...(hasLines ? [] : ['-n', '10']), ...withoutFollow].join(' ');
}
