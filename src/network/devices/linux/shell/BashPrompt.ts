export interface BashPromptParts {
  readonly user: string;
  readonly hostname: string;
  readonly path: string;
  readonly promptChar: '$' | '#';
}

export interface BashPromptState {
  readonly user: string;
  readonly root: boolean;
  readonly hostname: string;
  readonly cwd: string;
  readonly home: string;
}

const BASH_PROMPT = /^([^@\s]+)@([^:\s]+):(.+?)([$#]) ?$/;

export function collapseHome(cwd: string, home: string): string {
  if (cwd === home) return '~';
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export function bashPromptParts(state: BashPromptState): BashPromptParts {
  return {
    user: state.user,
    hostname: state.hostname,
    path: collapseHome(state.cwd, state.home),
    promptChar: state.root ? '#' : '$',
  };
}

export function formatBashPrompt(parts: BashPromptParts): string {
  return `${parts.user}@${parts.hostname}:${parts.path}${parts.promptChar} `;
}

export function parseBashPrompt(text: string): BashPromptParts | null {
  const match = BASH_PROMPT.exec(text);
  if (match === null) return null;
  return { user: match[1], hostname: match[2], path: match[3], promptChar: match[4] as '$' | '#' };
}
