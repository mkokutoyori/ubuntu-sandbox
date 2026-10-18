export type SplitPredicate = (character: string, text: string, index: number) => boolean;

export function splitWithPredicate(text: string, predicate: SplitPredicate, limit: number): string[] {
  if (limit === 1) return [text];
  const pieces: string[] = [];
  let cursor = 0;
  let length = 0;
  for (let step = 0; step < text.length; step++) {
    if (!predicate(text[cursor], text, cursor)) {
      length++;
      cursor++;
      continue;
    }
    pieces.push(text.slice(cursor - length, cursor));
    length = 0;
    cursor++;
    if (limit === pieces.length + 1) break;
  }
  pieces.push(cursor === text.length ? text.slice(cursor - length, cursor) : text.slice(cursor));
  return pieces;
}

export function splitWithPredicateFromEnd(text: string, predicate: SplitPredicate, limit: number): string[] {
  if (limit === -1) return [text];
  const pieces: string[] = [];
  let cursor = text.length - 1;
  let length = 0;
  for (let step = 0; step < text.length; step++) {
    if (!predicate(text[cursor], text, cursor)) {
      length++;
      cursor--;
      continue;
    }
    pieces.push(text.substr(cursor + 1, length));
    length = 0;
    cursor--;
    if (Math.abs(limit) === pieces.length + 1) break;
  }
  pieces.push(cursor === -1 ? text.slice(0, length) : text.slice(0, cursor + 1));
  return pieces.reverse();
}
