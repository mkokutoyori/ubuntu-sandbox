import { renderTable, type TableColumn } from '@/network/devices/shells/cli/TextTable';

type EventObject = Record<string, unknown>;

const RECORD_KEYS = ['providername', 'timecreated', 'leveldisplayname', 'recordid', 'machinename'];
const CONFIGURATION_KEYS = ['logname', 'logtype', 'logisolation', 'maximumsizeinbytes', 'logmode'];

function hasKeys(object: EventObject, wanted: readonly string[]): boolean {
  const present = new Set(Object.keys(object).map((key) => key.toLowerCase()));
  return wanted.every((key) => present.has(key));
}

function property(object: EventObject, name: string): unknown {
  const key = Object.keys(object).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}

export function generalDateTime(value: Date): string {
  const hours = value.getHours();
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
  return `${value.getMonth() + 1}/${value.getDate()}/${value.getFullYear()} ${clock} ${hours >= 12 ? 'PM' : 'AM'}`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return generalDateTime(value);
  return String(value);
}

function recordView(objects: readonly EventObject[]): string {
  const groups: Array<{ provider: string; rows: EventObject[] }> = [];
  for (const object of objects) {
    const provider = cell(property(object, 'ProviderName'));
    const last = groups[groups.length - 1];
    if (last !== undefined && last.provider === provider) last.rows.push(object);
    else groups.push({ provider, rows: [object] });
  }
  const columns: Array<TableColumn<EventObject>> = [
    { header: 'TimeCreated', width: 26, value: (row) => cell(property(row, 'TimeCreated')) },
    { header: 'Id', width: 8, align: 'right', value: (row) => cell(property(row, 'Id')) },
    { header: 'LevelDisplayName', width: 16, value: (row) => cell(property(row, 'LevelDisplayName')) },
    { header: 'Message', value: (row) => cell(property(row, 'Message')).split('\n')[0] },
  ];
  return groups.map((group) => {
    const body = renderTable(group.rows, columns, { gap: 1, rule: true, ruleFitsHeader: true, padTrailing: true });
    return `\n   ProviderName: ${group.provider}\n\n${body.join('\n')}\n`;
  }).join('');
}

function configurationView(objects: readonly EventObject[]): string {
  const columns: Array<TableColumn<EventObject>> = [
    { header: 'LogMode', width: 9, value: (row) => cell(property(row, 'LogMode')) },
    { header: 'MaximumSizeInBytes', width: 18, align: 'right', value: (row) => cell(property(row, 'MaximumSizeInBytes')) },
    { header: 'RecordCount', width: 11, align: 'right', value: (row) => cell(property(row, 'RecordCount')) },
    { header: 'LogName', value: (row) => cell(property(row, 'LogName')) },
  ];
  const body = renderTable(objects, columns, { gap: 1, rule: true, ruleFitsHeader: true, padTrailing: true });
  return `\n${body.join('\n')}\n`;
}

function providerView(objects: readonly EventObject[]): string {
  const rows = objects.map((object) => ['Name', 'LogLinks', 'Opcodes', 'Tasks']
    .map((name) => `${name.padEnd(8)} : ${cellOrCollection(property(object, name))}`).join('\n'));
  return `\n${rows.join('\n\n')}\n`;
}

function cellOrCollection(value: unknown): string {
  if (Array.isArray(value)) return `{${value.map((item) => cellOrCollection(item)).join(', ')}}`;
  if (value !== null && typeof value === 'object') return String((value as EventObject).LogName ?? '');
  return cell(value);
}

export function eventDefaultView(objects: readonly EventObject[]): string | null {
  const first = objects[0];
  if (first === undefined) return null;
  if (hasKeys(first, RECORD_KEYS)) return recordView(objects);
  if (hasKeys(first, CONFIGURATION_KEYS)) return configurationView(objects);
  if (hasKeys(first, ['name', 'loglinks', 'opcodes', 'tasks'])) return providerView(objects);
  return null;
}
