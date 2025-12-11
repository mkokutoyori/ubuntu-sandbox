/**
 * Python Types - Représentation des types Python en TypeScript
 */

// Types de base pour l'AST
export type PyValue =
  | PyInt
  | PyFloat
  | PyStr
  | PyBool
  | PyNone
  | PyList
  | PyTuple
  | PyDict
  | PySet
  | PyFunction
  | PyClass
  | PyInstance
  | PyRange
  | PyModule;

// Interface de base pour tous les types Python
export interface PyObject {
  type: string;
  __class__?: PyClass;
}

// Entier
export interface PyInt extends PyObject {
  type: 'int';
  value: number;
}

// Nombre décimal
export interface PyFloat extends PyObject {
  type: 'float';
  value: number;
}

// Chaîne de caractères
export interface PyStr extends PyObject {
  type: 'str';
  value: string;
}

// Booléen
export interface PyBool extends PyObject {
  type: 'bool';
  value: boolean;
}

// None
export interface PyNone extends PyObject {
  type: 'NoneType';
  value: null;
}

// Liste (mutable)
export interface PyList extends PyObject {
  type: 'list';
  items: PyValue[];
}

// Tuple (immutable)
export interface PyTuple extends PyObject {
  type: 'tuple';
  items: PyValue[];
}

// Dictionnaire
export interface PyDict extends PyObject {
  type: 'dict';
  entries: Map<string, PyValue>;  // Keys are stringified for simplicity
  keyObjects: Map<string, PyValue>;  // Original key objects
}

// Set
export interface PySet extends PyObject {
  type: 'set';
  items: Set<string>;  // Stringified values
  itemObjects: Map<string, PyValue>;  // Original objects
}

// Range
export interface PyRange extends PyObject {
  type: 'range';
  start: number;
  stop: number;
  step: number;
}

// Fonction
export interface PyFunction extends PyObject {
  type: 'function';
  name: string;
  params: FunctionParam[];
  body: ASTNode[];
  closure: Map<string, PyValue>;
  isBuiltin?: boolean;
  builtinFn?: (...args: PyValue[]) => PyValue;
}

// Paramètre de fonction
export interface FunctionParam {
  name: string;
  default?: PyValue;
  isArgs?: boolean;    // *args
  isKwargs?: boolean;  // **kwargs
}

// Classe
export interface PyClass extends PyObject {
  type: 'class';
  name: string;
  bases: PyClass[];
  methods: Map<string, PyFunction>;
  attributes: Map<string, PyValue>;
}

// Instance de classe
export interface PyInstance extends PyObject {
  type: 'instance';
  __class__: PyClass;
  attributes: Map<string, PyValue>;
}

// Module
export interface PyModule extends PyObject {
  type: 'module';
  name: string;
  exports: Map<string, PyValue>;
}

// === AST Node Types ===

export type ASTNode =
  | NumberLiteral
  | StringLiteral
  | BoolLiteral
  | NoneLiteral
  | Identifier
  | BinaryOp
  | UnaryOp
  | Compare
  | BoolOp
  | Assignment
  | AugmentedAssignment
  | MultipleAssignment
  | ListExpr
  | TupleExpr
  | DictExpr
  | SetExpr
  | Subscript
  | Slice
  | Attribute
  | Call
  | IfExpr
  | IfStatement
  | WhileStatement
  | ForStatement
  | FunctionDef
  | ClassDef
  | Return
  | Break
  | Continue
  | Pass
  | Import
  | ImportFrom
  | TryExcept
  | Raise
  | Assert
  | Delete
  | WithStatement
  | ListComp
  | DictComp
  | SetComp
  | GeneratorExpr
  | Lambda
  | YieldExpr
  | Global
  | Nonlocal
  | ExprStatement;

export interface NumberLiteral {
  type: 'NumberLiteral';
  value: number;
  isFloat: boolean;
}

export interface StringLiteral {
  type: 'StringLiteral';
  value: string;
  isFormatted: boolean;  // f-string
}

export interface BoolLiteral {
  type: 'BoolLiteral';
  value: boolean;
}

export interface NoneLiteral {
  type: 'NoneLiteral';
}

export interface Identifier {
  type: 'Identifier';
  name: string;
}

export interface BinaryOp {
  type: 'BinaryOp';
  operator: '+' | '-' | '*' | '/' | '//' | '%' | '**' | '@';
  left: ASTNode;
  right: ASTNode;
}

export interface UnaryOp {
  type: 'UnaryOp';
  operator: '-' | '+' | 'not' | '~';
  operand: ASTNode;
}

export interface Compare {
  type: 'Compare';
  left: ASTNode;
  ops: ('==' | '!=' | '<' | '>' | '<=' | '>=' | 'in' | 'not in' | 'is' | 'is not')[];
  comparators: ASTNode[];
}

export interface BoolOp {
  type: 'BoolOp';
  operator: 'and' | 'or';
  values: ASTNode[];
}

export interface Assignment {
  type: 'Assignment';
  target: ASTNode;
  value: ASTNode;
}

