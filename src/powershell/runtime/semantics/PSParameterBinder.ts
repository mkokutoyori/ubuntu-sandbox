import type { PSAttribute, PSExpression, PSParamDeclaration } from '@/powershell/parser/PSASTNode';
import type { PSValue } from '../PSEnvironment';
import { PSRuntimeError } from '../PSRuntimeError';
import { compileRegex } from './PSRegex';
import { truthiness } from './PSConvert';
import { stripTypeBrackets } from './PSTypes';
import { PSNumber } from './PSNumber';

const BINDING = 'System.Management.Automation.ParameterBindingException';
const VALIDATION = 'System.Management.Automation.ParameterBindingValidationException';
const TRANSFORMATION = 'System.Management.Automation.ParameterBindingArgumentTransformationException';

const COMMON_PARAMETERS = [
  'Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ProgressAction',
  'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable',
];

const COMMON_ALIASES: Readonly<Record<string, string>> = {
  vb: 'Verbose', db: 'Debug', ea: 'ErrorAction', wa: 'WarningAction', infa: 'InformationAction',
  proga: 'ProgressAction', ev: 'ErrorVariable', wv: 'WarningVariable', iv: 'InformationVariable',
  ov: 'OutVariable', ob: 'OutBuffer', pv: 'PipelineVariable', wi: 'WhatIf', cf: 'Confirm',
};

export interface BinderHost {
  evaluate(expression: PSExpression): PSValue;
  cast(value: PSValue, typeName: string): PSValue;
  invokeScript(script: PSValue, argument: PSValue): PSValue;
  equal(left: PSValue, right: PSValue, ignoreCase: boolean): boolean;
  scriptText(script: PSValue): string;
  spell(key: string): string;
}

export interface BindingOptions {
  readonly pipelineParameter: string | null;
  readonly supportsShouldProcess: boolean;
}

export interface BindingOutcome {
  readonly values: Map<string, PSValue>;
  readonly bound: Record<string, PSValue>;
  readonly extra: PSValue[];
  readonly common: Record<string, PSValue>;
  readonly shouldProcess: boolean;
}

interface ParameterModel {
  readonly declaration: PSParamDeclaration;
  readonly name: string;
  readonly aliases: string[];
  readonly typeName: string | null;
  readonly isSwitch: boolean;
  readonly mandatory: boolean;
  readonly position: number | null;
  readonly remaining: boolean;
  readonly customSet: boolean;
}

function flattenValues(value: PSValue): PSValue[] {
  return Array.isArray(value) ? value.flatMap(flattenValues) : [value];
}

function flag(attribute: PSAttribute, name: string, host: BinderHost): boolean {
  const wanted = name.toLowerCase();
  const named = Object.keys(attribute.namedArgs).find(key => key.toLowerCase() === wanted);
  if (named !== undefined) return truthiness(host.evaluate(attribute.namedArgs[named]));
  return attribute.positionalArgs.some(arg => {
    const bare = arg as unknown as { type?: string; name?: string; value?: unknown };
    return (bare.type === 'CommandExpression' && bare.name?.toLowerCase() === wanted)
      || (bare.type === 'LiteralExpression' && typeof bare.value === 'string' && bare.value.toLowerCase() === wanted);
  });
}

function namedValue(attribute: PSAttribute, name: string, host: BinderHost): PSValue | undefined {
  const wanted = name.toLowerCase();
  const key = Object.keys(attribute.namedArgs).find(k => k.toLowerCase() === wanted);
  return key === undefined ? undefined : host.evaluate(attribute.namedArgs[key]);
}

function attributesOf(declaration: PSParamDeclaration, name: string): PSAttribute[] {
  return declaration.attributes.filter(a => a.name.toLowerCase() === name);
}

