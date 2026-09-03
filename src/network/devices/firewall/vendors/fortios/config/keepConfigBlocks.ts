export function keepConfigBlocks(
  text: string, branches: readonly string[],
): string {
  const wanted = new Set(branches.map(branch => `config ${branch}`));
  const kept: string[] = [];
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index++) {
    if (!wanted.has(lines[index])) continue;
    let depth = 0;
    for (; index < lines.length; index++) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith('config ')) depth++;
      else if (trimmed === 'end') depth--;
      kept.push(lines[index]);
      if (depth === 0) break;
    }
  }
  return kept.join('\n');
}
