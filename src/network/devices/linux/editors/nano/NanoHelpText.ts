import { breakLine } from './NanoJustify';

export type HelpMenu = 'main' | 'search' | 'replace' | 'replace-with' | 'goto' | 'write' | 'insert' | 'execute';

export interface HelpContext {
  readonly restricted: boolean;
  readonly preserve: boolean;
  readonly saveonexit: boolean;
  readonly view: boolean;
}

interface HelpEntry {
  readonly keys: readonly string[];
  readonly phrase: string;
  readonly blank: boolean;
}

interface HelpDocument {
  readonly title: string;
  readonly introduction: string;
  readonly entries: readonly HelpEntry[];
  readonly toggles: readonly (HelpEntry | null)[];
}

const entry = (keys: string, phrase: string, blank = false): HelpEntry => ({
  keys: keys === '' ? [] : keys.split(' '),
  phrase,
  blank,
});

const SEARCH_INTRODUCTION = 'Search Command Help Text\n\n '
  + 'Enter the words or characters you would like to search for, and then press Enter.  If there is a match for the text '
  + 'you entered, the screen will be updated to the location of the nearest match for the search string.\n\n The previous '
  + 'search string will be shown in brackets after the search prompt.  Hitting Enter without entering any text will '
  + 'perform the previous search.  If you have selected text with the mark and then search to replace, only matches in '
  + 'the selected text will be replaced.\n\n The following function keys are available in Search mode:\n\n';

const MAIN_INTRODUCTION = 'Main nano help text\n\n '
  + 'The nano editor is designed to emulate the functionality and ease-of-use of the UW Pico text editor.  There are four '
  + 'main sections of the editor.  The top line shows the program version, the current filename being edited, and whether '
  + 'or not the file has been modified.  Next is the main editor window showing the file being edited.  The status line '
  + 'is the third line from the bottom and shows important messages.  The bottom two lines show the most commonly used '
  + 'shortcuts in the editor.\n\n Shortcuts are written as follows: Control-key sequences are notated with a \'^\' and '
  + 'can be entered either by using the Ctrl key or pressing the Esc key twice.  Meta-key sequences are notated with '
  + '\'M-\' and can be entered using either the Alt, Cmd, or Esc key, depending on your keyboard setup.  Also, pressing '
  + 'Esc twice and then typing a three-digit decimal number from 000 to 255 will enter the character with the '
  + 'corresponding value.  The following keystrokes are available in the main editor window.  Alternative keys are '
  + 'shown in parentheses:\n\n';

const GOTO_INTRODUCTION = 'Go To Line Help Text\n\n '
  + 'Enter the line number that you wish to go to and hit Enter.  If there are fewer lines of text than the number you '
  + 'entered, you will be brought to the last line of the file.\n\n The following function keys are available in Go To '
  + 'Line mode:\n\n';

const WRITE_INTRODUCTION = 'Write File Help Text\n\n '
  + 'Type the name that you wish to save the current file as and press Enter to save the file.\n\n If you have selected '
  + 'text with the mark, you will be prompted to save only the selected portion to a separate file.  To reduce the '
  + 'chance of overwriting the current file with just a portion of it, the current filename is not the default in this '
  + 'mode.\n\n The following function keys are available in Write File mode:\n\n';

const INSERT_INTRODUCTION = 'Insert File Help Text\n\n '
  + 'Type in the name of a file to be inserted into the current file buffer at the current cursor location.\n\n If you '
  + 'have compiled nano with multiple file buffer support, and enable multiple file buffers with the -F or --multibuffer '
  + 'command line flags, the Meta-F toggle, or a nanorc file, inserting a file will cause it to be loaded into a '
  + 'separate buffer (use Meta-< and > to switch between file buffers).  If you need another blank buffer, do not enter '
  + 'any filename, or type in a nonexistent filename at the prompt and press Enter.\n\n The following function keys are '
  + 'available in Insert File mode:\n\n';

const EXECUTE_INTRODUCTION = 'Execute Command Help Text\n\n '
  + 'This mode allows you to insert the output of a command run by the shell into the current buffer (or into a new '
  + 'buffer).  If the command is preceded by \'|\' (the pipe symbol), the current contents of the buffer (or marked '
  + 'region) will be piped to the command.  If you just need another blank buffer, do not enter any command.\n\n You can '
  + 'also pick one of four tools, or cut a large piece of the buffer, or put the editor to sleep.\n\n The following '
  + 'function keys are available in Execute Command mode:\n\n';

