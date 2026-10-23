export const MESSAGE_LEVEL = { vacuum: 0, hush: 1, remark: 2, info: 3, notice: 4, ahem: 5, mild: 6, alert: 7 } as const;

const PATTERNS: readonly { readonly level: number; readonly pattern: RegExp }[] = [
  { level: MESSAGE_LEVEL.alert, pattern: /^(Invalid search modifier|Invalid line or column number|Empty search string|Error[ :]|File .* not found|Directory |Path '.*' is not a directory|Can't (read file from outside of|write outside of) |.* is meant to be read-only$|".*" is (a directory|a device file|a FIFO))/ },
  { level: MESSAGE_LEVEL.info, pattern: /^line +\d+\/\d+|^Verbatim Input/ },
  { level: MESSAGE_LEVEL.ahem, pattern: /not found$|^Bad regex|^No current search pattern|^No linter is defined|^No formatter is defined|^Unbindable key|^Too tiny|^Not possible|^Cutbuffer is empty|^Key is invalid in view mode|^Nothing to (undo|redo)|^Selection is empty|^Buffer is empty|^No matching bracket|^Not a bracket|^Unbound key|^This function is disabled in restricted mode/ },
  { level: MESSAGE_LEVEL.remark, pattern: /^(Read \d+ lines?|New File|Wrote \d+ lines?|Search Wrapped|This is the only occurrence|Replaced \d+ occurrences?|Justified (selection|file)|Placed anchor)|(enabled|disabled)$/ },
  { level: MESSAGE_LEVEL.hush, pattern: /^(Mark Set|Mark Unset|Nothing was cut|Copied nothing|Cancelled|Searching\.\.\.|Reading\.\.\.|Writing\.\.\.|Undid |Redid |Justified paragraph|Jumped to anchor|Welcome to nano)/ },
];

export function messageLevel(text: string): number {
  const bare = text.replace(/^\[ (.*) \]$/, '$1');
  if (bare === '') return MESSAGE_LEVEL.vacuum;
  return PATTERNS.find((entry) => entry.pattern.test(bare))?.level ?? MESSAGE_LEVEL.hush;
}
