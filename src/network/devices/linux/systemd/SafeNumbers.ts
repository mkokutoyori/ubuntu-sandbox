export function safeAtoi(input: string): number | 'EINVAL' | 'ERANGE' {
  let s = input.replace(/^[ \t\n\r]+/, '');
  let base = 0;
  const prefixed = /^(0[bB]|0[oO])/.exec(s);
  if (prefixed) {
    base = prefixed[1][1].toLowerCase() === 'b' ? 2 : 8;
    s = s.slice(2);
  }
  const sign = s[0] === '-' || s[0] === '+' ? s[0] : '';
  let body = sign ? s.slice(1) : s;
  if (base === 0) {
    if (/^0[xX]/.test(body)) {
      base = 16;
      body = body.slice(2);
    } else if (/^0/.test(body) && body.length > 1) {
      base = 8;
      body = body.slice(1);
    } else base = 10;
  }
  const digits = base === 16 ? /^[0-9a-fA-F]+$/ : base === 8 ? /^[0-7]+$/ : base === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!digits.test(body)) return 'EINVAL';
  const value = parseInt(body, base) * (sign === '-' ? -1 : 1);
  if (value > 2147483647 || value < -2147483648) return 'ERANGE';
  return value;
}
