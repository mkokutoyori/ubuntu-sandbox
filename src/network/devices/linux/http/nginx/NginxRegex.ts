export function compileNginxRegex(pattern: string, caseless: boolean): RegExp | string {
  try {
    return new RegExp(pattern, caseless ? 'i' : '');
  } catch {
    return `pcre2_compile() failed: invalid regular expression in "${pattern}"`;
  }
}
