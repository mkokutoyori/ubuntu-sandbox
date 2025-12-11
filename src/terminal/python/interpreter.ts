/**
 * Python Interpreter - Évaluation de l'AST
 */

import {
  ASTNode, PyValue, PyInt, PyFloat, PyStr, PyBool, PyNone, PyList, PyTuple, PyDict, PySet,
  PyFunction, PyClass, PyInstance, PyRange,
  pyInt, pyFloat, pyStr, pyBool, pyNone, pyList, pyTuple, pyDict, pySet, pyRange,
  pyRepr, pyStr_value, pyTruthy, pyEqual, pyValueToString,
  FunctionParam, NumberLiteral, StringLiteral, BoolLiteral, NoneLiteral, Identifier,
  BinaryOp, UnaryOp, Compare, BoolOp, Assignment, AugmentedAssignment, MultipleAssignment,
  ListExpr, TupleExpr, DictExpr, SetExpr, Subscript, Slice, Attribute, Call,
  IfStatement, WhileStatement, ForStatement, FunctionDef, ClassDef,
  Return, TryExcept, Raise, Assert, Delete, ListComp, DictComp, SetComp,
  Lambda, IfExpr, Global, Nonlocal, ExprStatement
} from './types';

import { Scope, Environment, createClosure } from './scope';
import {
  PyError, NameError, TypeError, ValueError, IndexError, KeyError,
  ZeroDivisionError, AttributeError, StopIteration, AssertionError,
  BreakException, ContinueException, ReturnException, RecursionError
} from './errors';

// Built-in functions
import { getBuiltins } from './builtins';

const MAX_RECURSION_DEPTH = 1000;

export class Interpreter {
  private env: Environment;
  private recursionDepth: number = 0;
  private modules: Map<string, PyValue> = new Map();

  constructor(env?: Environment) {
    this.env = env || new Environment();
    this.initBuiltins();
  }

  private initBuiltins(): void {
    const builtins = getBuiltins(this);

    for (const [name, value] of Object.entries(builtins)) {
      this.env.scope.set(name, value);
    }
  }

  // Execute a list of statements
  execute(statements: ASTNode[]): PyValue {
    let result: PyValue = pyNone();

    for (const stmt of statements) {
      result = this.evaluate(stmt);
    }

    return result;
  }

  // Evaluate a single node
  evaluate(node: ASTNode): PyValue {
    switch (node.type) {
      case 'NumberLiteral':
        return this.evalNumber(node);
      case 'StringLiteral':
        return this.evalString(node);
      case 'BoolLiteral':
        return pyBool(node.value);
      case 'NoneLiteral':
        return pyNone();
      case 'Identifier':
        return this.evalIdentifier(node);
      case 'BinaryOp':
        return this.evalBinaryOp(node);
      case 'UnaryOp':
        return this.evalUnaryOp(node);
      case 'Compare':
        return this.evalCompare(node);
      case 'BoolOp':
        return this.evalBoolOp(node);
      case 'Assignment':
        return this.evalAssignment(node);
      case 'AugmentedAssignment':
        return this.evalAugmentedAssignment(node);
      case 'MultipleAssignment':
        return this.evalMultipleAssignment(node);
      case 'ListExpr':
        return this.evalList(node);
      case 'TupleExpr':
        return this.evalTuple(node);
      case 'DictExpr':
        return this.evalDict(node);
      case 'SetExpr':
        return this.evalSet(node);
      case 'Subscript':
        return this.evalSubscript(node);
      case 'Attribute':
        return this.evalAttribute(node);
      case 'Call':
        return this.evalCall(node);
      case 'IfExpr':
        return this.evalIfExpr(node);
      case 'IfStatement':
        return this.evalIfStatement(node);
      case 'WhileStatement':
        return this.evalWhile(node);
      case 'ForStatement':
        return this.evalFor(node);
      case 'FunctionDef':
        return this.evalFunctionDef(node);
      case 'ClassDef':
        return this.evalClassDef(node);
      case 'Return':
        return this.evalReturn(node);
      case 'Break':
        throw new BreakException();
      case 'Continue':
        throw new ContinueException();
      case 'Pass':
        return pyNone();
      case 'TryExcept':
        return this.evalTryExcept(node);
      case 'Raise':
        return this.evalRaise(node);
      case 'Assert':
        return this.evalAssert(node);
      case 'Delete':
        return this.evalDelete(node);
      case 'ListComp':
        return this.evalListComp(node);
      case 'DictComp':
        return this.evalDictComp(node);
      case 'SetComp':
        return this.evalSetComp(node);
      case 'Lambda':
        return this.evalLambda(node);
      case 'Global':
        return this.evalGlobal(node);
      case 'Nonlocal':
        return this.evalNonlocal(node);
      case 'ExprStatement':
        return this.evaluate(node.expr);
      case 'Import':
        return this.evalImport(node);
      case 'ImportFrom':
        return this.evalImportFrom(node);
      default:
        throw new TypeError(`Unknown node type: ${(node as any).type}`);
    }
  }

  // === Literal Evaluation ===

  private evalNumber(node: NumberLiteral): PyInt | PyFloat {
    if (node.isFloat) {
      return pyFloat(node.value);
    }
    return pyInt(node.value);
  }

  private evalString(node: StringLiteral): PyStr {
    if (node.isFormatted) {
      return this.evalFString(node.value);
    }
    return pyStr(node.value);
  }

