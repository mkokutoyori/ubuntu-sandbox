export function parseVlanList(input: string): Set<number> | null {
  const vlans = new Set<number>();
  const parts = input.split(',');
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (isNaN(start) || isNaN(end)) return null;
      for (let i = start; i <= end; i++) vlans.add(i);
    } else {
      const num = parseInt(part, 10);
      if (isNaN(num)) return null;
      vlans.add(num);
    }
  }
  return vlans;
}

export function compactVlanList(sorted: readonly number[]): string {
  if (sorted.length === 0) return '';
  const ranges: string[] = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = end = sorted[i];
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(',');
}
