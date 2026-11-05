const NC_VALUED = new Set(['-s', '-p', '-w', '-i', '-I', '-O', '-P', '-T', '-V', '-x', '-X', '-Z', '--source', '--source-port', '--wait', '--proxy', '--proxy-type']);

function netcatHost(args: readonly string[]): string[] {
  const names: string[] = [];
  const operands: string[] = [];
  let listening = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '-l' || word === '--listen' || /^-[a-zA-Z]*l[a-zA-Z]*$/.test(word)) listening = true;
    if ((word === '-x' || word === '--proxy') && args[i + 1] !== undefined) names.push(args[i + 1].replace(/:\d+$/, ''));
    if (NC_VALUED.has(word)) { i++; continue; }
    if (word.startsWith('-')) continue;
    operands.push(word);
  }
  if (!listening && operands[0] !== undefined) names.push(operands[0]);
  return names;
}

export function hostOperandsOf(command: string, args: readonly string[]): string[] {
  switch (command) {
    case 'logger': {
      const names: string[] = [];
      args.forEach((word, index) => {
        if (word === '-n' || word === '--server') names.push(args[index + 1] ?? '');
        else if (word.startsWith('--server=')) names.push(word.slice(9));
        else if (/^-n./.test(word)) names.push(word.slice(2));
      });
      return names;
    }
    case 'openssl': {
      return args.flatMap((word, index) => {
        if (args[index - 1] === '-connect') return [word.slice(0, Math.max(0, word.lastIndexOf(':')))];
        if (args[index - 1] === '-url') return [/^https?:\/\/([^/:]+)/.exec(word)?.[1] ?? ''];
        return [];
      });
    }
    case 'nc': case 'ncat': case 'netcat': return netcatHost(args);
    default: return [];
  }
}