  private evalFString(template: string): PyStr {
    // Parse f-string expressions like {expr}
    let result = '';
    let i = 0;

    while (i < template.length) {
      if (template[i] === '{') {
        if (template[i + 1] === '{') {
          result += '{';
          i += 2;
          continue;
        }

        // Find matching }
        let depth = 1;
        let j = i + 1;
        while (j < template.length && depth > 0) {
          if (template[j] === '{') depth++;
          else if (template[j] === '}') depth--;
          j++;
        }

        const expr = template.slice(i + 1, j - 1);
        // Parse and evaluate expression
        const { Lexer } = require('./lexer');
        const { Parser } = require('./parser');

        try {
          const tokens = new Lexer(expr).tokenize();
          const parser = new Parser(tokens);
          const ast = parser.parseSingle();
          if (ast) {
            const value = this.evaluate(ast);
            result += pyStr_value(value);
          }
        } catch (e) {
          result += `{${expr}}`;
        }

        i = j;
      } else if (template[i] === '}') {
        if (template[i + 1] === '}') {
          result += '}';
          i += 2;
          continue;
        }
        result += template[i];
        i++;
      } else {
        result += template[i];
        i++;
      }
    }

    return pyStr(result);
  }

  private evalIdentifier(node: Identifier): PyValue {
    const value = this.env.scope.get(node.name);
    if (value === undefined) {
      throw new NameError(node.name);
    }
    return value;
  }

  // === Operators ===

  private evalBinaryOp(node: BinaryOp): PyValue {
    const left = this.evaluate(node.left);
    const right = this.evaluate(node.right);

    switch (node.operator) {
      case '+':
        return this.add(left, right);
      case '-':
        return this.subtract(left, right);
      case '*':
        return this.multiply(left, right);
      case '/':
        return this.divide(left, right);
      case '//':
        return this.floorDivide(left, right);
      case '%':
        return this.modulo(left, right);
      case '**':
        return this.power(left, right);
      default:
        throw new TypeError(`Unknown operator: ${node.operator}`);
    }
  }

  private add(left: PyValue, right: PyValue): PyValue {
    // Numbers
    if ((left.type === 'int' || left.type === 'float') &&
        (right.type === 'int' || right.type === 'float')) {
      const result = left.value + right.value;
      return left.type === 'float' || right.type === 'float' ? pyFloat(result) : pyInt(result);
    }

    // Strings
    if (left.type === 'str' && right.type === 'str') {
      return pyStr(left.value + right.value);
    }

    // Lists
    if (left.type === 'list' && right.type === 'list') {
      return pyList([...left.items, ...right.items]);
    }

    // Tuples
    if (left.type === 'tuple' && right.type === 'tuple') {
      return pyTuple([...left.items, ...right.items]);
    }

    throw new TypeError(`unsupported operand type(s) for +: '${left.type}' and '${right.type}'`);
  }

  private subtract(left: PyValue, right: PyValue): PyValue {
    if ((left.type === 'int' || left.type === 'float') &&
        (right.type === 'int' || right.type === 'float')) {
      const result = left.value - right.value;
      return left.type === 'float' || right.type === 'float' ? pyFloat(result) : pyInt(result);
    }

    // Set difference
    if (left.type === 'set' && right.type === 'set') {
      const result = pySet([]);
      left.items.forEach(item => {
        if (!right.items.has(item)) {
          result.items.add(item);
          result.itemObjects.set(item, left.itemObjects.get(item)!);
        }
      });
      return result;
    }

    throw new TypeError(`unsupported operand type(s) for -: '${left.type}' and '${right.type}'`);
  }

  private multiply(left: PyValue, right: PyValue): PyValue {
    // Numbers
    if ((left.type === 'int' || left.type === 'float') &&
        (right.type === 'int' || right.type === 'float')) {
      const result = left.value * right.value;
      return left.type === 'float' || right.type === 'float' ? pyFloat(result) : pyInt(result);
    }

    // String repetition
    if (left.type === 'str' && right.type === 'int') {
      return pyStr(left.value.repeat(Math.max(0, right.value)));
    }
    if (left.type === 'int' && right.type === 'str') {
      return pyStr(right.value.repeat(Math.max(0, left.value)));
    }

    // List repetition
    if (left.type === 'list' && right.type === 'int') {
      const items: PyValue[] = [];
      for (let i = 0; i < Math.max(0, right.value); i++) {
        items.push(...left.items);
      }
      return pyList(items);
    }

    // Tuple repetition
    if (left.type === 'tuple' && right.type === 'int') {
      const items: PyValue[] = [];
      for (let i = 0; i < Math.max(0, right.value); i++) {
        items.push(...left.items);
      }
      return pyTuple(items);
    }

    throw new TypeError(`unsupported operand type(s) for *: '${left.type}' and '${right.type}'`);
  }

  private divide(left: PyValue, right: PyValue): PyValue {
    if ((left.type === 'int' || left.type === 'float') &&
        (right.type === 'int' || right.type === 'float')) {
      if (right.value === 0) {
        throw new ZeroDivisionError('division by zero');
      }
      return pyFloat(left.value / right.value);
    }

    throw new TypeError(`unsupported operand type(s) for /: '${left.type}' and '${right.type}'`);
  }

