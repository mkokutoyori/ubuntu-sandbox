export const MAX_SEARCH_HISTORY = 100;

export interface HistoryLists {
  readonly search: string[];
  readonly replace: string[];
  readonly execute: string[];
}

export function emptyHistoryLists(): HistoryLists {
  return { search: [], replace: [], execute: [] };
}

export function appendToHistory(list: string[], text: string, pruneDuplicates: boolean): void {
  if (pruneDuplicates) {
    const same = list.lastIndexOf(text);
    if (same >= 0) list.splice(same, 1);
  }
  if (list.length === MAX_SEARCH_HISTORY) list.shift();
  list.push(text);
}

export function parseHistoryLists(content: string): HistoryLists {
  const lists = emptyHistoryLists();
  const order = [lists.search, lists.replace, lists.execute];
  let current = 0;
  let rest = content;
  while (rest.length > 0) {
    const end = rest.indexOf('\n');
    const line = end < 0 ? rest.slice(0, -1) : rest.slice(0, end);
    rest = end < 0 ? '' : rest.slice(end + 1);
    if (line.length > 0) appendToHistory(order[current], line.replace(/\0/g, '\n'), false);
    else current = Math.min(current + 1, order.length - 1);
  }
  return lists;
}

export function serializeHistoryLists(lists: HistoryLists): string {
  return [lists.search, lists.replace, lists.execute]
    .map((list) => list.map((entry) => `${entry.replace(/\n/g, '\0')}\n`).join('') + '\n')
    .join('');
}