export interface AugmentedAssignment {
  type: 'AugmentedAssignment';
  operator: '+=' | '-=' | '*=' | '/=' | '//=' | '%=' | '**=' | '&=' | '|=' | '^=' | '>>=' | '<<=';
  target: ASTNode;
  value: ASTNode;
}

export interface MultipleAssignment {
  type: 'MultipleAssignment';
  targets: ASTNode[];
  value: ASTNode;
}

export interface ListExpr {
  type: 'ListExpr';
  elements: ASTNode[];
}

export interface TupleExpr {
  type: 'TupleExpr';
  elements: ASTNode[];
}

export interface DictExpr {
  type: 'DictExpr';
  keys: (ASTNode | null)[];  // null for **spread
  values: ASTNode[];
}

export interface SetExpr {
  type: 'SetExpr';
  elements: ASTNode[];
}

export interface Subscript {
  type: 'Subscript';
  object: ASTNode;
  index: ASTNode;
}

export interface Slice {
  type: 'Slice';
  lower: ASTNode | null;
  upper: ASTNode | null;
  step: ASTNode | null;
}

export interface Attribute {
  type: 'Attribute';
  object: ASTNode;
  attr: string;
}

export interface Call {
  type: 'Call';
  func: ASTNode;
  args: ASTNode[];
  kwargs: { name: string; value: ASTNode }[];
  starArgs?: ASTNode;
  starKwargs?: ASTNode;
}

export interface IfExpr {
  type: 'IfExpr';
  test: ASTNode;
  body: ASTNode;
  orelse: ASTNode;
}

export interface IfStatement {
  type: 'IfStatement';
  test: ASTNode;
  body: ASTNode[];
  elifs: { test: ASTNode; body: ASTNode[] }[];
  orelse: ASTNode[];
}

export interface WhileStatement {
  type: 'WhileStatement';
  test: ASTNode;
  body: ASTNode[];
  orelse: ASTNode[];
}

export interface ForStatement {
  type: 'ForStatement';
  target: ASTNode;
  iter: ASTNode;
  body: ASTNode[];
  orelse: ASTNode[];
}

export interface FunctionDef {
  type: 'FunctionDef';
  name: string;
  params: FunctionParam[];
  body: ASTNode[];
  decorators: ASTNode[];
  returns?: ASTNode;
}

export interface ClassDef {
  type: 'ClassDef';
  name: string;
  bases: ASTNode[];
  body: ASTNode[];
  decorators: ASTNode[];
}

export interface Return {
  type: 'Return';
  value: ASTNode | null;
}

export interface Break {
  type: 'Break';
}

export interface Continue {
  type: 'Continue';
}

export interface Pass {
  type: 'Pass';
}

export interface Import {
  type: 'Import';
  names: { name: string; alias?: string }[];
}

export interface ImportFrom {
  type: 'ImportFrom';
  module: string;
  names: { name: string; alias?: string }[];
}

export interface TryExcept {
  type: 'TryExcept';
  body: ASTNode[];
  handlers: ExceptHandler[];
  orelse: ASTNode[];
  finalbody: ASTNode[];
}

export interface ExceptHandler {
  type: 'ExceptHandler';
  exceptionType: ASTNode | null;
  name: string | null;
  body: ASTNode[];
}

export interface Raise {
  type: 'Raise';
  exception: ASTNode | null;
  cause: ASTNode | null;
}

export interface Assert {
  type: 'Assert';
  test: ASTNode;
  msg: ASTNode | null;
}

export interface Delete {
  type: 'Delete';
  targets: ASTNode[];
}

export interface WithStatement {
  type: 'WithStatement';
  items: { context: ASTNode; optional_vars: ASTNode | null }[];
  body: ASTNode[];
}

export interface ListComp {
  type: 'ListComp';
  element: ASTNode;
  generators: ComprehensionGenerator[];
}

export interface DictComp {
  type: 'DictComp';
  key: ASTNode;
  value: ASTNode;
  generators: ComprehensionGenerator[];
}

export interface SetComp {
  type: 'SetComp';
  element: ASTNode;
  generators: ComprehensionGenerator[];
}

export interface GeneratorExpr {
  type: 'GeneratorExpr';
  element: ASTNode;
  generators: ComprehensionGenerator[];
}

export interface ComprehensionGenerator {
  target: ASTNode;
  iter: ASTNode;
  ifs: ASTNode[];
  isAsync: boolean;
}

export interface Lambda {
  type: 'Lambda';
  params: FunctionParam[];
  body: ASTNode;
}

export interface YieldExpr {
  type: 'YieldExpr';
  value: ASTNode | null;
  isFrom: boolean;
}

export interface Global {
  type: 'Global';
  names: string[];
}

export interface Nonlocal {
  type: 'Nonlocal';
  names: string[];
}

export interface ExprStatement {
  type: 'ExprStatement';
  expr: ASTNode;
}

// === Helper Functions ===

export function pyInt(value: number): PyInt {
  return { type: 'int', value: Math.floor(value) };
}

