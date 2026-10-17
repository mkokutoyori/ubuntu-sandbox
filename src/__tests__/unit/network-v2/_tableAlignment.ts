export interface AlignmentViolation {
  readonly line: number;
  readonly header: string;
  readonly problem: string;
}

const RULE = /^\s*[-=]{2,}(?:\s+[-=]{2,})+\s*$/;

function ruleSegments(line: string): Array<[number, number]> {
  return [...line.matchAll(/[-=]+/g)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
}

export function findAlignmentViolations(output: string): AlignmentViolation[] {
  const lines = output.split('\n');
  const found: AlignmentViolation[] = [];
  lines.forEach((line, index) => {
    if (index === 0 || !RULE.test(line)) return;
    const header = lines[index - 1];
    if (header.trim() === '' || RULE.test(header)) return;
    const segments = ruleSegments(line);
    const gaps = segments.slice(0, -1).map((segment, k) => [segment[1], segments[k + 1][0]] as [number, number]);
    const spillsIntoGap = (row: string): [number, number] | undefined =>
      gaps.find(([from, to]) => row.slice(from, to).trim() !== '');
    const headerGap = spillsIntoGap(header);
    if (headerGap) found.push({ line: index, header, problem: `header text crosses the gap ${headerGap}` });
    if (header.trimEnd().length > segments[segments.length - 1][1]) {
      found.push({ line: index, header, problem: 'header wider than its rule' });
    }
    for (const row of lines.slice(index + 1)) {
      if (row.trim() === '' || RULE.test(row)) break;
      const gap = spillsIntoGap(row);
      if (gap) {
        found.push({ line: index, header, problem: `row crosses the gap ${gap}: ${row}` });
        break;
      }
    }
  });
  return found;
}
