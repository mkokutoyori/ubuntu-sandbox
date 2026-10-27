export function parseChmodMode(modeStr: string, current: number): number | null {
  if (/^[0-7]+$/.test(modeStr)) {
    return parseInt(modeStr, 8);
  }
  if (/^\d+$/.test(modeStr)) return null;

  // Symbolic mode: u+x, g-w, o=r, a+x, u+s, g+s, +t, u+w,g-w,o=r
  let mode = current;
  const parts = modeStr.split(',');

  for (const part of parts) {
    const match = part.match(/^([ugoa]*)([+\-=])([rwxstXugo]*)$/);
    if (!match) return null;

    let who = match[1] || 'a';
    const op = match[2];
    const perms = match[3];

    // Expand 'a' to 'ugo'
    if (who === 'a' || who === '') who = 'ugo';

    let bits = 0;
    let specialBits = 0;

    for (const p of perms) {
      switch (p) {
        case 'r': bits |= 4; break;
        case 'w': bits |= 2; break;
        case 'x': bits |= 1; break;
        case 's':
          if (who.includes('u')) specialBits |= 0o4000;
          if (who.includes('g')) specialBits |= 0o2000;
          break;
        case 't':
          specialBits |= 0o1000;
          break;
      }
    }

    for (const w of who) {
      let shift: number;
      switch (w) {
        case 'u': shift = 6; break;
        case 'g': shift = 3; break;
        case 'o': shift = 0; break;
        default: continue;
      }

      const shiftedBits = bits << shift;

      switch (op) {
        case '+':
          mode |= shiftedBits;
          break;
        case '-':
          mode &= ~shiftedBits;
          break;
        case '=':
          // Clear the 3 bits for this category, then set
          mode &= ~(7 << shift);
          mode |= shiftedBits;
          break;
      }
    }

    // Apply special bits
    if (specialBits) {
      if (op === '+') mode |= specialBits;
      else if (op === '-') mode &= ~specialBits;
    }
  }

  return mode;
}
