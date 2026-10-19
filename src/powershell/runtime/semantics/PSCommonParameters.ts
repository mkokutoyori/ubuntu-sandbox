import type { PSValue } from '../PSEnvironment';
import { PSRuntimeError } from '../PSRuntimeError';
import { truthiness } from './PSConvert';
import { ACTION_PREFERENCES, actionPreferenceOf } from './PSStreams';

export interface VariableTarget {
  readonly scope: 'global' | 'script' | 'local' | 'private' | null;
  readonly name: string;
  readonly append: boolean;
}

export function parseVariableTarget(raw: PSValue): VariableTarget {
  let text = String(raw ?? '').trim();
  const append = text.startsWith('+');
  if (append) text = text.slice(1);
  const match = /^(global|script|local|private):(.+)$/i.exec(text);
  if (match === null) return { scope: null, name: text, append };
  return { scope: match[1].toLowerCase() as VariableTarget['scope'], name: match[2], append };
}

const BINDING_TRANSFORMATION = 'System.Management.Automation.ParameterBindingArgumentTransformationException';

function actionPreference(parameter: string, value: PSValue): string {
  const found = actionPreferenceOf(value, true);
  if (found === null || found === 'Suspend') {
    const shown = String(value ?? '');
    const names = ACTION_PREFERENCES.join(', ');
    const error = new PSRuntimeError(
      `Cannot process argument transformation on parameter '${parameter}'. Cannot convert value "${shown}" to type "System.Management.Automation.ActionPreference". Error: "Unable to match the identifier name ${shown} to a valid enumerator name. Specify one of the following enumerator names and try again:\n${names}"`,
      BINDING_TRANSFORMATION);
    error.errorId = 'ParameterBindingFailed';
    throw error;
  }
  return found;
}

export function preferenceAssignments(common: Record<string, PSValue>): Array<[string, PSValue]> {
  const assignments: Array<[string, PSValue]> = [];
  if ('verbose' in common) assignments.push(['VerbosePreference', truthiness(common.verbose) ? 'Continue' : 'SilentlyContinue']);
  if ('debug' in common) assignments.push(['DebugPreference', truthiness(common.debug) ? 'Continue' : 'SilentlyContinue']);
  if ('erroraction' in common) assignments.push(['ErrorActionPreference', actionPreference('ErrorAction', common.erroraction)]);
  if ('warningaction' in common) assignments.push(['WarningPreference', actionPreference('WarningAction', common.warningaction)]);
  if ('informationaction' in common) assignments.push(['InformationPreference', actionPreference('InformationAction', common.informationaction)]);
  if ('progressaction' in common) assignments.push(['ProgressPreference', actionPreference('ProgressAction', common.progressaction)]);
  if ('whatif' in common) assignments.push(['WhatIfPreference', truthiness(common.whatif)]);
  if ('confirm' in common) assignments.push(['ConfirmPreference', truthiness(common.confirm) ? 'Low' : 'None']);
  return assignments;
}

const COMMON_KEYS = new Set([
  'verbose', 'debug', 'erroraction', 'warningaction', 'informationaction', 'progressaction',
  'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable',
]);

export function takeCommonParameters(named: Record<string, PSValue>): {
  readonly common: Record<string, PSValue>;
  readonly rest: Record<string, PSValue>;
} {
  const common: Record<string, PSValue> = {};
  const rest: Record<string, PSValue> = {};
  for (const [key, value] of Object.entries(named)) {
    if (COMMON_KEYS.has(key)) common[key] = value;
    else rest[key] = value;
  }
  return { common, rest };
}
