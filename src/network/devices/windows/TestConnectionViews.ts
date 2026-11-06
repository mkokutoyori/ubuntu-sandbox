import type { PSObject } from './PSPipeline';

interface ViewColumn {
  readonly label: string;
  readonly width: number;
  readonly align: 'left' | 'right';
  readonly cell: (row: PSObject) => string;
}

interface TableView {
  readonly groupBy: string;
  readonly columns: readonly ViewColumn[];
}

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

const timedOutOr = (property: string) => (row: PSObject): string => (row.Status === 'TimedOut' ? '*' : text(row[property]));

const PING_STATUS: TableView = {
  groupBy: 'Destination',
  columns: [
    { label: 'Ping', width: 4, align: 'right', cell: (row) => text(row.Ping) },
    { label: 'Source', width: 16, align: 'left', cell: (row) => text(row.Source) },
    { label: 'Address', width: 25, align: 'left', cell: (row) => text(row.DisplayAddress) },
    { label: 'Latency(ms)', width: 7, align: 'right', cell: timedOutOr('Latency') },
    { label: 'BufferSize(B)', width: 10, align: 'right', cell: timedOutOr('BufferSize') },
    { label: 'Status', width: 16, align: 'left', cell: (row) => text(row.Status) },
  ],
};

const TCP_PORT_STATUS: TableView = {
  groupBy: 'Target',
  columns: [
    { label: 'Id', width: 4, align: 'right', cell: (row) => text(row.Id) },
    { label: 'Source', width: 16, align: 'left', cell: (row) => text(row.Source) },
    { label: 'Address', width: 25, align: 'left', cell: (row) => text(row.TargetAddress) },
    { label: 'Port', width: 7, align: 'right', cell: (row) => text(row.Port) },
    { label: 'Latency(ms)', width: 7, align: 'right', cell: (row) => text(row.Latency) },
    { label: 'Connected', width: 10, align: 'left', cell: (row) => text(row.Connected) },
    { label: 'Status', width: 24, align: 'left', cell: (row) => text(row.Status) },
  ],
};

const TRACE_STATUS: TableView = {
  groupBy: 'Target',
  columns: [
    { label: 'Hop', width: 3, align: 'right', cell: (row) => text(row.Hop) },
    { label: 'Hostname', width: 25, align: 'left', cell: (row) => (text(row.Hostname) === '' ? '*' : text(row.Hostname)) },
    { label: 'Ping', width: 4, align: 'right', cell: (row) => text(row.Ping) },
    { label: 'Latency(ms)', width: 7, align: 'right', cell: timedOutOr('Latency') },
    { label: 'Status', width: 16, align: 'left', cell: (row) => text(row.Status) },
    { label: 'Source', width: 12, align: 'left', cell: (row) => text(row.Source) },
    { label: 'TargetAddress', width: 15, align: 'left', cell: (row) => text(row.TargetAddress) },
  ],
};

const ELLIPSIS = '…';

function fitCell(value: string, width: number, align: 'left' | 'right'): string {
  const clipped = value.length > width ? value.slice(0, Math.max(0, width - 1)) + ELLIPSIS : value;
  return align === 'right' ? clipped.padStart(width) : clipped.padEnd(width);
}

function wrapLabel(label: string, width: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < label.length; start += width) parts.push(label.slice(start, start + width));
  return parts;
}

function headerLines(view: TableView): string[] {
  const wrapped = view.columns.map((column) => wrapLabel(column.label, column.width));
  const height = Math.max(...wrapped.map((parts) => parts.length));
  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    const cells = view.columns.map((column, index) => {
      const part = wrapped[index][row];
      return part === undefined ? ''.padEnd(column.width) : fitCell(part, column.width, column.align);
    });
    lines.push(cells.join(' ').trimEnd());
  }
  lines.push(view.columns.map((column) => '-'.repeat(Math.min(column.label.length, column.width)).padEnd(column.width)).join(' ').trimEnd());
  return lines;
}

function rowLine(view: TableView, row: PSObject): string {
  return view.columns.map((column) => fitCell(column.cell(row), column.width, column.align)).join(' ').trimEnd();
}

function viewOf(row: PSObject): TableView | null {
  const keys = new Set(Object.keys(row).map((key) => key.toLowerCase()));
  if (keys.has('hop') && keys.has('hopaddress') && keys.has('targetaddress')) return TRACE_STATUS;
  if (keys.has('connected') && keys.has('targetaddress') && keys.has('port')) return TCP_PORT_STATUS;
  if (keys.has('displayaddress') && keys.has('buffersize') && keys.has('destination') && keys.has('ping')) return PING_STATUS;
  return null;
}

function banner(view: TableView, group: string): string[] {
  return ['', `   ${view.groupBy}: ${group}`, ''];
}

export function testConnectionView(objects: PSObject[]): string | null {
  const view = viewOf(objects[0]);
  if (view === null) return null;
  const groups = new Map<string, PSObject[]>();
  for (const row of objects) {
    const key = text(row[view.groupBy]);
    const members = groups.get(key);
    if (members === undefined) groups.set(key, [row]);
    else members.push(row);
  }
  const lines: string[] = [];
  for (const [group, rows] of groups) {
    lines.push(...banner(view, group), ...headerLines(view), ...rows.map((row) => rowLine(view, row)));
  }
  return [...lines, ''].join('\n');
}

export function pingStatusHeader(destination: string): string[] {
  return [...banner(PING_STATUS, destination), ...headerLines(PING_STATUS)];
}

export function pingStatusRow(row: PSObject): string {
  return rowLine(PING_STATUS, row);
}
