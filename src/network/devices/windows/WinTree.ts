import type { WinFSEntry } from './WindowsFileSystem';

export interface TreeOptions {
  readonly files: boolean;
  readonly ascii: boolean;
}

interface Glyphs {
  readonly branch: string;
  readonly last: string;
  readonly bar: string;
}

const EXTENDED: Glyphs = { branch: '├───', last: '└───', bar: '│   ' };
const PLAIN: Glyphs = { branch: '+---', last: '\\---', bar: '|   ' };
const BLANK = '    ';

export const TREE_HELP = [
  'Graphically displays the folder structure of a drive or path.',
  '',
  'TREE [drive:][path] [/F] [/A]',
  '',
  '   /F   Display the names of the files in each folder.',
  '   /A   Use ASCII instead of extended characters.',
].join('\n');

function byName(left: WinFSEntry, right: WinFSEntry): number {
  return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
}

export function treeBody(root: WinFSEntry, options: TreeOptions): string[] {
  const glyphs = options.ascii ? PLAIN : EXTENDED;
  const lines: string[] = [];
  const walk = (directory: WinFSEntry, prefix: string, endsOutput: boolean): void => {
    const children = Array.from(directory.children.values()).sort(byName);
    const subdirectories = children.filter(child => child.type === 'directory');
    if (options.files) {
      const files = children.filter(child => child.type !== 'directory');
      const filePrefix = prefix + (subdirectories.length > 0 ? glyphs.bar : BLANK);
      for (const file of files) lines.push(filePrefix + file.name);
      if (files.length > 0 && !(endsOutput && subdirectories.length === 0)) lines.push(filePrefix);
    }
    subdirectories.forEach((child, index) => {
      const last = index === subdirectories.length - 1;
      lines.push(prefix + (last ? glyphs.last : glyphs.branch) + child.name);
      walk(child, prefix + (last ? BLANK : glyphs.bar), endsOutput && last);
    });
  };
  walk(root, '', true);
  return lines;
}

export function treeHeading(label: string): string {
  return label ? `Folder PATH listing for volume ${label}` : 'Folder PATH listing';
}
