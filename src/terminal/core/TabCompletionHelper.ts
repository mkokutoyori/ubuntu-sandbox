/**
 * TabCompletionHelper — Shared logic for tab completion across all
 * terminal session types (Linux, Windows, Cisco/Huawei).
 *
 * Extracts the common "find longest common prefix / show suggestions"
 * algorithm that was previously duplicated in three session classes.
 */

export interface TabResult {
  /** Updated input string (may include the completed portion). */
  input: string;
  /** Suggestions to display, or null if completion was unambiguous. */
  suggestions: string[] | null;
}

/**
 * Compute tab completion from a list of candidates.
 *
 * @param currentInput  The full input string (e.g. "ls /ho")
 * @param candidates    Matching completions for the last word (e.g. ["home"])
 * @param maxSuggestions  Maximum suggestions to show (avoids flooding)
 * @returns Updated input and optional suggestions to display.
 */
export function completeInput(
  currentInput: string,
  candidates: string[],
  maxSuggestions: number = 30,
): TabResult {
  if (candidates.length === 0) {
    return { input: currentInput, suggestions: null };
  }

  const parts = currentInput.trimStart().split(/\s+/);
  const word = parts[parts.length - 1] || '';

  if (candidates.length === 1) {
    const completed = candidates[0];
    if (parts.length <= 1) {
      return { input: completed + ' ', suggestions: null };
    }
    parts[parts.length - 1] = completed;
    return { input: parts.slice(0, -1).join(' ') + ' ' + completed, suggestions: null };
  }

  // Multiple candidates — find longest common prefix
  const commonPrefix = longestCommonPrefix(candidates);

  if (commonPrefix.length > word.length) {
    // Extend the input to the common prefix
    if (parts.length <= 1) {
      return { input: commonPrefix, suggestions: null };
    }
    parts[parts.length - 1] = commonPrefix;
    return { input: parts.slice(0, -1).join(' ') + ' ' + commonPrefix, suggestions: null };
  }

  // No further prefix — show suggestions
  return {
    input: currentInput,
    suggestions: candidates.slice(0, maxSuggestions),
  };
}

/**
 * Find the longest common prefix of a list of strings.
 * Case-sensitive comparison.
 */
function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

/**
 * Case-insensitive variant for Windows PowerShell tab completion.
 */
export function completeInputCaseInsensitive(
  currentInput: string,
  candidates: string[],
  maxSuggestions: number = 30,
): TabResult {
  if (candidates.length === 0) {
    return { input: currentInput, suggestions: null };
  }

  const parts = currentInput.trimStart().split(/\s+/);
  const word = parts[parts.length - 1] || '';

  if (candidates.length === 1) {
    const completed = candidates[0];
    if (parts.length <= 1) {
      return { input: completed + ' ', suggestions: null };
    }
    parts[parts.length - 1] = completed;
    return { input: parts.slice(0, -1).join(' ') + ' ' + completed, suggestions: null };
  }

  // Multiple candidates — find longest common prefix (case-insensitive)
  const commonPrefix = longestCommonPrefixCI(candidates);

  if (commonPrefix.length > word.length) {
    if (parts.length <= 1) {
      return { input: commonPrefix, suggestions: null };
    }
    parts[parts.length - 1] = commonPrefix;
    return { input: parts.slice(0, -1).join(' ') + ' ' + commonPrefix, suggestions: null };
  }

  return {
    input: currentInput,
    suggestions: candidates.slice(0, maxSuggestions),
  };
}

/** Case-insensitive longest common prefix. */
function longestCommonPrefixCI(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (prefix && !strings[i].toLowerCase().startsWith(prefix.toLowerCase())) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) return '';
  }
  return prefix;
}
