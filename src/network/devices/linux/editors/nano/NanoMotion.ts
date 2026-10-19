import { isBlankChar } from './NanoText';

function isWhiteLine(text: string): boolean {
  for (const character of text) {
    if (!isBlankChar(character) && character !== '\r') return false;
  }
  return true;
}

export function previousBlockLine(lines: readonly string[], from: number): number {
  let line = from;
  let isText = false;
  let seenText = false;
  while (line > 0 && (!seenText || isText)) {
    line--;
    isText = !isWhiteLine(lines[line]);
    seenText = seenText || isText;
  }
  if (!isText && seenText) line++;
  return line;
}

export function nextBlockLine(lines: readonly string[], from: number): number {
  let line = from;
  let isWhite = isWhiteLine(lines[line]);
  let seenWhite = isWhite;
  while (line < lines.length - 1 && (!seenWhite || isWhite)) {
    line++;
    isWhite = isWhiteLine(lines[line]);
    seenWhite = seenWhite || isWhite;
  }
  return line;
}

export interface TextSpot {
  readonly line: number;
  readonly col: number;
}

export type WordTest = (character: string | undefined) => boolean;

export function previousWordSpot(lines: readonly string[], from: TextSpot, isWord: WordTest): TextSpot {
  let line = from.line;
  let col = from.col;
  let seenWord = false;
  let stepForward = false;
  for (;;) {
    if (col === 0) {
      if (line === 0) break;
      line--;
      col = lines[line].length;
    }
    if (col > 0) col--;
    if (isWord(lines[line][col])) {
      seenWord = true;
      if (col === 0) break;
    } else if (seenWord) {
      stepForward = true;
      break;
    }
  }
  return { line, col: stepForward ? col + 1 : col };
}

export function nextWordSpot(lines: readonly string[], from: TextSpot, isWord: WordTest, afterEnds: boolean): TextSpot {
  let line = from.line;
  let col = from.col;
  const startedOnWord = isWord(lines[line][col]);
  let seenSpace = !startedOnWord;
  let seenWord = startedOnWord;
  while (line < lines.length - 1 || col < lines[line].length) {
    if (col >= lines[line].length) {
      line++;
      col = 0;
      seenSpace = true;
    } else {
      col++;
    }
    if (afterEnds) {
      if (isWord(lines[line][col])) seenWord = true;
      else if (seenWord) break;
    } else if (!isWord(lines[line][col])) {
      seenSpace = true;
    } else if (seenSpace) {
      break;
    }
  }
  return { line, col };
}
