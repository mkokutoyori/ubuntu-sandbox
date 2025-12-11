// ANSI escape code parser for terminal output
// Converts ANSI color codes to styled React elements

export interface AnsiSegment {
  text: string;
  styles: {
    color?: string;
    fontWeight?: string;
    textDecoration?: string;
    backgroundColor?: string;
  };
}

// ANSI color code to CSS color mapping
const ANSI_COLORS: Record<number, string> = {
  30: '#2e3436', // Black
  31: '#ef2929', // Red
  32: '#4e9a06', // Green
  33: '#c4a000', // Yellow
  34: '#3465a4', // Blue
  35: '#75507b', // Magenta
  36: '#06989a', // Cyan
  37: '#d3d7cf', // White
  90: '#555753', // Bright Black (Gray)
  91: '#ff5555', // Bright Red
  92: '#55ff55', // Bright Green
  93: '#ffff55', // Bright Yellow
  94: '#5555ff', // Bright Blue
  95: '#ff55ff', // Bright Magenta
  96: '#55ffff', // Bright Cyan
  97: '#ffffff', // Bright White
};

const ANSI_BG_COLORS: Record<number, string> = {
  40: '#2e3436', // Black
  41: '#ef2929', // Red
  42: '#4e9a06', // Green
  43: '#c4a000', // Yellow
  44: '#3465a4', // Blue
  45: '#75507b', // Magenta
  46: '#06989a', // Cyan
  47: '#d3d7cf', // White
  100: '#555753', // Bright Black
  101: '#ff5555', // Bright Red
  102: '#55ff55', // Bright Green
  103: '#ffff55', // Bright Yellow
  104: '#5555ff', // Bright Blue
  105: '#ff55ff', // Bright Magenta
  106: '#55ffff', // Bright Cyan
  107: '#ffffff', // Bright White
};

export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  // Match ANSI escape sequences: ESC[ followed by params and ending with 'm'
  const ansiRegex = /\x1b\[([0-9;]*)m/g;

  let lastIndex = 0;
  let currentStyles: AnsiSegment['styles'] = {};
  let match: RegExpExecArray | null;

  while ((match = ansiRegex.exec(text)) !== null) {
    // Add text before this escape sequence
    if (match.index > lastIndex) {
      const textSegment = text.substring(lastIndex, match.index);
      if (textSegment) {
        segments.push({
          text: textSegment,
          styles: { ...currentStyles },
        });
      }
    }

    // Parse the escape sequence parameters
    const params = match[1].split(';').map(p => parseInt(p, 10) || 0);
    currentStyles = applyAnsiParams(params, currentStyles);

    lastIndex = ansiRegex.lastIndex;
  }

  // Add remaining text after last escape sequence
  if (lastIndex < text.length) {
    segments.push({
      text: text.substring(lastIndex),
      styles: { ...currentStyles },
    });
  }

  // If no escape sequences found, return the whole text
  if (segments.length === 0 && text) {
    segments.push({ text, styles: {} });
  }

  return segments;
}

function applyAnsiParams(params: number[], currentStyles: AnsiSegment['styles']): AnsiSegment['styles'] {
  const newStyles = { ...currentStyles };

  for (const param of params) {
    if (param === 0) {
      // Reset all attributes
      return {};
    } else if (param === 1) {
      // Bold
      newStyles.fontWeight = 'bold';
    } else if (param === 4) {
      // Underline
      newStyles.textDecoration = 'underline';
    } else if (param === 22) {
      // Normal intensity (not bold)
      delete newStyles.fontWeight;
    } else if (param === 24) {
      // Not underlined
      delete newStyles.textDecoration;
    } else if (param >= 30 && param <= 37) {
      // Standard foreground colors
      newStyles.color = ANSI_COLORS[param];
    } else if (param >= 90 && param <= 97) {
      // Bright foreground colors
      newStyles.color = ANSI_COLORS[param];
    } else if (param === 39) {
      // Default foreground color
      delete newStyles.color;
    } else if (param >= 40 && param <= 47) {
      // Standard background colors
      newStyles.backgroundColor = ANSI_BG_COLORS[param];
    } else if (param >= 100 && param <= 107) {
      // Bright background colors
      newStyles.backgroundColor = ANSI_BG_COLORS[param];
    } else if (param === 49) {
      // Default background color
      delete newStyles.backgroundColor;
    }
  }

  return newStyles;
}

// Check if text contains ANSI escape codes
export function hasAnsiCodes(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}
