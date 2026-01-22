/**
 * STUB FILE - will be rebuilt with TDD
 * ANSI escape code parser
 */

export interface ParsedSegment {
  text: string;
  styles?: {
    color?: string;
    backgroundColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
  };
}

export function parseAnsi(text: string): ParsedSegment[] {
  // Stub implementation - just return plain text
  return [{ text }];
}
