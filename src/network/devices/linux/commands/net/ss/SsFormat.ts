export function formatG(value: number, precision = 6): string {
  if (value === 0) return '0';
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const scientific = value.toExponential(precision - 1);
  const [mantissa, exponentText] = scientific.split('e');
  const exponent = Number(exponentText);
  const trim = (text: string): string => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);
  if (exponent < -4 || exponent >= precision) {
    const sign = exponent < 0 ? '-' : '+';
    return `${trim(mantissa)}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  return trim(value.toFixed(Math.max(0, precision - 1 - exponent)));
}

export function printMsTimer(timeoutMs: number): string {
  const total = Math.max(0, Math.floor(timeoutMs));
  let seconds = Math.floor(total / 1000);
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  let milliseconds = total % 1000;
  let text = '';
  if (minutes > 0) {
    milliseconds = 0;
    text += `${minutes}min`;
    if (minutes > 9) seconds = 0;
  }
  if (seconds > 0) {
    if (seconds > 9) milliseconds = 0;
    text += `${seconds}${milliseconds > 0 ? '.' : 'sec'}`;
  }
  if (milliseconds > 0) text += `${String(milliseconds).padStart(3, '0')}ms`;
  return text;
}

function roundHalfEven(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value % 1) === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
}

export function bandwidthText(bitsPerSecond: number, numeric: boolean): string {
  if (numeric) return roundHalfEven(bitsPerSecond).toFixed(0);
  if (bitsPerSecond >= 1e12) return `${formatG(bitsPerSecond / 1e12, 3)}T`;
  if (bitsPerSecond >= 1e9) return `${formatG(bitsPerSecond / 1e9, 3)}G`;
  if (bitsPerSecond >= 1e6) return `${formatG(bitsPerSecond / 1e6, 3)}M`;
  if (bitsPerSecond >= 1e3) return `${formatG(bitsPerSecond / 1e3, 3)}k`;
  return formatG(bitsPerSecond);
}

const LINUX_JIFFY_MS = 4;

export function wholeMicroseconds(milliseconds: number): number {
  return Math.round(milliseconds * 1000) / 1000;
}

export function wholeJiffies(milliseconds: number): number {
  return Math.ceil(milliseconds / LINUX_JIFFY_MS) * LINUX_JIFFY_MS;
}

export function hexMask(value: number): string {
  return value === 0 ? '0' : `0x${(value >>> 0).toString(16)}`;
}