function modelOf(declaration: PSParamDeclaration, host: BinderHost): ParameterModel {
  const parameterAttributes = attributesOf(declaration, 'parameter');
  const aliases = attributesOf(declaration, 'alias')
    .flatMap(a => a.positionalArgs.flatMap(arg => flattenValues(host.evaluate(arg)).map(String)));
  const typeName = declaration.paramType === null ? null : stripTypeBrackets(declaration.paramType);
  let position: number | null = null;
  for (const attribute of parameterAttributes) {
    const declared = namedValue(attribute, 'Position', host);
    if (declared !== undefined && declared !== null) position = Number(declared);
  }
  return {
    declaration,
    name: declaration.name.varName ?? (declaration.name as { name?: string }).name ?? '',
    aliases,
    typeName,
    isSwitch: typeName !== null && /^(switch|system\.management\.automation\.switchparameter)$/i.test(typeName),
    mandatory: parameterAttributes.some(a => flag(a, 'Mandatory', host)),
    position,
    remaining: parameterAttributes.some(a => flag(a, 'ValueFromRemainingArguments', host)),
    customSet: parameterAttributes.some(a => namedValue(a, 'ParameterSetName', host) !== undefined),
  };
}

export function usesCmdletBinding(declarations: readonly PSParamDeclaration[], blockAttributes: readonly PSAttribute[]): boolean {
  return blockAttributes.some(a => a.name.toLowerCase() === 'cmdletbinding')
    || declarations.some(d => attributesOf(d, 'parameter').length > 0);
}

function bindingError(message: string, type: string = BINDING, errorId?: string): PSRuntimeError {
  const error = new PSRuntimeError(message, type);
  error.errorId = errorId;
  return error;
}

function resolveName(models: ParameterModel[], key: string, advanced: boolean, shouldProcess: boolean, host: BinderHost): ParameterModel | { common: string } {
  const wanted = key.toLowerCase();
  const exact = models.find(m => m.name.toLowerCase() === wanted || m.aliases.some(a => a.toLowerCase() === wanted));
  if (exact !== undefined) return exact;
  const alias = COMMON_ALIASES[wanted];
  if (advanced && alias !== undefined && (shouldProcess || (alias !== 'WhatIf' && alias !== 'Confirm'))) return { common: alias };
  const candidates = models.filter(m => m.name.toLowerCase().startsWith(wanted)
    || m.aliases.some(a => a.toLowerCase().startsWith(wanted)));
  const common = advanced
    ? [...COMMON_PARAMETERS, ...(shouldProcess ? ['WhatIf', 'Confirm'] : [])]
    : [];
  const commonMatches = common.filter(c => c.toLowerCase().startsWith(wanted));
  if (candidates.length === 1 && commonMatches.length === 0) return candidates[0];
  if (candidates.length === 0 && commonMatches.length > 0) {
    const exactCommon = common.find(c => c.toLowerCase() === wanted);
    if (exactCommon !== undefined) return { common: exactCommon };
    if (commonMatches.length === 1) return { common: commonMatches[0] };
  }
  const total = candidates.length + commonMatches.length;
  if (total > 1) {
    const names = [...candidates.map(c => c.name), ...commonMatches].map(n => ` -${n}`).join('');
    throw bindingError(`Parameter cannot be processed because the parameter name '${host.spell(key)}' is ambiguous. Possible matches include:${names}.`, BINDING, 'AmbiguousParameter');
  }
  throw bindingError(`A parameter cannot be found that matches parameter name '${host.spell(key)}'.`, BINDING, 'NamedParameterNotFound');
}

function describeArgument(value: PSValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(describeArgument).join(' ');
  return String(value);
}

