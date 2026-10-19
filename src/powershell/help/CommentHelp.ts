export interface CommentHelp {
  synopsis: string;
  description: string;
  notes: string;
  links: string[];
  examples: string[];
  inputs: string[];
  outputs: string[];
  component: string;
  role: string;
  functionality: string;
  parameters: Map<string, string>;
  forwardTarget?: string;
  forwardCategory?: string;
  remoteRunspace?: string;
  externalHelp?: string;
}

const DIRECTIVE = /^\s*\.(\w+)(\s+(\S.*))?\s*$/;
const BLANK = /^\s*$/;
const ARGUMENT_DIRECTIVES = new Set(['PARAMETER', 'FORWARDHELPTARGETNAME', 'FORWARDHELPCATEGORY', 'REMOTEHELPRUNSPACE', 'EXTERNALHELP']);
const SECTION_DIRECTIVES = new Set(['SYNOPSIS', 'DESCRIPTION', 'NOTES', 'LINK', 'EXAMPLE', 'INPUTS', 'OUTPUTS', 'COMPONENT', 'ROLE', 'FUNCTIONALITY']);
const INDENT = /[ \t\u00a0]/;

function sectionText(lines: string[], from: number): { text: string; last: number } {
  let capturing = false;
  let strip = 0;
  const kept: string[] = [];
  let index = from + 1;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!capturing && BLANK.test(line)) continue;
    if (DIRECTIVE.test(line)) break;
    if (!capturing) {
      while (strip < line.length && INDENT.test(line[strip])) strip++;
    }
    capturing = true;
    let start = 0;
    while (start < line.length && start < strip && INDENT.test(line[start])) start++;
    kept.push(line.slice(start));
  }
  return { text: kept.join('\n'), last: index - 1 };
}

export function commentLines(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<#')) {
    const end = trimmed.lastIndexOf('#>');
    return trimmed.slice(2, end < 0 ? undefined : end).split(/\r?\n/);
  }
  return trimmed.split(/\r?\n/).map(line => line.replace(/^\s*#+/, ''));
}

export function parseCommentHelp(raw: string): CommentHelp | null {
  const lines = commentLines(raw);
  const help: CommentHelp = {
    synopsis: '', description: '', notes: '', links: [], examples: [], inputs: [], outputs: [],
    component: '', role: '', functionality: '', parameters: new Map(),
  };
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const match = DIRECTIVE.exec(lines[i]);
    if (match === null) {
      if (!BLANK.test(lines[i])) return null;
      continue;
    }
    found = true;
    const keyword = match[1].toUpperCase();
    const argument = match[3];
    if (argument !== undefined) {
      if (!ARGUMENT_DIRECTIVES.has(keyword)) return null;
      if (keyword === 'PARAMETER') {
        const section = sectionText(lines, i);
        i = section.last;
        const key = argument.trim().toUpperCase();
        if (!help.parameters.has(key)) help.parameters.set(key, section.text.trim());
      } else if (keyword === 'FORWARDHELPTARGETNAME') help.forwardTarget = argument.trim();
      else if (keyword === 'FORWARDHELPCATEGORY') help.forwardCategory = argument.trim();
      else if (keyword === 'REMOTEHELPRUNSPACE') help.remoteRunspace = argument.trim();
      else help.externalHelp = argument.trim();
      continue;
    }
    if (!SECTION_DIRECTIVES.has(keyword)) return null;
    const section = sectionText(lines, i);
    i = section.last;
    const text = section.text.trim();
    switch (keyword) {
      case 'SYNOPSIS': help.synopsis = text; break;
      case 'DESCRIPTION': help.description = text; break;
      case 'NOTES': help.notes = text; break;
      case 'LINK': help.links.push(text); break;
      case 'EXAMPLE': help.examples.push(text); break;
      case 'INPUTS': help.inputs.push(text); break;
      case 'OUTPUTS': help.outputs.push(text); break;
      case 'COMPONENT': help.component = text; break;
      case 'ROLE': help.role = text; break;
      case 'FUNCTIONALITY': help.functionality = text; break;
      default: break;
    }
  }
  return found ? help : null;
}

function blocksBackwards(lines: string[], from: number): string | null {
  let index = from;
  const last = lines[index]?.trim() ?? '';
  if (last.endsWith('#>')) {
    let start = index;
    while (start >= 0 && !lines[start].includes('<#')) start--;
    return start < 0 ? null : lines.slice(start, index + 1).join('\n');
  }
  if (last.startsWith('#')) {
    let start = index;
    while (start > 0 && lines[start - 1].trim().startsWith('#') && !lines[start - 1].trim().endsWith('#>')) start--;
    return lines.slice(start, index + 1).join('\n');
  }
  return null;
}

export function commentBlockBefore(code: string, offset: number): string | null {
  const lines = code.slice(0, offset).split('\n');
  if (lines[lines.length - 1].trim() !== '') return null;
  let index = lines.length - 2;
  if (index >= 0 && lines[index].trim() === '') index--;
  if (index < 0) return null;
  return blocksBackwards(lines, index);
}

export function commentBlockInBody(body: string): string | null {
  const text = body.trim();
  if (text.startsWith('<#')) {
    const end = text.indexOf('#>');
    return end < 0 ? null : text.slice(0, end + 2);
  }
  if (text.startsWith('#')) {
    const lines = text.split(/\r?\n/);
    const taken: string[] = [];
    for (const line of lines) {
      if (!line.trim().startsWith('#')) break;
      taken.push(line);
    }
    return taken.join('\n');
  }
  const lines = text.split(/\r?\n/);
  return blocksBackwards(lines, lines.length - 1);
}

export function scriptHeadHelp(code: string): string | null {
  const text = code.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  if (first >= lines.length) return null;
  const head = lines[first].trim();
  let last = first;
  if (head.startsWith('<#')) {
    while (last < lines.length && !lines[last].includes('#>')) last++;
  } else if (head.startsWith('#')) {
    while (last + 1 < lines.length && lines[last + 1].trim().startsWith('#')) last++;
  } else {
    return null;
  }
  let next = last + 1;
  let blanks = 0;
  while (next < lines.length && lines[next].trim() === '') { next++; blanks++; }
  const adjacentFunction = next < lines.length && /^\s*(function|filter)\b/i.test(lines[next]) && blanks <= 1;
  if (adjacentFunction) return null;
  return lines.slice(first, last + 1).join('\n');
}
