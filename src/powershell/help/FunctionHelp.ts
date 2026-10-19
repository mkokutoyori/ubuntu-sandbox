import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { PSAttribute, PSExpression, PSLiteralExpression, PSParamDeclaration, PSScriptBlock } from '@/powershell/parser/PSASTNode';
import { registerPSDisplayFormatter } from '@/powershell/runtime/PSExpansion';
import { commentBlockInBody, parseCommentHelp, type CommentHelp } from './CommentHelp';

export const FUNCTION_HELP_TYPE = 'MamlCommandHelpInfo';

const LINK_URI = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/;

export interface FunctionSignature {
  parameters: Array<{ name: string; isSwitch: boolean; typeName: string | null; mandatory: boolean; position: number | null }>;
  advanced: boolean;
  enumNames(typeName: string): string[] | null;
}

interface ParameterModel {
  name: string;
  typeName: string;
  isSwitch: boolean;
  required: boolean;
  position: string;
  globbing: boolean;
  defaultValue: string | undefined;
  enumNames: string[] | null;
}

function displayType(typeName: string | null): string {
  if (typeName === null) return 'Object';
  const short = typeName.slice(typeName.lastIndexOf('.') + 1);
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function literalText(node: PSExpression | undefined): string | undefined {
  if (node === undefined || node.type !== 'LiteralExpression') return undefined;
  const literal = node as PSLiteralExpression;
  return literal.kind === 'string' || literal.kind === 'expandable' ? String(literal.value) : literal.raw;
}

function namedArgument(attribute: PSAttribute, key: string): PSExpression | undefined {
  const found = Object.keys(attribute.namedArgs).find(candidate => candidate.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : attribute.namedArgs[found];
}

function defaultValueText(declaration: PSParamDeclaration): string | undefined {
  const helpAttribute = declaration.attributes.find(attribute => attribute.name.toLowerCase() === 'psdefaultvalue');
  const help = helpAttribute === undefined ? undefined : literalText(namedArgument(helpAttribute, 'Help'));
  if (help !== undefined) return help;
  return declaration.defaultValue === null ? undefined : literalText(declaration.defaultValue);
}

function parameterModels(block: PSScriptBlock | null, signature: FunctionSignature): ParameterModel[] {
  const declarations = block?.paramBlock?.parameters ?? [];
  let nextPosition = 0;
  return declarations.map((declaration, index) => {
    const described = signature.parameters[index];
    const position = described.isSwitch ? 'named' : String(described.position ?? nextPosition);
    if (!described.isSwitch) nextPosition = (described.position ?? nextPosition) + 1;
    return {
      name: described.name,
      typeName: displayType(described.typeName),
      isSwitch: described.isSwitch,
      required: described.mandatory,
      position,
      globbing: declaration.attributes.some(attribute => attribute.name.toLowerCase() === 'supportswildcards'),
      defaultValue: defaultValueText(declaration),
      enumNames: described.typeName === null ? null : signature.enumNames(described.typeName),
    };
  });
}

function valueText(model: ParameterModel): string {
  return model.enumNames === null ? `<${model.typeName}>` : `{${model.enumNames.join(' | ')}}`;
}

function syntaxFragment(model: ParameterModel): string {
  if (model.isSwitch) return `[-${model.name}]`;
  return model.required ? `[-${model.name}] ${valueText(model)}` : `[[-${model.name}] ${valueText(model)}]`;
}

export function syntaxOf(name: string, block: PSScriptBlock | null, signature: FunctionSignature): string {
  const parts = parameterModels(block, signature).map(syntaxFragment);
  if (signature.advanced) parts.push('[<CommonParameters>]');
  return [name, ...parts].join(' ');
}

function text(value: string): PSValue {
  return { Text: value } as unknown as PSValue;
}

function linkEntry(value: string): PSValue {
  return (LINK_URI.test(value)
    ? { uri: value, linkText: '' }
    : { uri: '', linkText: value }) as unknown as PSValue;
}

function exampleEntry(content: string, index: number): PSValue {
  const defaultPrompt = 'PS > ';
  const promptMatch = /^.*?>/.exec(content);
  const prompt = promptMatch === null ? defaultPrompt : promptMatch[0];
  const rest = promptMatch === null ? content : content.slice(prompt.length);
  const split = /^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(rest);
  const code = (split === null ? rest : split[1]).trim();
  const remarks = split === null ? '' : split[2];
  return {
    title: `-------------------------- EXAMPLE ${index + 1} --------------------------`,
    introduction: [text(prompt)],
    code,
    remarks: [text(remarks), text(''), text(''), text(''), text('')],
  } as unknown as PSValue;
}

export function resolveHelp(block: PSScriptBlock | null, leading: string | null): CommentHelp | null {
  const inside = block?.sourceText === undefined ? null : commentBlockInBody(block.sourceText);
  return (inside === null ? null : parseCommentHelp(inside)) ?? (leading === null ? null : parseCommentHelp(leading));
}

function typedRecord(type: string, fields: Record<string, PSValue>, rendered: string): Record<string, PSValue> {
  Object.defineProperty(fields, '__type', { value: type, enumerable: false });
  Object.defineProperty(fields, '__rendered', { value: rendered, enumerable: false });
  return fields;
}

function parameterValueOf(model: ParameterModel): PSValue {
  return (model.isSwitch ? null : { required: String(model.required), text: model.typeName }) as unknown as PSValue;
}

function valueGroupOf(model: ParameterModel): PSValue {
  return (model.enumNames === null ? null : { parameterValue: model.enumNames }) as unknown as PSValue;
}

export function helpObject(
  name: string, kind: 'Function' | 'ExternalScript', help: CommentHelp | null, block: PSScriptBlock | null, signature: FunctionSignature,
): Record<string, PSValue> {
  const models = parameterModels(block, signature);
  const syntax = syntaxOf(name, block, signature);
  const sections: string[] = [`NAME\n    ${name}`];
  if (help?.synopsis) sections.push(`SYNOPSIS\n    ${help.synopsis}`);
  sections.push(`SYNTAX\n    ${syntax}`);
  if (help?.description) sections.push(`DESCRIPTION\n    ${help.description}`);
  if (help !== null && help.examples.length > 0) sections.push(`EXAMPLES\n    ${help.examples[0]}`);

  const parameters = models.map(model => ({
    name: model.name,
    description: [text(help?.parameters.get(model.name.toUpperCase()) ?? '')],
    type: { name: model.typeName },
    required: String(model.required),
    position: model.position,
    pipelineInput: 'False',
    globbing: String(model.globbing),
    defaultValue: model.defaultValue ?? null,
    parameterValue: model.isSwitch ? 'SwitchParameter' : model.typeName,
    parameterValueGroup: valueGroupOf(model),
  }));
  const syntaxParameters = models.map(model => ({
    name: model.name,
    required: String(model.required),
    position: model.position,
    globbing: String(model.globbing),
    pipelineInput: 'False',
    parameterValue: parameterValueOf(model),
    parameterValueGroup: valueGroupOf(model),
  }));
  const syntaxRecord = typedRecord('MamlSyntaxHelp', {
    syntaxItem: [{ name, parameter: syntaxParameters }] as unknown as PSValue,
  }, syntax);
  const record: Record<string, PSValue> = {
    Name: name,
    Category: kind,
    Synopsis: help === null ? syntax : help.synopsis,
    Description: help?.description ? [text(help.description)] : [],
    alertSet: { alert: help?.notes ? [text(help.notes)] : [] } as unknown as PSValue,
    relatedLinks: { navigationLink: (help?.links ?? []).map(linkEntry) } as unknown as PSValue,
    examples: { example: (help?.examples ?? []).map(exampleEntry) } as unknown as PSValue,
    inputTypes: { inputType: (help?.inputs ?? []).map(value => ({ type: { name: value } })) } as unknown as PSValue,
    returnValues: { returnValue: (help?.outputs ?? []).map(value => ({ type: { name: value } })) } as unknown as PSValue,
    parameters: { parameter: parameters } as unknown as PSValue,
    Component: help?.component ?? '',
    Role: help?.role ?? '',
    Functionality: help?.functionality ?? '',
    Syntax: syntaxRecord as unknown as PSValue,
  };
  return typedRecord(FUNCTION_HELP_TYPE, record, sections.join('\n\n'));
}

export function matchesFilter(actual: string, wanted: string | undefined): boolean {
  if (wanted === undefined || wanted === '') return true;
  const pattern = new RegExp('^' + wanted.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return pattern.test(actual);
}

const renderHidden = (record: PSValue): string => String((record as unknown as { __rendered?: string }).__rendered ?? '');
registerPSDisplayFormatter(FUNCTION_HELP_TYPE, renderHidden);
registerPSDisplayFormatter('MamlSyntaxHelp', renderHidden);