  private floorDivide(left: PyValue, right: PyValue): PyValue {
    if ((left.type === 'int' || left.type === 'float') &&
        (right.type === 'int' || right.type === 'float')) {
      if (right.value === 0) {
        throw new ZeroDivisionError('integer division or modulo by zero');
      }
      const result = Math.floor(left.value / right.value);
      return left.type === 'float' || right.type === 'float' ? pyFloat(result) : pyInt(result);
    }

    throw new TypeError(`unsupported operand type(s) for //: '${left.type}' and '${right.type}'`);
  }

  private modulo(left: PyValue, right: PyValue): PyValue {
    if ((left.type === 'int' || left.type === 'float') &&
        (right.type === 'int' || right.type === 'float')) {
      if (right.value === 0) {
        throw new ZeroDivisionError('integer division or modulo by zero');
      }
      // Python-style modulo (always same sign as divisor)
      const result = ((left.value % right.value) + right.value) % right.value;
      return left.type === 'float' || right.type === 'float' ? pyFloat(result) : pyInt(result);
    }

    // String formatting
    if (left.type === 'str') {
      return this.formatString(left.value, right);
    }

    throw new TypeError(`unsupported operand type(s) for %: '${left.type}' and '${right.type}'`);
  }

  private formatString(format: string, args: PyValue): PyStr {
    // Simple % formatting
    let result = format;
    let argList: PyValue[];

    if (args.type === 'tuple') {
      argList = args.items;
    } else {
      argList = [args];
    }

    let argIndex = 0;
    result = result.replace(/%([sd])/g, (match, spec) => {
      if (argIndex >= argList.length) {
        throw new TypeError('not enough arguments for format string');
      }
      const arg = argList[argIndex++];
      if (spec === 's') {
        return pyStr_value(arg);
      } else if (spec === 'd') {
        if (arg.type !== 'int' && arg.type !== 'float') {
          throw new TypeError('%d format: a number is required');
        }
        return String(Math.floor(arg.value));
      }
      return match;
    });

    return pyStr(result);
  }

  private power(left: PyValue, right: PyValue): PyValue {
    if ((left.type === 'int' || left.type === 'float') &&
        (right.type === 'int' || right.type === 'float')) {
      const result = Math.pow(left.value, right.value);
      if (left.type === 'int' && right.type === 'int' && right.value >= 0) {
        return pyInt(result);
      }
      return pyFloat(result);
    }

    throw new TypeError(`unsupported operand type(s) for **: '${left.type}' and '${right.type}'`);
  }

  private evalUnaryOp(node: UnaryOp): PyValue {
    const operand = this.evaluate(node.operand);

    switch (node.operator) {
      case '-':
        if (operand.type === 'int') return pyInt(-operand.value);
        if (operand.type === 'float') return pyFloat(-operand.value);
        throw new TypeError(`bad operand type for unary -: '${operand.type}'`);

      case '+':
        if (operand.type === 'int') return pyInt(+operand.value);
        if (operand.type === 'float') return pyFloat(+operand.value);
        throw new TypeError(`bad operand type for unary +: '${operand.type}'`);

      case 'not':
        return pyBool(!pyTruthy(operand));

      case '~':
        if (operand.type === 'int') return pyInt(~operand.value);
        throw new TypeError(`bad operand type for unary ~: '${operand.type}'`);

      default:
        throw new TypeError(`Unknown unary operator: ${node.operator}`);
    }
  }

  private evalCompare(node: Compare): PyValue {
    let left = this.evaluate(node.left);

    for (let i = 0; i < node.ops.length; i++) {
      const right = this.evaluate(node.comparators[i]);
      const result = this.compare(left, node.ops[i], right);

      if (!result) {
        return pyBool(false);
      }

      left = right;
    }

    return pyBool(true);
  }

  private compare(left: PyValue, op: string, right: PyValue): boolean {
    switch (op) {
      case '==':
        return pyEqual(left, right);
      case '!=':
        return !pyEqual(left, right);
      case '<':
        return this.compareLess(left, right);
      case '>':
        return this.compareLess(right, left);
      case '<=':
        return this.compareLess(left, right) || pyEqual(left, right);
      case '>=':
        return this.compareLess(right, left) || pyEqual(left, right);
      case 'in':
        return this.contains(right, left);
      case 'not in':
        return !this.contains(right, left);
      case 'is':
        return left === right || (left.type === 'NoneType' && right.type === 'NoneType');
      case 'is not':
        return !(left === right || (left.type === 'NoneType' && right.type === 'NoneType'));
      default:
        throw new TypeError(`Unknown comparison operator: ${op}`);
    }
  }

  private compareLess(left: PyValue, right: PyValue): boolean {
    if ((left.type === 'int' || left.type === 'float') &&
        (right.type === 'int' || right.type === 'float')) {
      return left.value < right.value;
    }

    if (left.type === 'str' && right.type === 'str') {
      return left.value < right.value;
    }

    throw new TypeError(`'<' not supported between instances of '${left.type}' and '${right.type}'`);
  }

  private contains(container: PyValue, item: PyValue): boolean {
    switch (container.type) {
      case 'str':
        if (item.type !== 'str') {
          throw new TypeError("'in <string>' requires string as left operand");
        }
        return container.value.includes(item.value);

      case 'list':
      case 'tuple':
        return container.items.some(i => pyEqual(i, item));

      case 'dict':
        return container.entries.has(pyValueToString(item));

      case 'set':
        return container.items.has(pyValueToString(item));

      case 'range':
        if (item.type !== 'int') return false;
        const { start, stop, step } = container;
        if (step > 0) {
          return item.value >= start && item.value < stop && (item.value - start) % step === 0;
        } else {
          return item.value <= start && item.value > stop && (start - item.value) % (-step) === 0;
        }

      default:
        throw new TypeError(`argument of type '${container.type}' is not iterable`);
    }
  }