export function pyFloat(value: number): PyFloat {
  return { type: 'float', value };
}

export function pyStr(value: string): PyStr {
  return { type: 'str', value };
}

export function pyBool(value: boolean): PyBool {
  return { type: 'bool', value };
}

export function pyNone(): PyNone {
  return { type: 'NoneType', value: null };
}

export function pyList(items: PyValue[] = []): PyList {
  return { type: 'list', items };
}

export function pyTuple(items: PyValue[] = []): PyTuple {
  return { type: 'tuple', items };
}

export function pyDict(entries: [PyValue, PyValue][] = []): PyDict {
  const dict: PyDict = {
    type: 'dict',
    entries: new Map(),
    keyObjects: new Map()
  };
  for (const [key, value] of entries) {
    const keyStr = pyValueToString(key);
    dict.entries.set(keyStr, value);
    dict.keyObjects.set(keyStr, key);
  }
  return dict;
}

export function pySet(items: PyValue[] = []): PySet {
  const set: PySet = {
    type: 'set',
    items: new Set(),
    itemObjects: new Map()
  };
  for (const item of items) {
    const itemStr = pyValueToString(item);
    set.items.add(itemStr);
    set.itemObjects.set(itemStr, item);
  }
  return set;
}

export function pyRange(start: number, stop: number, step: number = 1): PyRange {
  return { type: 'range', start, stop, step };
}

// Convert PyValue to string representation (for dict keys and set items)
export function pyValueToString(value: PyValue): string {
  switch (value.type) {
    case 'int':
    case 'float':
      return String(value.value);
    case 'str':
      return `"${value.value}"`;
    case 'bool':
      return value.value ? 'True' : 'False';
    case 'NoneType':
      return 'None';
    case 'tuple':
      return `(${value.items.map(pyValueToString).join(', ')})`;
    default:
      return `<${value.type}>`;
  }
}

// Convert PyValue to repr string (Python repr())
export function pyRepr(value: PyValue): string {
  switch (value.type) {
    case 'int':
    case 'float':
      return String(value.value);
    case 'str':
      return `'${value.value.replace(/'/g, "\\'")}'`;
    case 'bool':
      return value.value ? 'True' : 'False';
    case 'NoneType':
      return 'None';
    case 'list':
      return `[${value.items.map(pyRepr).join(', ')}]`;
    case 'tuple':
      if (value.items.length === 1) {
        return `(${pyRepr(value.items[0])},)`;
      }
      return `(${value.items.map(pyRepr).join(', ')})`;
    case 'dict': {
      const pairs: string[] = [];
      value.entries.forEach((v, k) => {
        const keyObj = value.keyObjects.get(k);
        pairs.push(`${pyRepr(keyObj!)}: ${pyRepr(v)}`);
      });
      return `{${pairs.join(', ')}}`;
    }
    case 'set': {
      if (value.items.size === 0) return 'set()';
      const items: string[] = [];
      value.itemObjects.forEach((obj) => items.push(pyRepr(obj)));
      return `{${items.join(', ')}}`;
    }
    case 'range':
      if (value.step === 1) {
        return `range(${value.start}, ${value.stop})`;
      }
      return `range(${value.start}, ${value.stop}, ${value.step})`;
    case 'function':
      return `<function ${value.name}>`;
    case 'class':
      return `<class '${value.name}'>`;
    case 'instance':
      return `<${value.__class__.name} object>`;
    case 'module':
      return `<module '${value.name}'>`;
    default:
      return `<${(value as PyObject).type}>`;
  }
}

// Convert PyValue to str() string
export function pyStr_value(value: PyValue): string {
  switch (value.type) {
    case 'str':
      return value.value;
    default:
      return pyRepr(value);
  }
}

// Check if value is truthy in Python
export function pyTruthy(value: PyValue): boolean {
  switch (value.type) {
    case 'bool':
      return value.value;
    case 'int':
    case 'float':
      return value.value !== 0;
    case 'str':
      return value.value.length > 0;
    case 'NoneType':
      return false;
    case 'list':
    case 'tuple':
      return value.items.length > 0;
    case 'dict':
      return value.entries.size > 0;
    case 'set':
      return value.items.size > 0;
    default:
      return true;
  }
}

// Check if two PyValues are equal
export function pyEqual(a: PyValue, b: PyValue): boolean {
  if (a.type === 'NoneType' && b.type === 'NoneType') return true;
  if (a.type === 'bool' && b.type === 'bool') return a.value === b.value;
  if ((a.type === 'int' || a.type === 'float') && (b.type === 'int' || b.type === 'float')) {
    return a.value === b.value;
  }
  if (a.type === 'str' && b.type === 'str') return a.value === b.value;
  if (a.type === 'list' && b.type === 'list') {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((item, i) => pyEqual(item, b.items[i]));
  }
  if (a.type === 'tuple' && b.type === 'tuple') {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((item, i) => pyEqual(item, b.items[i]));
  }
  return false;
}