const HELP_AND_CANCEL: readonly HelpEntry[] = [
  entry('^G (F1)', 'Display this help text'),
  entry('^C', 'Cancel the current function', true),
];

const HISTORY: readonly HelpEntry[] = [
  entry('^P (▴)', 'Recall the previous search/replace string'),
  entry('^N (▾)', 'Recall the next search/replace string', true),
];

const TOGGLES: readonly (HelpEntry | null)[] = [
  entry('M-Z', 'Hidden interface enable/disable'),
  entry('M-X', 'Help mode enable/disable'),
  entry('M-C', 'Constant cursor position display enable/disable'),
  entry('M-S', 'Soft wrapping of overlong lines enable/disable'),
  entry('M-N', 'Line numbering enable/disable'),
  entry('M-P', 'Whitespace display enable/disable'),
  entry('M-Y', 'Color syntax highlighting enable/disable'),
  null,
  entry('M-H', 'Smart home key enable/disable'),
  entry('M-I', 'Auto indent enable/disable'),
  entry('M-K', 'Cut to end enable/disable'),
  entry('M-L', 'Hard wrapping of overlong lines enable/disable'),
  entry('M-O', 'Conversion of typed tabs to spaces enable/disable'),
  entry('M-M', 'Mouse support enable/disable'),
];

function mainEntries(context: HelpContext): readonly HelpEntry[] {
  const unlessPreserved = (keys: string): string => (context.preserve ? '' : keys);
  const entries: HelpEntry[] = [
    entry('^G (F1)', 'Display this help text'),
    entry('^X (F2)', 'Close the current buffer / Exit from nano'),
    entry('^O (F3)', 'Write the current buffer (or the marked region) to disk'),
    context.restricted
      ? entry('^J (F4)', 'Justify the current paragraph', true)
      : entry('^R (Ins)', 'Insert another file into current buffer (or into new buffer)', true),
    entry('^W (F6)', 'Search forward for a string or a regular expression'),
    entry('^\\ (M-R)', 'Replace a string or a regular expression'),
    entry('^K (F9)', 'Cut current line (or marked region) and store it in cutbuffer'),
    entry('^U (F10)', 'Paste the contents of cutbuffer at current cursor position', true),
  ];
  if (!context.restricted) {
    entries.push(entry('^T', 'Execute a function or an external command'));
    entries.push(entry('^J (F4)', 'Justify the current paragraph', true));
  }
  entries.push(
    entry('^C (F11)', 'Display the position of the cursor'),
    entry('^/ (M-G)', 'Go to line and column number', true),
    entry('M-U', 'Undo the last operation'),
    entry('M-E', 'Redo the last undone operation', true),
    entry('M-A (^6)', 'Mark text starting from the cursor position'),
    entry('M-6 (M-^)', 'Copy current line (or marked region) and store it in cutbuffer', true),
    entry('M-]', 'Go to the matching bracket', true),
    entry(unlessPreserved('^Q'), 'Search backward for a string or a regular expression'),
    entry('M-Q', 'Search next occurrence backward'),
    entry('M-W', 'Search next occurrence forward', true),
    entry('^B (◂)', 'Go back one character'),
    entry('^F (▸)', 'Go forward one character'),
    entry('^◂ (M-Space)', 'Go back one word'),
    entry('^▸ (^Space)', 'Go forward one word'),
    entry('^A (Home)', 'Go to beginning of current line'),
    entry('^E (End)', 'Go to end of current line', true),
    entry('^P (▴)', 'Go to previous line'),
    entry('^N (▾)', 'Go to next line'),
    entry('M-▴ (M--)', 'Scroll up one line without moving the cursor textually'),
    entry('M-▾ (M-+)', 'Scroll down one line without moving the cursor textually', true),
    entry('^▴ (M-7)', 'Go to previous block of text'),
    entry('^▾ (M-8)', 'Go to next block of text'),
    entry('M-( (M-9)', 'Go to beginning of paragraph; then of previous paragraph'),
    entry('M-) (M-0)', 'Go just beyond end of paragraph; then of next paragraph', true),
    entry('^Y (PgUp)', 'Go one screenful up'),
    entry('^V (PgDn)', 'Go one screenful down'),
    entry('M-\\ (^Home)', 'Go to the first line of the file'),
    entry('M-/ (^End)', 'Go to the last line of the file', true),
    entry('M-◂ (M-,)', 'Switch to the previous file buffer'),
    entry('M-▸ (M-.)', 'Switch to the next file buffer', true),
    entry('^I (Tab)', 'Insert a tab at the cursor position (or indent marked lines)'),
    entry('^M (Enter)', 'Insert a newline at the cursor position', true),
    entry('^H (Bsp)', 'Delete the character to the left of the cursor'),
    entry('^D (Del)', 'Delete the character under the cursor', true),
    entry('M-Bsp (Sh-^Del)', 'Delete backward from cursor to word start'),
    entry('^Del', 'Delete forward from cursor to next word start'),
    entry('M-T', 'Cut from the cursor position to the end of the file', true),
    entry('M-J', 'Justify the entire file'),
    entry('M-D', 'Count the number of lines, words, and characters'),
    entry('M-V', 'Insert the next keystroke verbatim', true),
    entry('M-}', 'Indent the current line (or marked lines)'),
    entry('M-{ (Sh-Tab)', 'Unindent the current line (or marked lines)', true),
    entry('M-3', 'Comment/uncomment the current line (or marked lines)'),
    entry('^]', 'Try and complete the current word', true),
    entry('M-:', 'Start/stop recording a macro'),
    entry('M-;', 'Run the last recorded macro', true),
    entry('M-Del', 'Throw away the current line (or marked region)', true),
    entry('M-Ins', 'Place or remove an anchor at the current line'),
    entry('M-PgUp', 'Jump backward to the nearest anchor'),
    entry('M-PgDn', 'Jump forward to the nearest anchor', true),
  );
  if (!context.restricted) {
    entries.push(
      entry('F12', 'Invoke the spell checker, if available'),
      entry('M-B', 'Invoke the linter, if available'),
      entry('M-F', 'Invoke a program to format/arrange/manipulate the buffer', true),
    );
  }
  entries.push(
    entry('', 'Suspend the editor (return to the shell)'),
    entry('^L', 'Refresh (redraw) the current screen'),
    entry('^L', 'Center the line where the cursor is', true),
    entry(unlessPreserved('^S'), 'Save file without prompting', true),
  );
  return entries;
}