  private evalBoolOp(node: BoolOp): PyValue {
    if (node.operator === 'and') {
      let result: PyValue = pyBool(true);
      for (const value of node.values) {
        result = this.evaluate(value);
        if (!pyTruthy(result)) {
          return result;
        }
      }
      return result;
    } else {
      let result: PyValue = pyBool(false);
      for (const value of node.values) {
        result = this.evaluate(value);
        if (pyTruthy(result)) {
          return result;
        }
      }
      return result;
    }
  }

  // === Assignments ===

  private evalAssignment(node: Assignment): PyValue {
    const value = this.evaluate(node.value);
    this.assignTarget(node.target, value);
    return value;
  }

  private evalAugmentedAssignment(node: AugmentedAssignment): PyValue {
    const current = this.evaluate(node.target);
    const operand = this.evaluate(node.value);

    let result: PyValue;

    switch (node.operator) {
      case '+=':
        result = this.add(current, operand);
        break;
      case '-=':
        result = this.subtract(current, operand);
        break;
      case '*=':
        result = this.multiply(current, operand);
        break;
      case '/=':
        result = this.divide(current, operand);
        break;
      case '//=':
        result = this.floorDivide(current, operand);
        break;
      case '%=':
        result = this.modulo(current, operand);
        break;
      case '**=':
        result = this.power(current, operand);
        break;
      default:
        throw new TypeError(`Unknown augmented assignment: ${node.operator}`);
    }

    this.assignTarget(node.target, result);
    return result;
  }

  private evalMultipleAssignment(node: MultipleAssignment): PyValue {
    const value = this.evaluate(node.value);

    for (const target of node.targets) {
      this.assignTarget(target, value);
    }

    return value;
  }

  private assignTarget(target: ASTNode, value: PyValue): void {
    switch (target.type) {
      case 'Identifier':
        this.env.scope.set(target.name, value);
        break;

      case 'TupleExpr':
      case 'ListExpr':
        this.unpackAssign(target.elements, value);
        break;

      case 'Subscript':
        this.subscriptAssign(target, value);
        break;

      case 'Attribute':
        this.attributeAssign(target, value);
        break;

      default:
        throw new TypeError(`Cannot assign to ${target.type}`);
    }
  }

  private unpackAssign(targets: ASTNode[], value: PyValue): void {
    let items: PyValue[];

    if (value.type === 'list' || value.type === 'tuple') {
      items = value.items;
    } else if (value.type === 'str') {
      items = [...value.value].map(c => pyStr(c));
    } else {
      throw new TypeError(`cannot unpack non-sequence ${value.type}`);
    }

    if (items.length !== targets.length) {
      throw new ValueError(`not enough values to unpack (expected ${targets.length}, got ${items.length})`);
    }

    for (let i = 0; i < targets.length; i++) {
      this.assignTarget(targets[i], items[i]);
    }
  }

  private subscriptAssign(target: Subscript, value: PyValue): void {
    const obj = this.evaluate(target.object);
    const index = this.evaluate(target.index);

    if (obj.type === 'list') {
      if (index.type !== 'int') {
        throw new TypeError('list indices must be integers');
      }
      let idx = index.value;
      if (idx < 0) idx += obj.items.length;
      if (idx < 0 || idx >= obj.items.length) {
        throw new IndexError();
      }
      obj.items[idx] = value;
    } else if (obj.type === 'dict') {
      const key = pyValueToString(index);
      obj.entries.set(key, value);
      obj.keyObjects.set(key, index);
    } else {
      throw new TypeError(`'${obj.type}' object does not support item assignment`);
    }
  }

  private attributeAssign(target: Attribute, value: PyValue): void {
    const obj = this.evaluate(target.object);

    if (obj.type === 'instance') {
      obj.attributes.set(target.attr, value);
    } else if (obj.type === 'class') {
      obj.attributes.set(target.attr, value);
    } else {
      throw new TypeError(`'${obj.type}' object has no attribute '${target.attr}'`);
    }
  }

  // === Collections ===

  private evalList(node: ListExpr): PyList {
    const items = node.elements.map(e => this.evaluate(e));
    return pyList(items);
  }

  private evalTuple(node: TupleExpr): PyTuple {
    const items = node.elements.map(e => this.evaluate(e));
    return pyTuple(items);
  }

  private evalDict(node: DictExpr): PyDict {
    const dict = pyDict();

    for (let i = 0; i < node.keys.length; i++) {
      const keyNode = node.keys[i];
      const valueNode = node.values[i];

      if (keyNode === null) {
        // **spread
        const spread = this.evaluate(valueNode);
        if (spread.type !== 'dict') {
          throw new TypeError('argument after ** must be a mapping');
        }
        spread.entries.forEach((v, k) => {
          dict.entries.set(k, v);
          dict.keyObjects.set(k, spread.keyObjects.get(k)!);
        });
      } else {
        const key = this.evaluate(keyNode);
        const value = this.evaluate(valueNode);
        const keyStr = pyValueToString(key);
        dict.entries.set(keyStr, value);
        dict.keyObjects.set(keyStr, key);
      }
    }

    return dict;
  }