function validateElement(
  attribute: PSAttribute, value: PSValue, host: BinderHost,
): string | null {
  const kind = attribute.name.toLowerCase();
  const arguments_ = attribute.positionalArgs.flatMap(arg => flattenValues(host.evaluate(arg)));
  switch (kind) {
    case 'validateset': {
      const ignoreCase = namedValue(attribute, 'IgnoreCase', host);
      const fold = ignoreCase === undefined ? true : truthiness(ignoreCase);
      if (arguments_.some(allowed => host.equal(value, allowed, fold))) return null;
      return `The argument "${describeArgument(value)}" does not belong to the set "${arguments_.map(String).join(',')}" specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again.`;
    }
    case 'validaterange': {
      const shown = describeArgument(value);
      if (arguments_.length === 1 && typeof arguments_[0] === 'string') {
        const number = Number(value);
        switch (arguments_[0].toLowerCase()) {
          case 'positive': return number > 0 ? null : `The argument "${shown}" cannot be validated because its value is not greater than zero.`;
          case 'nonnegative': return number >= 0 ? null : `The argument "${shown}" cannot be validated because its value is not greater than or equal to zero.`;
          case 'negative': return number < 0 ? null : `The argument "${shown}" cannot be validated because its value is not less than zero.`;
          case 'nonpositive': return number <= 0 ? null : `The argument "${shown}" cannot be validated because its value is not less than or equal to zero.`;
        }
      }
      const minimum = arguments_[0];
      const maximum = arguments_[1];
      const number = Number(value);
      if (minimum !== undefined && number < Number(minimum))
        return `The ${shown} argument is less than the minimum allowed range of ${String(minimum)}. Supply an argument that is greater than or equal to ${String(minimum)} and then try the command again.`;
      if (maximum !== undefined && number > Number(maximum))
        return `The ${shown} argument is greater than the maximum allowed range of ${String(maximum)}. Supply an argument that is less than or equal to ${String(maximum)} and then try the command again.`;
      return null;
    }
    case 'validatepattern': {
      const pattern = String(arguments_[0] ?? '');
      const options = namedValue(attribute, 'Options', host);
      const ignoreCase = options === undefined || options === null || /ignorecase/i.test(String(options));
      const regex = compileRegex(pattern, { ignoreCase });
      if (regex.test(String(value))) return null;
      const custom = namedValue(attribute, 'ErrorMessage', host);
      if (custom !== undefined && custom !== null) return String(custom).replace('{0}', describeArgument(value)).replace('{1}', pattern);
      return `The argument "${describeArgument(value)}" does not match the "${pattern}" pattern. Supply an argument that matches "${pattern}" and try the command again.`;
    }
    case 'validatelength': {
      const length = String(value ?? '').length;
      const minimum = Number(arguments_[0] ?? 0);
      const maximum = Number(arguments_[1] ?? Number.MAX_SAFE_INTEGER);
      if (length < minimum)
        return `The character length (${length}) of the argument is too short. Specify an argument with a length that is greater than or equal to "${minimum}", and then try the command again.`;
      if (length > maximum)
        return `The character length (${length}) of the argument is too long. Specify an argument with a length that is shorter than or equal to "${maximum}", and then try the command again.`;
      return null;
    }
    case 'validatenotnullorwhitespace':
      return value === null || value === undefined || String(value).trim() === ''
        ? 'The argument is null, empty, or consists of only white-space characters. Provide an argument that contains non white-space characters, and then try the command again.'
        : null;
    case 'validatescript': {
      const script = host.evaluate(attribute.positionalArgs[0]);
      const outcome = host.invokeScript(script, value);
      if (truthiness(outcome)) return null;
      return `The "${host.scriptText(script)}" validation script for the argument with value "${describeArgument(value)}" did not return a result of True. Determine why the validation script failed, and then try the command again.`;
    }
    default: return null;
  }
}

const ELEMENT_VALIDATORS = new Set(['validateset', 'validaterange', 'validatepattern', 'validatelength', 'validatenotnullorwhitespace', 'validatescript']);

function validate(model: ParameterModel, value: PSValue, host: BinderHost): void {
  const fail = (message: string, errorId = 'ParameterArgumentValidationError'): never => {
    throw bindingError(`Cannot validate argument on parameter '${model.name}'. ${message}`, VALIDATION, errorId);
  };
  for (const attribute of model.declaration.attributes) {
    const kind = attribute.name.toLowerCase();
    if (kind === 'validatenotnull') {
      const hasNull = value === null || value === undefined || (Array.isArray(value) && value.some(v => v === null || v === undefined));
      if (hasNull) fail(Array.isArray(value)
        ? 'The argument has a null value, or an element of the argument collection contains a null value. Provide a collection that does not contain any null values, and then try the command again.'
        : 'The argument is null. Provide a valid value for the argument, and then try running the command again.',
      'ParameterArgumentValidationErrorNullNotAllowed');
    } else if (kind === 'validatenotnullorempty') {
      const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
      const emptyKind = value === null || value === undefined ? 'NullNotAllowed' : value === '' ? 'EmptyStringNotAllowed' : 'EmptyArrayNotAllowed';
      if (empty) fail('The argument is null or empty. Provide an argument that is not null or empty, and then try the command again.', `ParameterArgumentValidationError${emptyKind}`);
      if (Array.isArray(value) && value.some(v => v === null || v === undefined || v === ''))
        fail('The argument is null, empty, or an element of the argument collection contains a null value. Supply a collection that does not contain any null values and then try the command again.', 'ParameterArgumentValidationErrorNullNotAllowed');
    } else if (kind === 'validatecount') {
      const count = Array.isArray(value) ? value.length : 1;
      const minimum = Number(host.evaluate(attribute.positionalArgs[0]));
      const maximum = attribute.positionalArgs[1] === undefined ? minimum : Number(host.evaluate(attribute.positionalArgs[1]));
      if (attribute.positionalArgs.length === 1 && count !== minimum)
        fail(`The parameter requires exactly ${minimum} value(s) - ${count} value(s) were provided.`);
      if (attribute.positionalArgs.length > 1 && (count < minimum || count > maximum))
        fail(`The parameter requires at least ${minimum} value(s) and no more than ${maximum} value(s) - ${count} value(s) were provided.`);
    } else if (ELEMENT_VALIDATORS.has(kind)) {
      const elements = Array.isArray(value) && kind !== 'validatescript' ? value : [value];
      for (const element of elements) {
        const message = validateElement(attribute, element, host);
        if (message !== null) fail(message);
      }
    }
  }
}

