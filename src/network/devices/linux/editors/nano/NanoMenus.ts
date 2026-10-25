export interface MenuEntry {
  readonly key: string;
  readonly tag: string;
}

export type NanoMenuName =
  | 'main' | 'search' | 'replace' | 'replace-with' | 'write-out' | 'read-file' | 'goto' | 'execute' | 'help' | 'search-in-help';

const E = (key: string, tag: string): MenuEntry => ({ key, tag });

export const NANO_MENUS: Readonly<Record<NanoMenuName, readonly MenuEntry[]>> = {
  main: [
    E('^G', 'Help'), E('^X', 'Exit'), E('^O', 'Write Out'), E('^R', 'Read File'), E('^W', 'Where Is'),
    E('^\\', 'Replace'), E('^K', 'Cut'), E('^U', 'Paste'), E('^T', 'Execute'), E('^J', 'Justify'),
    E('^C', 'Location'), E('^/', 'Go To Line'), E('M-U', 'Undo'), E('M-E', 'Redo'), E('M-A', 'Set Mark'),
    E('M-6', 'Copy'), E('M-]', 'To Bracket'), E('^Q', 'Where Was'), E('M-Q', 'Previous'), E('M-W', 'Next'),
    E('^B', 'Back'), E('^F', 'Forward'), E('^◂', 'Prev Word'), E('^▸', 'Next Word'), E('^A', 'Home'),
    E('^E', 'End'), E('^P', 'Prev Line'), E('^N', 'Next Line'), E('M-▴', 'Scroll Up'), E('M-▾', 'Scroll Down'),
    E('^▴', 'Prev Block'), E('^▾', 'Next Block'), E('M-(', 'Begin of Paragr.'), E('M-)', 'End of Paragraph'),
    E('^Y', 'Prev Page'), E('^V', 'Next Page'), E('M-\\', 'First Line'), E('M-/', 'Last Line'),
    E('M-◂', 'Prev File'), E('M-▸', 'Next File'), E('^I', 'Tab'), E('^M', 'Enter'), E('^H', 'Backspace'),
    E('^D', 'Delete'), E('M-Bsp', 'Chop Left'), E('^Del', 'Chop Right'), E('M-T', 'Cut Till End'),
    E('M-J', 'Full Justify'), E('M-D', 'Word Count'), E('M-V', 'Verbatim'), E('M-}', 'Indent'),
    E('M-{', 'Unindent'), E('M-3', 'Comment Lines'), E('^]', 'Complete'),
  ],
  search: [
    E('^G', 'Help'), E('^C', 'Cancel'), E('M-C', 'Case Sens'), E('M-R', 'Reg.exp.'), E('M-B', 'Backwards'),
    E('^R', 'Replace'), E('^P', 'Older'), E('^N', 'Newer'), E('^T', 'Go To Line'),
  ],
  replace: [
    E('^G', 'Help'), E('^C', 'Cancel'), E('M-C', 'Case Sens'), E('M-R', 'Reg.exp.'), E('M-B', 'Backwards'),
    E('^R', 'No Replace'), E('^P', 'Older'), E('^N', 'Newer'),
  ],
  'search-in-help': [E('^C', 'Cancel')],
  'replace-with': [E('^G', 'Help'), E('^C', 'Cancel'), E('^P', 'Older'), E('^N', 'Newer')],
  'write-out': [
    E('^G', 'Help'), E('^C', 'Cancel'), E('M-D', 'DOS Format'), E('M-M', 'Mac Format'), E('M-A', 'Append'),
    E('M-P', 'Prepend'), E('M-B', 'Backup File'), E('^T', 'Browse'), E('^Q', 'Discard buffer'),
  ],
  'read-file': [
    E('^G', 'Help'), E('^C', 'Cancel'), E('M-F', 'New Buffer'), E('M-N', 'No Conversion'),
    E('^X', 'Execute Command'), E('^T', 'Browse'),
  ],
  goto: [
    E('^G', 'Help'), E('^C', 'Cancel'), E('^W', 'Begin of Paragr.'), E('^O', 'End of Paragraph'),
    E('^Y', 'First Line'), E('^V', 'Last Line'), E('^T', 'Go To Text'),
  ],
  execute: [
    E('^G', 'Help'), E('^C', 'Cancel'), E('M-F', 'New Buffer'), E('M-\\', 'Pipe Text'), E('^S', 'Spell Check'),
    E('^Y', 'Linter'), E('^J', 'Full Justify'), E('^O', 'Formatter'), E('^V', 'Cut Till End'), E('^Z', 'Suspend'),
  ],
  help: [
    E('^L', 'Refresh'), E('^X', 'Close'), E('^W', 'Where Is'), E('^Q', 'Where Was'), E('M-Q', 'Previous'),
    E('M-W', 'Next'), E('^P', 'Prev Line'), E('^N', 'Next Line'), E('^Y', 'Prev Page'), E('^V', 'Next Page'),
    E('M-\\', 'First Line'), E('M-/', 'Last Line'),
  ],
};

