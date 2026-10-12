export interface MenuEntry {
  readonly key: string;
  readonly tag: string;
}

export type NanoMenuName =
  | 'main' | 'search' | 'replace' | 'replace-with' | 'write-out' | 'read-file' | 'goto' | 'execute' | 'help';

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
  'replace-with': [E('^G', 'Help'), E('^C', 'Cancel'), E('^P', 'Older'), E('^N', 'Newer')],
  'write-out': [
    E('^G', 'Help'), E('^C', 'Cancel'), E('M-D', 'DOS Format'), E('M-M', 'Mac Format'), E('M-A', 'Append'),
    E('M-P', 'Prepend'), E('M-B', 'Backup File'), E('^T', 'Browse'),
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