function coerce(model: ParameterModel, value: PSValue, host: BinderHost): PSValue {
  if (model.isSwitch) return truthiness(value);
  if (model.typeName === null) return value;
  if (value instanceof PSNumber && value.sourceText !== undefined && /^(string|system\.string)$/i.test(model.typeName)) return value.sourceText;
  try {
    return host.cast(value, model.typeName);
  } catch (error) {
    if (error instanceof PSRuntimeError) {
      throw bindingError(`Cannot process argument transformation on parameter '${model.name}'. ${error.message}`, TRANSFORMATION, 'ParameterArgumentTransformationError');
    }
    throw error;
  }
}

function checkNullability(model: ParameterModel, value: PSValue): void {
  if (!model.mandatory) return;
  const allowsNull = attributesOf(model.declaration, 'allownull').length > 0;
  const allowsEmptyString = attributesOf(model.declaration, 'allowemptystring').length > 0;
  const allowsEmptyCollection = attributesOf(model.declaration, 'allowemptycollection').length > 0;
  if ((value === null || value === undefined) && !allowsNull)
    throw bindingError(`Cannot bind argument to parameter '${model.name}' because it is null.`, VALIDATION, 'ParameterArgumentValidationErrorNullNotAllowed');
  if (value === '' && !allowsEmptyString)
    throw bindingError(`Cannot bind argument to parameter '${model.name}' because it is an empty string.`, VALIDATION, 'ParameterArgumentValidationErrorEmptyStringNotAllowed');
  if (Array.isArray(value) && value.length === 0 && !allowsEmptyCollection)
    throw bindingError(`Cannot bind argument to parameter '${model.name}' because it is an empty collection.`, VALIDATION, 'ParameterArgumentValidationErrorEmptyArrayNotAllowed');
}

export interface CmdletBindingInfo {
  readonly advanced: boolean;
  readonly supportsShouldProcess: boolean;
  readonly confirmImpact: string;
  readonly defaultParameterSetName: string | null;
  readonly positionalBinding: boolean;
}

export function cmdletBindingOf(
  declarations: readonly PSParamDeclaration[], blockAttributes: readonly PSAttribute[], host: BinderHost,
): CmdletBindingInfo {
  const attribute = blockAttributes.find(a => a.name.toLowerCase() === 'cmdletbinding');
  const positional = attribute === undefined ? undefined : namedValue(attribute, 'PositionalBinding', host);
  const impact = attribute === undefined ? undefined : namedValue(attribute, 'ConfirmImpact', host);
  const setName = attribute === undefined ? undefined : namedValue(attribute, 'DefaultParameterSetName', host);
  return {
    advanced: usesCmdletBinding(declarations, blockAttributes),
    supportsShouldProcess: attribute !== undefined && flag(attribute, 'SupportsShouldProcess', host),
    confirmImpact: impact === undefined || impact === null ? 'Medium' : String(impact),
    defaultParameterSetName: setName === undefined || setName === null ? null : String(setName),
    positionalBinding: positional === undefined || truthiness(positional),
  };
}