export interface MenuOptions {
  readonly restricted: boolean;
  readonly discard: boolean;
  readonly view: boolean;
  readonly preserve?: boolean;
}

const PRESERVE_HIDDEN: Readonly<Partial<Record<NanoMenuName, readonly string[]>>> = {
  help: ['Refresh', 'Where Was'],
};

const PRESERVE_REMOVED: Readonly<Partial<Record<NanoMenuName, readonly string[]>>> = {
  main: ['Where Was'],
};

const PRESERVE_REKEYED: Readonly<Partial<Record<NanoMenuName, Readonly<Record<string, string>>>>> = {
  execute: { 'Spell Check': '^T' },
};

const RESTRICTED_HIDDEN: Readonly<Partial<Record<NanoMenuName, readonly string[]>>> = {
  main: ['Execute', 'Justify'],
  'write-out': ['Append', 'Prepend', 'Backup File', 'Browse'],
  'read-file': ['Browse', 'Execute Command', 'New Buffer'],
};

const VIEW_HIDDEN: Readonly<Partial<Record<NanoMenuName, readonly string[]>>> = {
  'write-out': ['Append', 'Prepend', 'Backup File'],
  'read-file': ['Execute Command', 'New Buffer'],
};

export interface MenuLayout {
  readonly entries: readonly MenuEntry[];
  readonly slots: number;
}

const VIEW_UNBOUND_ONLY: Readonly<Partial<Record<NanoMenuName, number>>> = { 'write-out': 3 };

export function menuLayout(menu: NanoMenuName, options: MenuOptions): MenuLayout {
  const viewHidden = options.view ? VIEW_HIDDEN[menu] ?? [] : [];
  const preserveHidden = options.preserve === true ? PRESERVE_HIDDEN[menu] ?? [] : [];
  const preserveRemoved = options.preserve === true ? PRESERVE_REMOVED[menu] ?? [] : [];
  const rekeyed = options.preserve === true ? PRESERVE_REKEYED[menu] ?? {} : {};
  const entries = NANO_MENUS[menu]
    .filter((entry) => (options.discard || entry.tag !== 'Discard buffer') && !viewHidden.includes(entry.tag) && !preserveHidden.includes(entry.tag) && !preserveRemoved.includes(entry.tag))
    .map((entry) => (rekeyed[entry.tag] === undefined ? entry : E(rekeyed[entry.tag], entry.tag)));
  const unboundSlots = NANO_MENUS[menu].filter((entry) => preserveHidden.includes(entry.tag)).length;
  if (!options.restricted) {
    const unbound = options.view ? VIEW_UNBOUND_ONLY[menu] ?? 0 : 0;
    return { entries, slots: entries.length + unbound + unboundSlots };
  }
  const hidden = RESTRICTED_HIDDEN[menu] ?? [];
  const shown = entries.filter((entry) => !hidden.includes(entry.tag));
  const restricted = menu === 'main' ? shown.map((entry) => (entry.tag === 'Read File' ? E('^J', 'Justify') : entry)) : shown;
  return { entries: restricted, slots: restricted.length + unboundSlots };
}

export function shownEntryCount(cols: number, slots: number): number {
  return Math.min(slots, Math.floor((cols + 40) / 20) * 2);
}