  private evalSet(node: SetExpr): PySet {
    const items = node.elements.map(e => this.evaluate(e));
    return pySet(items);
  }

  private evalSubscript(node: Subscript): PyValue {
    const obj = this.evaluate(node.object);
    const index = this.evaluate(node.index);

    // Slice
    if (index.type === 'Slice' || (node.index.type === 'Slice')) {
      return this.slice(obj, node.index as any);
    }

    return this.getItem(obj, index);
  }

  private getItem(obj: PyValue, index: PyValue): PyValue {
    switch (obj.type) {
      case 'list':
      case 'tuple':
        if (index.type !== 'int') {
          throw new TypeError(`${obj.type} indices must be integers`);
        }
        let idx = index.value;
        if (idx < 0) idx += obj.items.length;
        if (idx < 0 || idx >= obj.items.length) {
          throw new IndexError();
        }
        return obj.items[idx];

      case 'str':
        if (index.type !== 'int') {
          throw new TypeError('string indices must be integers');
        }
        let strIdx = index.value;
        if (strIdx < 0) strIdx += obj.value.length;
        if (strIdx < 0 || strIdx >= obj.value.length) {
          throw new IndexError('string index out of range');
        }
        return pyStr(obj.value[strIdx]);

      case 'dict':
        const key = pyValueToString(index);
        if (!obj.entries.has(key)) {
          throw new KeyError(pyRepr(index));
        }
        return obj.entries.get(key)!;

      default:
        throw new TypeError(`'${obj.type}' object is not subscriptable`);
    }
  }

  private slice(obj: PyValue, sliceNode: Slice): PyValue {
    const lower = sliceNode.lower ? this.evaluate(sliceNode.lower) : null;
    const upper = sliceNode.upper ? this.evaluate(sliceNode.upper) : null;
    const step = sliceNode.step ? this.evaluate(sliceNode.step) : null;

    const start = lower?.type === 'int' ? lower.value : null;
    const stop = upper?.type === 'int' ? upper.value : null;
    const stepVal = step?.type === 'int' ? step.value : 1;

    if (stepVal === 0) {
      throw new ValueError('slice step cannot be zero');
    }

    switch (obj.type) {
      case 'list':
        return pyList(this.sliceArray(obj.items, start, stop, stepVal));
      case 'tuple':
        return pyTuple(this.sliceArray(obj.items, start, stop, stepVal));
      case 'str':
        return pyStr(this.sliceArray([...obj.value], start, stop, stepVal).join(''));
      default:
        throw new TypeError(`'${obj.type}' object is not subscriptable`);
    }
  }

  private sliceArray<T>(arr: T[], start: number | null, stop: number | null, step: number): T[] {
    const len = arr.length;

    // Calculate actual start/stop
    let actualStart: number;
    let actualStop: number;

    if (step > 0) {
      actualStart = start === null ? 0 : (start < 0 ? Math.max(0, len + start) : Math.min(len, start));
      actualStop = stop === null ? len : (stop < 0 ? Math.max(0, len + stop) : Math.min(len, stop));
    } else {
      actualStart = start === null ? len - 1 : (start < 0 ? Math.max(-1, len + start) : Math.min(len - 1, start));
      actualStop = stop === null ? -1 : (stop < 0 ? Math.max(-1, len + stop) : Math.min(len, stop));
    }

    const result: T[] = [];

    if (step > 0) {
      for (let i = actualStart; i < actualStop; i += step) {
        result.push(arr[i]);
      }
    } else {
      for (let i = actualStart; i > actualStop; i += step) {
        result.push(arr[i]);
      }
    }

    return result;
  }

  private evalAttribute(node: Attribute): PyValue {
    const obj = this.evaluate(node.object);
    return this.getAttribute(obj, node.attr);
  }

  getAttribute(obj: PyValue, attr: string): PyValue {
    // Check for built-in methods
    const method = this.getMethod(obj, attr);
    if (method) return method;

    // Instance attributes
    if (obj.type === 'instance') {
      if (obj.attributes.has(attr)) {
        return obj.attributes.get(attr)!;
      }
      // Check class
      if (obj.__class__.methods.has(attr)) {
        const method = obj.__class__.methods.get(attr)!;
        // Bind method to instance
        return {
          ...method,
          closure: new Map([...method.closure, ['self', obj]])
        };
      }
      if (obj.__class__.attributes.has(attr)) {
        return obj.__class__.attributes.get(attr)!;
      }
    }

    // Class attributes
    if (obj.type === 'class') {
      if (obj.methods.has(attr)) {
        return obj.methods.get(attr)!;
      }
      if (obj.attributes.has(attr)) {
        return obj.attributes.get(attr)!;
      }
    }

    // Module attributes
    if (obj.type === 'module') {
      if (obj.exports.has(attr)) {
        return obj.exports.get(attr)!;
      }
    }

    throw new AttributeError(obj.type, attr);
  }

  private getMethod(obj: PyValue, name: string): PyFunction | null {
    // Import string and list methods
    const { getStringMethod, getListMethod, getDictMethod } = require('./builtins/methods');

    switch (obj.type) {
      case 'str':
        return getStringMethod(obj, name, this);
      case 'list':
        return getListMethod(obj, name, this);
      case 'dict':
        return getDictMethod(obj, name, this);
      default:
        return null;
    }
  }