export function bindParameters(
  declarations: readonly PSParamDeclaration[],
  blockAttributes: readonly PSAttribute[],
  named: Record<string, PSValue>,
  positional: readonly PSValue[],
  host: BinderHost,
  options: BindingOptions,
): BindingOutcome {
  const models = declarations.map(d => modelOf(d, host));
  const binding = cmdletBindingOf(declarations, blockAttributes, host);
  const advanced = binding.advanced;
  const automaticPositions = binding.positionalBinding;
  const shouldProcess = binding.supportsShouldProcess;

  const values = new Map<string, PSValue>();
  const bound: Record<string, PSValue> = {};
  const record = (model: ParameterModel, value: PSValue): void => {
    const key = model.name.toLowerCase();
    if (values.has(key)) {
      throw bindingError(`Cannot bind parameter because parameter '${model.name}' is specified more than once. To provide multiple values to parameters that can accept multiple values, use the array syntax. For example, "-parameter value1,value2,value3".`, BINDING, 'ParameterAlreadyBound');
    }
    checkNullability(model, value);
    const coerced = coerce(model, value, host);
    validate(model, coerced, host);
    values.set(key, coerced);
    bound[model.name] = coerced;
  };

  const common: Record<string, PSValue> = {};
  for (const [key, value] of Object.entries(named)) {
    const target = resolveName(models, key, advanced, shouldProcess, host);
    if ('common' in target) {
      const canonical = target.common.toLowerCase();
      if (canonical in common) {
        throw bindingError(`Cannot bind parameter because parameter '${target.common}' is specified more than once. To provide multiple values to parameters that can accept multiple values, use the array syntax. For example, "-parameter value1,value2,value3".`, BINDING, 'ParameterAlreadyBound');
      }
      common[canonical] = value;
    } else {
      record(target, value);
    }
  }

  const hasExplicitPositions = models.some(m => m.position !== null);
  const customSet = models.some(m => m.customSet);
  const positionOf = (model: ParameterModel, index: number): number | null => {
    if (model.position !== null) return model.position;
    if (hasExplicitPositions || customSet || !automaticPositions || model.isSwitch) return null;
    return index;
  };
  let automaticIndex = 0;
  const positionalModels = models
    .map(model => {
      const place = model.position === null && !model.isSwitch ? automaticIndex++ : -1;
      return { model, position: positionOf(model, place) };
    })
    .filter((entry): entry is { model: ParameterModel; position: number } => entry.position !== null)
    .sort((a, b) => a.position - b.position)
    .map(entry => entry.model);

  const queue = [...positional];
  for (const model of positionalModels) {
    if (queue.length === 0) break;
    if (values.has(model.name.toLowerCase())) continue;
    if (model.remaining) {
      record(model, queue.splice(0));
      break;
    }
    record(model, queue.shift() as PSValue);
  }
  const remainingModel = models.find(m => m.remaining && !values.has(m.name.toLowerCase()));
  if (remainingModel !== undefined && queue.length > 0) record(remainingModel, queue.splice(0));

  if (advanced && queue.length > 0) {
    throw bindingError(`A positional parameter cannot be found that accepts argument '${describeArgument(queue[0])}'.`, BINDING, 'PositionalParameterNotFound');
  }

  const missing = models.filter(m => m.mandatory && !values.has(m.name.toLowerCase())
    && options.pipelineParameter?.toLowerCase() !== m.name.toLowerCase());
  if (missing.length > 0) {
    throw bindingError(`Cannot process command because of one or more missing mandatory parameters: ${missing.map(m => m.name).join(', ')}.`, BINDING, 'MissingMandatoryParameter');
  }

  return { values, bound, extra: queue, common, shouldProcess };
}

export function parameterModelsOf(
  declarations: readonly PSParamDeclaration[], host: BinderHost,
): Array<{ name: string; isSwitch: boolean; typeName: string | null }> {
  return declarations.map(d => {
    const model = modelOf(d, host);
    return { name: model.name, isSwitch: model.isSwitch, typeName: model.typeName };
  });
}

export function unboundParameterValue(typeName: string | null): PSValue {
  switch (typeName) {
    case null: return null;
    case 'switch': case 'system.management.automation.switchparameter': return false;
    case 'bool': case 'system.boolean': return false;
    case 'string': case 'system.string': return '';
    case 'int': case 'int32': case 'system.int32': case 'long': case 'int64': case 'system.int64':
    case 'double': case 'system.double': case 'single': case 'float': case 'byte': return 0;
    default: return null;
  }
}