function searchEntries(replacing: boolean): readonly HelpEntry[] {
  return [
    ...HELP_AND_CANCEL,
    entry('M-C', 'Toggle the case sensitivity of the search'),
    entry('M-R', 'Toggle the use of regular expressions'),
    entry('M-B', 'Reverse the direction of the search', true),
    replacing
      ? entry('^R', 'Search forward for a string or a regular expression', true)
      : entry('^R', 'Replace a string or a regular expression', true),
    ...HISTORY,
    ...(replacing ? [] : [entry('^T (^/)', 'Go to line and column number', true)]),
  ];
}

function writeEntries(context: HelpContext): readonly HelpEntry[] {
  const entries: HelpEntry[] = [
    ...HELP_AND_CANCEL,
    entry('M-D', 'Toggle the use of DOS format'),
    entry('M-M', 'Toggle the use of Mac format'),
  ];
  if (!context.restricted) {
    entries.push(
      entry('M-A', 'Toggle appending'),
      entry('M-P', 'Toggle prepending'),
      entry('M-B', 'Toggle backing up of the original file', true),
      entry('^T', 'Go to file browser', true),
    );
  }
  entries.push(entry(context.saveonexit && !context.preserve ? '^Q' : '', 'Close buffer without saving it', true));
  return entries;
}

function insertEntries(context: HelpContext): readonly HelpEntry[] {
  return [
    ...HELP_AND_CANCEL,
    ...(context.view ? [] : [entry('M-F', 'Toggle the use of a new buffer')]),
    entry('M-N', 'Do not convert from DOS/Mac format', true),
    ...(context.view ? [] : [entry('^X', 'Execute a function or an external command', true)]),
    entry('^T', 'Go to file browser', true),
  ];
}

const executeEntries = (context: HelpContext): readonly HelpEntry[] => [
  ...HELP_AND_CANCEL,
  entry('M-F', 'Toggle the use of a new buffer'),
  entry('M-\\', 'Pipe the current buffer (or marked region) to the command', true),
  entry(context.preserve ? '^T' : '^S (^T)', 'Invoke the spell checker, if available'),
  entry('^Y', 'Invoke the linter, if available', true),
  entry('^J', 'Justify the entire file'),
  entry('^O', 'Invoke a program to format/arrange/manipulate the buffer', true),
  entry('^V', 'Cut from the cursor position to the end of the file', true),
  entry('^Z', 'Suspend the editor (return to the shell)', true),
];

