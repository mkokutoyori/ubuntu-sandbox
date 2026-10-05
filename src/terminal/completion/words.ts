export interface WordScan {
  readonly quotes: readonly string[];
  readonly breakers: string;
  readonly separators: string;
  readonly escape: string | null;
}

export interface ScannedWords {
  readonly done: readonly string[];
  readonly typing: string;
  readonly typingStart: number;
}

export const SPACE_DELIMITED_WORDS: WordScan = { quotes: [], breakers: '', separators: '', escape: null };

export function scanWords(text: string, scan: WordScan): ScannedWords {
  const done: string[] = [];
  let word = '';
  let wordStart = 0;
  let quote = '';

  const finishWord = (nextStart: number): void => {
    if (word !== '') done.push(word);
    word = '';
    wordStart = nextStart;
  };
  const startElement = (nextStart: number): void => {
    done.length = 0;
    word = '';
    wordStart = nextStart;
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote !== '') {
      word += character;
      if (character === quote) quote = '';
      continue;
    }
    if (scan.escape !== null && character === scan.escape && index + 1 < text.length) {
      const escaped = text[index + 1];
      if (escaped === '\n') {
        finishWord(index + 2);
      } else {
        word += character + escaped;
      }
      index++;
      continue;
    }
    if (character === '\n' || scan.breakers.includes(character)) {
      startElement(index + 1);
    } else if (/\s/.test(character) || scan.separators.includes(character)) {
      finishWord(index + 1);
    } else {
      if (scan.quotes.includes(character)) quote = character;
      word += character;
    }
  }
  return { done, typing: word, typingStart: wordStart };
}