  // === Function Calls ===

  private evalCall(node: Call): PyValue {
    const func = this.evaluate(node.func);
    const args = node.args.map(a => this.evaluate(a));

    // Handle keyword arguments
    const kwargs = new Map<string, PyValue>();
    for (const kw of node.kwargs) {
      kwargs.set(kw.name, this.evaluate(kw.value));
    }

    // Handle *args
    if (node.starArgs) {
      const starArgs = this.evaluate(node.starArgs);
      if (starArgs.type === 'list' || starArgs.type === 'tuple') {
        args.push(...starArgs.items);
      }
    }

    // Handle **kwargs
    if (node.starKwargs) {
      const starKwargs = this.evaluate(node.starKwargs);
      if (starKwargs.type === 'dict') {
        starKwargs.entries.forEach((value, key) => {
          // Remove quotes from string keys
          const cleanKey = key.replace(/^["']|["']$/g, '');
          kwargs.set(cleanKey, value);
        });
      }
    }

    return this.call(func, args, kwargs);
  }

  call(func: PyValue, args: PyValue[], kwargs: Map<string, PyValue> = new Map()): PyValue {
    if (func.type === 'function') {
      return this.callFunction(func, args, kwargs);
    }

    if (func.type === 'class') {
      return this.instantiate(func, args, kwargs);
    }

    throw new TypeError(`'${func.type}' object is not callable`);
  }

  private callFunction(func: PyFunction, args: PyValue[], kwargs: Map<string, PyValue>): PyValue {
    // Built-in function
    if (func.isBuiltin && func.builtinFn) {
      return func.builtinFn(...args);
    }

    // Check recursion depth
    this.recursionDepth++;
    if (this.recursionDepth > MAX_RECURSION_DEPTH) {
      this.recursionDepth = 0;
      throw new RecursionError();
    }

    try {
      // Create new scope
      const childEnv = this.env.createChild();

      // Bind closure
      func.closure.forEach((value, name) => {
        childEnv.scope.set(name, value);
      });

      // Bind arguments
      this.bindArguments(func.params, args, kwargs, childEnv.scope);

      // Execute body
      const oldEnv = this.env;
      this.env = childEnv;

      try {
        for (const stmt of func.body) {
          this.evaluate(stmt);
        }
      } catch (e) {
        if (e instanceof ReturnException) {
          return e.value;
        }
        throw e;
      } finally {
        this.env = oldEnv;
      }

      return pyNone();
    } finally {
      this.recursionDepth--;
    }
  }

  private bindArguments(
    params: FunctionParam[],
    args: PyValue[],
    kwargs: Map<string, PyValue>,
    scope: Scope
  ): void {
    let argIndex = 0;
    let seenKwOnly = false;

    for (const param of params) {
      if (param.isArgs) {
        if (param.name === '*') {
          // Bare * for keyword-only
          seenKwOnly = true;
          continue;
        }
        // *args - collect remaining positional arguments
        scope.set(param.name, pyTuple(args.slice(argIndex)));
        argIndex = args.length;
        seenKwOnly = true;
      } else if (param.isKwargs) {
        // **kwargs - collect remaining keyword arguments
        const remaining = pyDict();
        kwargs.forEach((value, key) => {
          remaining.entries.set(`"${key}"`, value);
          remaining.keyObjects.set(`"${key}"`, pyStr(key));
        });
        scope.set(param.name, remaining);
      } else if (kwargs.has(param.name)) {
        // Keyword argument
        scope.set(param.name, kwargs.get(param.name)!);
        kwargs.delete(param.name);
      } else if (argIndex < args.length && !seenKwOnly) {
        // Positional argument
        scope.set(param.name, args[argIndex++]);
      } else if (param.default !== undefined) {
        // Default value
        scope.set(param.name, param.default as PyValue);
      } else {
        throw new TypeError(`missing required argument: '${param.name}'`);
      }
    }

    // Check for extra arguments
    if (argIndex < args.length) {
      const hasVarArgs = params.some(p => p.isArgs);
      if (!hasVarArgs) {
        throw new TypeError(`takes ${params.length} positional arguments but ${args.length} were given`);
      }
    }
  }

  private instantiate(cls: PyClass, args: PyValue[], kwargs: Map<string, PyValue>): PyInstance {
    const instance: PyInstance = {
      type: 'instance',
      __class__: cls,
      attributes: new Map()
    };

    // Call __init__ if it exists
    if (cls.methods.has('__init__')) {
      const init = cls.methods.get('__init__')!;
      const boundInit: PyFunction = {
        ...init,
        closure: new Map([...init.closure, ['self', instance]])
      };
      this.callFunction(boundInit, args, kwargs);
    }

    return instance;
  }

  // === Control Flow ===

  private evalIfExpr(node: IfExpr): PyValue {
    const test = this.evaluate(node.test);
    if (pyTruthy(test)) {
      return this.evaluate(node.body);
    } else {
      return this.evaluate(node.orelse);
    }
  }

  private evalIfStatement(node: IfStatement): PyValue {
    const test = this.evaluate(node.test);

    if (pyTruthy(test)) {
      for (const stmt of node.body) {
        this.evaluate(stmt);
      }
      return pyNone();
    }

    for (const elif of node.elifs) {
      const elifTest = this.evaluate(elif.test);
      if (pyTruthy(elifTest)) {
        for (const stmt of elif.body) {
          this.evaluate(stmt);
        }
        return pyNone();
      }
    }

    for (const stmt of node.orelse) {
      this.evaluate(stmt);
    }

    return pyNone();
  }

  private evalWhile(node: WhileStatement): PyValue {
    while (pyTruthy(this.evaluate(node.test))) {
      try {
        for (const stmt of node.body) {
          this.evaluate(stmt);
        }
      } catch (e) {
        if (e instanceof BreakException) {
          return pyNone();
        }
        if (e instanceof ContinueException) {
          continue;
        }
        throw e;
      }
    }

    // Execute else clause
    for (const stmt of node.orelse) {
      this.evaluate(stmt);
    }

    return pyNone();
  }

  private evalFor(node: ForStatement): PyValue {
    const iterable = this.evaluate(node.iter);
    const iterator = this.getIterator(iterable);

    let brokeOut = false;

    for (const item of iterator) {
      this.assignTarget(node.target, item);

      try {
        for (const stmt of node.body) {
          this.evaluate(stmt);
        }
      } catch (e) {
        if (e instanceof BreakException) {
          brokeOut = true;
          break;
        }
        if (e instanceof ContinueException) {
          continue;
        }
        throw e;
      }
    }

    // Execute else clause if didn't break
    if (!brokeOut) {
      for (const stmt of node.orelse) {
        this.evaluate(stmt);
      }
    }

    return pyNone();
  }

  *getIterator(obj: PyValue): Generator<PyValue> {
    switch (obj.type) {
      case 'list':
      case 'tuple':
        yield* obj.items;
        break;

      case 'str':
        for (const char of obj.value) {
          yield pyStr(char);
        }
        break;

      case 'dict':
        for (const [keyStr, keyObj] of obj.keyObjects) {
          yield keyObj;
        }
        break;

      case 'set':
        for (const [, itemObj] of obj.itemObjects) {
          yield itemObj;
        }
        break;

      case 'range':
        const { start, stop, step } = obj;
        if (step > 0) {
          for (let i = start; i < stop; i += step) {
            yield pyInt(i);
          }
        } else {
          for (let i = start; i > stop; i += step) {
            yield pyInt(i);
          }
        }
        break;

      default:
        throw new TypeError(`'${obj.type}' object is not iterable`);
    }
  }

  // === Functions and Classes ===

  private evalFunctionDef(node: FunctionDef): PyValue {
    const func: PyFunction = {
      type: 'function',
      name: node.name,
      params: node.params,
      body: node.body,
      closure: createClosure(this.env.scope)
    };

    // Handle decorators
    let result: PyValue = func;
    for (const decorator of [...node.decorators].reverse()) {
      const decoratorFn = this.evaluate(decorator);
      result = this.call(decoratorFn, [result]);
    }

    this.env.scope.set(node.name, result);
    return pyNone();
  }

  private evalClassDef(node: ClassDef): PyValue {
    const bases: PyClass[] = [];
    for (const base of node.bases) {
      const baseClass = this.evaluate(base);
      if (baseClass.type !== 'class') {
        throw new TypeError('bases must be classes');
      }
      bases.push(baseClass);
    }

    const cls: PyClass = {
      type: 'class',
      name: node.name,
      bases,
      methods: new Map(),
      attributes: new Map()
    };

    // Create class scope
    const classEnv = this.env.createChild();
    const oldEnv = this.env;
    this.env = classEnv;

    try {
      for (const stmt of node.body) {
        this.evaluate(stmt);
      }
    } finally {
      this.env = oldEnv;
    }

    // Collect class members
    classEnv.scope.getLocals().forEach((value, name) => {
      if (value.type === 'function') {
        cls.methods.set(name, value);
      } else {
        cls.attributes.set(name, value);
      }
    });

    // Handle decorators
    let result: PyValue = cls;
    for (const decorator of [...node.decorators].reverse()) {
      const decoratorFn = this.evaluate(decorator);
      result = this.call(decoratorFn, [result]);
    }

    this.env.scope.set(node.name, result);
    return pyNone();
  }

  private evalLambda(node: Lambda): PyFunction {
    return {
      type: 'function',
      name: '<lambda>',
      params: node.params,
      body: [{ type: 'Return', value: node.body } as Return],
      closure: createClosure(this.env.scope)
    };
  }

  private evalReturn(node: Return): PyValue {
    const value = node.value ? this.evaluate(node.value) : pyNone();
    throw new ReturnException(value);
  }

  // === Exception Handling ===

  private evalTryExcept(node: TryExcept): PyValue {
    try {
      for (const stmt of node.body) {
        this.evaluate(stmt);
      }

      // Execute else clause
      for (const stmt of node.orelse) {
        this.evaluate(stmt);
      }
    } catch (e) {
      if (e instanceof PyError) {
        // Find matching handler
        for (const handler of node.handlers) {
          if (this.matchesException(e, handler)) {
            if (handler.name) {
              this.env.scope.set(handler.name, pyStr(e.message));
            }

            for (const stmt of handler.body) {
              this.evaluate(stmt);
            }

            // Execute finally
            for (const stmt of node.finalbody) {
              this.evaluate(stmt);
            }

            return pyNone();
          }
        }

        // No matching handler, re-throw
        throw e;
      }

      // Control flow exceptions pass through
      if (e instanceof BreakException || e instanceof ContinueException || e instanceof ReturnException) {
        // Execute finally
        for (const stmt of node.finalbody) {
          this.evaluate(stmt);
        }
        throw e;
      }

      throw e;
    }

    // Execute finally
    for (const stmt of node.finalbody) {
      this.evaluate(stmt);
    }

    return pyNone();
  }

  private matchesException(error: PyError, handler: any): boolean {
    if (!handler.exceptionType) {
      return true; // Bare except
    }

    const exceptionType = this.evaluate(handler.exceptionType);

    // Simple type name matching
    if (exceptionType.type === 'class') {
      return error.pythonType === exceptionType.name;
    }

    // Identifier (built-in exception name)
    if (handler.exceptionType.type === 'Identifier') {
      return error.pythonType === handler.exceptionType.name;
    }

    return false;
  }

  private evalRaise(node: Raise): PyValue {
    if (!node.exception) {
      throw new PyError('RuntimeError', 'No active exception to re-raise');
    }

    const exception = this.evaluate(node.exception);

    if (exception.type === 'str') {
      throw new PyError('Exception', exception.value);
    }

    throw new PyError('Exception', pyStr_value(exception));
  }

  private evalAssert(node: Assert): PyValue {
    const test = this.evaluate(node.test);

    if (!pyTruthy(test)) {
      const msg = node.msg ? pyStr_value(this.evaluate(node.msg)) : '';
      throw new AssertionError(msg);
    }

    return pyNone();
  }

  private evalDelete(node: Delete): PyValue {
    for (const target of node.targets) {
      if (target.type === 'Identifier') {
        this.env.scope.delete(target.name);
      } else if (target.type === 'Subscript') {
        const obj = this.evaluate(target.object);
        const index = this.evaluate(target.index);

        if (obj.type === 'list') {
          if (index.type !== 'int') {
            throw new TypeError('list indices must be integers');
          }
          let idx = index.value;
          if (idx < 0) idx += obj.items.length;
          if (idx < 0 || idx >= obj.items.length) {
            throw new IndexError();
          }
          obj.items.splice(idx, 1);
        } else if (obj.type === 'dict') {
          const key = pyValueToString(index);
          if (!obj.entries.has(key)) {
            throw new KeyError(pyRepr(index));
          }
          obj.entries.delete(key);
          obj.keyObjects.delete(key);
        }
      }
    }

    return pyNone();
  }

  // === Comprehensions ===

  private evalListComp(node: ListComp): PyList {
    const items: PyValue[] = [];
    this.evalComprehension(node.generators, () => {
      items.push(this.evaluate(node.element));
    });
    return pyList(items);
  }

  private evalDictComp(node: DictComp): PyDict {
    const dict = pyDict();
    this.evalComprehension(node.generators, () => {
      const key = this.evaluate(node.key);
      const value = this.evaluate(node.value);
      const keyStr = pyValueToString(key);
      dict.entries.set(keyStr, value);
      dict.keyObjects.set(keyStr, key);
    });
    return dict;
  }

  private evalSetComp(node: SetComp): PySet {
    const set = pySet();
    this.evalComprehension(node.generators, () => {
      const item = this.evaluate(node.element);
      const itemStr = pyValueToString(item);
      set.items.add(itemStr);
      set.itemObjects.set(itemStr, item);
    });
    return set;
  }

  private evalComprehension(
    generators: any[],
    callback: () => void,
    index: number = 0
  ): void {
    if (index >= generators.length) {
      callback();
      return;
    }

    const gen = generators[index];
    const iterable = this.evaluate(gen.iter);

    for (const item of this.getIterator(iterable)) {
      this.assignTarget(gen.target, item);

      // Check conditions
      let passesAll = true;
      for (const condition of gen.ifs) {
        if (!pyTruthy(this.evaluate(condition))) {
          passesAll = false;
          break;
        }
      }

      if (passesAll) {
        this.evalComprehension(generators, callback, index + 1);
      }
    }
  }

  // === Global/Nonlocal ===

  private evalGlobal(node: Global): PyValue {
    for (const name of node.names) {
      this.env.scope.declareGlobal(name);
    }
    return pyNone();
  }

  private evalNonlocal(node: Nonlocal): PyValue {
    for (const name of node.names) {
      this.env.scope.declareNonlocal(name);
    }
    return pyNone();
  }

  // === Imports ===

  private evalImport(node: any): PyValue {
    const { getModule } = require('./modules');

    for (const { name, alias } of node.names) {
      const module = getModule(name, this);
      this.env.scope.set(alias || name, module);
    }

    return pyNone();
  }

  private evalImportFrom(node: any): PyValue {
    const { getModule } = require('./modules');

    const module = getModule(node.module, this);

    if (module.type !== 'module') {
      throw new TypeError(`cannot import from ${module.type}`);
    }

    for (const { name, alias } of node.names) {
      if (name === '*') {
        module.exports.forEach((value, exportName) => {
          this.env.scope.set(exportName, value);
        });
      } else {
        if (!module.exports.has(name)) {
          throw new NameError(name);
        }
        this.env.scope.set(alias || name, module.exports.get(name)!);
      }
    }

    return pyNone();
  }

  // Public methods
  getEnvironment(): Environment {
    return this.env;
  }

  print(...values: string[]): void {
    this.env.print(...values);
  }

  getOutput(): string {
    return this.env.getOutput();
  }

  clearOutput(): void {
    this.env.clearOutput();
  }
}
