import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';

export interface FunctionRow {
  CommandType: 'Function';
  Name: string;
  Version: string;
  Source: string;
  Definition: string;
  ScriptBlock: PSValue;
}

export function functionRow(ctx: CmdletContext, name: string): FunctionRow {
  const block = ctx.runtime.getFunctionBlock(name);
  const definition = (block as { sourceText?: string } | null)?.sourceText ?? '';
  return { CommandType: 'Function', Name: name, Version: '', Source: '', Definition: definition, ScriptBlock: block };
}