function documentFor(menu: HelpMenu, context: HelpContext): HelpDocument {
  switch (menu) {
    case 'search': return { title: 'Search Command Help Text', introduction: SEARCH_INTRODUCTION, entries: searchEntries(false), toggles: [] };
    case 'replace': return { title: 'Search Command Help Text', introduction: SEARCH_INTRODUCTION, entries: searchEntries(true), toggles: [] };
    case 'replace-with': return { title: 'Search Command Help Text', introduction: SEARCH_INTRODUCTION, entries: [...HELP_AND_CANCEL, ...HISTORY], toggles: [] };
    case 'goto':
      return {
        title: 'Go To Line Help Text',
        introduction: GOTO_INTRODUCTION,
        entries: [
          ...HELP_AND_CANCEL,
          entry('^W', 'Go to beginning of paragraph; then of previous paragraph'),
          entry('^O', 'Go just beyond end of paragraph; then of next paragraph', true),
          entry('^Y', 'Go to the first line of the file'),
          entry('^V', 'Go to the last line of the file', true),
          entry('^T (^/)', 'Search forward for a string or a regular expression', true),
        ],
        toggles: [],
      };
    case 'write': return { title: 'Write File Help Text', introduction: WRITE_INTRODUCTION, entries: writeEntries(context), toggles: [] };
    case 'insert': return { title: 'Insert File Help Text', introduction: INSERT_INTRODUCTION, entries: insertEntries(context), toggles: [] };
    case 'execute': return { title: 'Execute Command Help Text', introduction: EXECUTE_INTRODUCTION, entries: executeEntries(context), toggles: [] };
    default: return { title: 'Main nano help text', introduction: MAIN_INTRODUCTION, entries: mainEntries(context), toggles: TOGGLES };
  }
}

const KEY_COLUMN = 7;
const ALTERNATIVE_COLUMN = 10;

function cells(text: string): number {
  return Array.from(text).length;
}

function entryText(item: HelpEntry): string {
  if (item.keys.length === 0) return `\t\t ${item.phrase}\n`;
  const first = item.keys[0];
  let line = first + ' '.repeat(Math.max(0, KEY_COLUMN - cells(first)));
  if (item.keys.length > 1) {
    line += item.keys[1] + ' '.repeat(Math.max(0, ALTERNATIVE_COLUMN - cells(item.keys[1])));
  } else {
    line += ' '.repeat(ALTERNATIVE_COLUMN);
  }
  return `${line}${item.phrase}\n`;
}

function toggleText(item: HelpEntry): string {
  return `${item.keys[0]}\t\t ${item.phrase}\n`;
}

export interface HelpLayout {
  readonly columns: number;
  readonly rows: number;
  readonly leadingBlank: boolean;
}

export interface HelpPage {
  readonly title: string;
  readonly lines: readonly string[];
}

export function helpPage(menu: HelpMenu, context: HelpContext, layout: HelpLayout): HelpPage {
  const document = documentFor(menu, context);
  let text = document.introduction;
  const endOfIntroduction = text.length;
  for (const item of document.entries) {
    text += entryText(item);
    if (item.blank) text += '\n';
  }
  for (const item of document.toggles) text += item === null ? '\n' : toggleText(item);

  const titleLength = breakLine(text, Number.MAX_SAFE_INTEGER, 8, true);
  let pointer = titleLength;
  while (text[pointer] === '\n') pointer++;
  const lines: string[] = [];
  if (layout.leadingBlank) lines.push(' ');
  let wrappingPoint = Math.min(74, Math.max(40, layout.columns));
  while (pointer < text.length) {
    let line: string;
    let length: number;
    if (pointer === endOfIntroduction) wrappingPoint = Math.max(40, layout.columns);
    if (pointer < endOfIntroduction || text[pointer - 1] === '\n') {
      length = breakLine(text.slice(pointer), wrappingPoint, 8, true);
      const shim = text[pointer + length - 1] === ' ' ? 0 : 1;
      line = text.slice(pointer, pointer + length + shim - 1);
    } else {
      length = breakLine(text.slice(pointer), layout.columns < 40 ? 22 : layout.columns - 18, 8, true);
      line = `\t\t  ${text.slice(pointer, pointer + length)}`;
    }
    lines.push(line);
    pointer += length;
    if (text[pointer] !== '\n') pointer--;
    let created = 0;
    do {
      created++;
      pointer++;
    } while (text[pointer] === '\n');
    for (let extra = 1; extra < created; extra++) lines.push('');
  }
  return { title: text.slice(0, titleLength), lines };
}
