/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ASTWithSource} from '../expression_parser/ast';
import * as html from '../ml_parser/ast';
import {ParseError, ParseSourceSpan} from '../parse_util';
import {BindingParser} from '../template_parser/binding_parser';

import * as t from './r3_ast';

/** Pattern for the expression in a for loop block. */
const FOR_LOOP_EXPRESSION_PATTERN = /^\s*([0-9A-Za-z_$]*)\s+of\s+(.*)/;

/** Pattern for the tracking expression in a for loop block. */
const FOR_LOOP_TRACK_PATTERN = /^track\s+(.*)/;

/** Pattern for the `as` expression in a conditional block. */
const CONDITIONAL_ALIAS_PATTERN = /^as\s+(.*)/;

/** Pattern used to identify an `else if` block. */
const ELSE_IF_PATTERN = /^else[^\S\r\n]+if/;

/** Pattern used to identify a `let` parameter. */
const FOR_LOOP_LET_PATTERN = /^let\s+(.*)/;

/** Names of variables that are allowed to be used in the `let` expression of a `for` loop. */
const ALLOWED_FOR_LOOP_LET_VARIABLES =
    new Set<keyof t.ForLoopBlockContext>(['$index', '$first', '$last', '$even', '$odd', '$count']);

/**
 * Predicate function that determines if a block with
 * a specific name cam be connected to a `for` block.
 */
export function isConnectedForLoopBlock(name: string): boolean {
  return name === 'empty';
}

/**
 * Predicate function that determines if a block with
 * a specific name cam be connected to an `if` block.
 */
export function isConnectedIfLoopBlock(name: string): boolean {
  return name === 'else' || ELSE_IF_PATTERN.test(name);
}

/** Creates an `if` loop block from an HTML AST node. */
export function createIfBlock(
    ast: html.Block, connectedBlocks: html.Block[], visitor: html.Visitor,
    bindingParser: BindingParser): {node: t.IfBlock|null, errors: ParseError[]} {
  const errors: ParseError[] = validateIfConnectedBlocks(connectedBlocks);
  const branches: t.IfBlockBranch[] = [];

  if (errors.length > 0) {
    return {node: null, errors};
  }

  const mainBlockParams = parseConditionalBlockParameters(ast, errors, bindingParser);

  if (mainBlockParams !== null) {
    branches.push(new t.IfBlockBranch(
        mainBlockParams.expression, html.visitAll(visitor, ast.children, ast.children),
        mainBlockParams.expressionAlias, ast.sourceSpan, ast.startSourceSpan));
  }

  // Assumes that the structure is valid since we validated it above.
  for (const block of connectedBlocks) {
    const children = html.visitAll(visitor, block.children, block.children);

    if (ELSE_IF_PATTERN.test(block.name)) {
      const params = parseConditionalBlockParameters(block, errors, bindingParser);

      if (params !== null) {
        branches.push(new t.IfBlockBranch(
            params.expression, children, params.expressionAlias, block.sourceSpan,
            block.startSourceSpan));
      }
    } else if (block.name === 'else') {
      branches.push(
          new t.IfBlockBranch(null, children, null, block.sourceSpan, block.startSourceSpan));
    }
  }

  return {
    node: new t.IfBlock(branches, ast.sourceSpan, ast.startSourceSpan, ast.endSourceSpan),
    errors,
  };
}

/** Creates a `for` loop block from an HTML AST node. */
export function createForLoop(
    ast: html.Block, connectedBlocks: html.Block[], visitor: html.Visitor,
    bindingParser: BindingParser): {node: t.ForLoopBlock|null, errors: ParseError[]} {
  const errors: ParseError[] = [];
  const params = parseForLoopParameters(ast, errors, bindingParser);
  let node: t.ForLoopBlock|null = null;
  let empty: t.ForLoopBlockEmpty|null = null;

  for (const block of connectedBlocks) {
    if (block.name === 'empty') {
      if (empty !== null) {
        errors.push(new ParseError(block.sourceSpan, '@for loop can only have one @empty block'));
      } else if (block.parameters.length > 0) {
        errors.push(new ParseError(block.sourceSpan, '@empty block cannot have parameters'));
      } else {
        empty = new t.ForLoopBlockEmpty(
            html.visitAll(visitor, block.children, block.children), block.sourceSpan,
            block.startSourceSpan);
      }
    } else {
      errors.push(new ParseError(block.sourceSpan, `Unrecognized @for loop block "${block.name}"`));
    }
  }

  if (params !== null) {
    if (params.trackBy === null) {
      errors.push(new ParseError(ast.sourceSpan, '@for loop must have a "track" expression'));
    } else {
      node = new t.ForLoopBlock(
          params.itemName, params.expression, params.trackBy, params.context,
          html.visitAll(visitor, ast.children, ast.children), empty, ast.sourceSpan,
          ast.startSourceSpan, ast.endSourceSpan);
    }
  }

  return {node, errors};
}

/** Creates a switch block from an HTML AST node. */
export function createSwitchBlock(
    ast: html.Block, visitor: html.Visitor,
    bindingParser: BindingParser): {node: t.SwitchBlock|null, errors: ParseError[]} {
  const errors = validateSwitchBlock(ast);

  if (errors.length > 0) {
    return {node: null, errors};
  }

  const primaryExpression = parseBlockParameterToBinding(ast.parameters[0], bindingParser);
  const cases: t.SwitchBlockCase[] = [];
  let defaultCase: t.SwitchBlockCase|null = null;

  // Here we assume that all the blocks are valid given that we validated them above.
  for (const node of ast.children) {
    if (!(node instanceof html.Block)) {
      continue;
    }

    const expression = node.name === 'case' ?
        parseBlockParameterToBinding(node.parameters[0], bindingParser) :
        null;
    const ast = new t.SwitchBlockCase(
        expression, html.visitAll(visitor, node.children, node.children), node.sourceSpan,
        node.startSourceSpan);

    if (expression === null) {
      defaultCase = ast;
    } else {
      cases.push(ast);
    }
  }

  // Ensure that the default case is last in the array.
  if (defaultCase !== null) {
    cases.push(defaultCase);
  }

  return {
    node: new t.SwitchBlock(
        primaryExpression, cases, ast.sourceSpan, ast.startSourceSpan, ast.endSourceSpan),
    errors
  };
}

/** Parses the parameters of a `for` loop block. */
function parseForLoopParameters(
    block: html.Block, errors: ParseError[], bindingParser: BindingParser) {
  if (block.parameters.length === 0) {
    errors.push(new ParseError(block.sourceSpan, '@for loop does not have an expression'));
    return null;
  }

  const [expressionParam, ...secondaryParams] = block.parameters;
  const match =
      stripOptionalParentheses(expressionParam, errors)?.match(FOR_LOOP_EXPRESSION_PATTERN);

  if (!match || match[2].trim().length === 0) {
    errors.push(new ParseError(
        expressionParam.sourceSpan,
        'Cannot parse expression. @for loop expression must match the pattern "<identifier> of <expression>"'));
    return null;
  }

  const [, itemName, rawExpression] = match;
  const result = {
    itemName: new t.Variable(
        itemName, '$implicit', expressionParam.sourceSpan, expressionParam.sourceSpan),
    trackBy: null as ASTWithSource | null,
    expression: parseBlockParameterToBinding(expressionParam, bindingParser, rawExpression),
    context: {} as t.ForLoopBlockContext,
  };

  for (const param of secondaryParams) {
    const letMatch = param.expression.match(FOR_LOOP_LET_PATTERN);

    if (letMatch !== null) {
      parseLetParameter(param.sourceSpan, letMatch[1], param.sourceSpan, result.context, errors);
      continue;
    }

    const trackMatch = param.expression.match(FOR_LOOP_TRACK_PATTERN);

    if (trackMatch !== null) {
      if (result.trackBy !== null) {
        errors.push(
            new ParseError(param.sourceSpan, '@for loop can only have one "track" expression'));
      } else {
        result.trackBy = parseBlockParameterToBinding(param, bindingParser, trackMatch[1]);
      }
      continue;
    }

    errors.push(
        new ParseError(param.sourceSpan, `Unrecognized @for loop paramater "${param.expression}"`));
  }

  // Fill out any variables that haven't been defined explicitly.
  for (const variableName of ALLOWED_FOR_LOOP_LET_VARIABLES) {
    if (!result.context.hasOwnProperty(variableName)) {
      result.context[variableName] =
          new t.Variable(variableName, variableName, block.startSourceSpan, block.startSourceSpan);
    }
  }

  return result;
}

/** Parses the `let` parameter of a `for` loop block. */
function parseLetParameter(
    sourceSpan: ParseSourceSpan, expression: string, span: ParseSourceSpan,
    context: t.ForLoopBlockContext, errors: ParseError[]): void {
  const parts = expression.split(',');

  for (const part of parts) {
    const expressionParts = part.split('=');
    const name = expressionParts.length === 2 ? expressionParts[0].trim() : '';
    const variableName = (expressionParts.length === 2 ? expressionParts[1].trim() : '') as
        keyof t.ForLoopBlockContext;

    if (name.length === 0 || variableName.length === 0) {
      errors.push(new ParseError(
          sourceSpan,
          `Invalid @for loop "let" parameter. Parameter should match the pattern "<name> = <variable name>"`));
    } else if (!ALLOWED_FOR_LOOP_LET_VARIABLES.has(variableName)) {
      errors.push(new ParseError(
          sourceSpan,
          `Unknown "let" parameter variable "${variableName}". The allowed variables are: ${
              Array.from(ALLOWED_FOR_LOOP_LET_VARIABLES).join(', ')}`));
    } else if (context.hasOwnProperty(variableName)) {
      errors.push(
          new ParseError(sourceSpan, `Duplicate "let" parameter variable "${variableName}"`));
    } else {
      context[variableName] = new t.Variable(name, variableName, span, span);
    }
  }
}

/**
 * Checks that the shape of the blocks connected to an
 * `@if` block is correct. Returns an array of errors.
 */
function validateIfConnectedBlocks(connectedBlocks: html.Block[]): ParseError[] {
  const errors: ParseError[] = [];
  let hasElse = false;

  for (let i = 0; i < connectedBlocks.length; i++) {
    const block = connectedBlocks[i];

    if (block.name === 'else') {
      if (hasElse) {
        errors.push(new ParseError(block.sourceSpan, 'Conditional can only have one @else block'));
      } else if (connectedBlocks.length > 1 && i < connectedBlocks.length - 1) {
        errors.push(
            new ParseError(block.sourceSpan, '@else block must be last inside the conditional'));
      } else if (block.parameters.length > 0) {
        errors.push(new ParseError(block.sourceSpan, '@else block cannot have parameters'));
      }
      hasElse = true;
    } else if (!ELSE_IF_PATTERN.test(block.name)) {
      errors.push(
          new ParseError(block.sourceSpan, `Unrecognized conditional block @${block.name}`));
    }
  }

  return errors;
}

/** Checks that the shape of a `switch` block is valid. Returns an array of errors. */
function validateSwitchBlock(ast: html.Block): ParseError[] {
  const errors: ParseError[] = [];
  let hasDefault = false;

  if (ast.parameters.length !== 1) {
    errors.push(new ParseError(ast.sourceSpan, '@switch block must have exactly one parameter'));
    return errors;
  }

  for (const node of ast.children) {
    // Skip over empty text nodes inside the switch block since they can be used for formatting.
    if (node instanceof html.Text && node.value.trim().length === 0) {
      continue;
    }

    if (!(node instanceof html.Block) || (node.name !== 'case' && node.name !== 'default')) {
      errors.push(new ParseError(
          node.sourceSpan, '@switch block can only contain @case and @default blocks'));
      continue;
    }

    if (node.name === 'default') {
      if (hasDefault) {
        errors.push(
            new ParseError(node.sourceSpan, '@switch block can only have one @default block'));
      } else if (node.parameters.length > 0) {
        errors.push(new ParseError(node.sourceSpan, '@default block cannot have parameters'));
      }
      hasDefault = true;
    } else if (node.name === 'case' && node.parameters.length !== 1) {
      errors.push(new ParseError(node.sourceSpan, '@case block must have exactly one parameter'));
    }
  }

  return errors;
}

/**
 * Parses a block parameter into a binding AST.
 * @param ast Block parameter that should be parsed.
 * @param bindingParser Parser that the expression should be parsed with.
 * @param part Specific part of the expression that should be parsed.
 */
function parseBlockParameterToBinding(
    ast: html.BlockParameter, bindingParser: BindingParser, part?: string): ASTWithSource {
  let start: number;
  let end: number;

  if (typeof part === 'string') {
    // Note: `lastIndexOf` here should be enough to know the start index of the expression,
    // because we know that it'll be at the end of the param. Ideally we could use the `d`
    // flag when matching via regex and get the index from `match.indices`, but it's unclear
    // if we can use it yet since it's a relatively new feature. See:
    // https://github.com/tc39/proposal-regexp-match-indices
    start = Math.max(0, ast.expression.lastIndexOf(part));
    end = start + part.length;
  } else {
    start = 0;
    end = ast.expression.length;
  }

  return bindingParser.parseBinding(
      ast.expression.slice(start, end), false, ast.sourceSpan, ast.sourceSpan.start.offset + start);
}

/** Parses the parameter of a conditional block (`if` or `else if`). */
function parseConditionalBlockParameters(
    block: html.Block, errors: ParseError[], bindingParser: BindingParser) {
  if (block.parameters.length === 0) {
    errors.push(new ParseError(block.sourceSpan, 'Conditional block does not have an expression'));
    return null;
  }

  const expression = parseBlockParameterToBinding(block.parameters[0], bindingParser);
  let expressionAlias: t.Variable|null = null;

  // Start from 1 since we processed the first parameter already.
  for (let i = 1; i < block.parameters.length; i++) {
    const param = block.parameters[i];
    const aliasMatch = param.expression.match(CONDITIONAL_ALIAS_PATTERN);

    // For now conditionals can only have an `as` parameter.
    // We may want to rework this later if we add more.
    if (aliasMatch === null) {
      errors.push(new ParseError(
          param.sourceSpan, `Unrecognized conditional paramater "${param.expression}"`));
    } else if (block.name !== 'if') {
      errors.push(new ParseError(
          param.sourceSpan, '"as" expression is only allowed on the primary @if block'));
    } else if (expressionAlias !== null) {
      errors.push(
          new ParseError(param.sourceSpan, 'Conditional can only have one "as" expression'));
    } else {
      const name = aliasMatch[1].trim();
      expressionAlias = new t.Variable(name, name, param.sourceSpan, param.sourceSpan);
    }
  }

  return {expression, expressionAlias};
}

/** Strips optional parentheses around from a control from expression parameter. */
function stripOptionalParentheses(param: html.BlockParameter, errors: ParseError[]): string|null {
  const expression = param.expression;
  const spaceRegex = /^\s$/;
  let openParens = 0;
  let start = 0;
  let end = expression.length - 1;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];

    if (char === '(') {
      start = i + 1;
      openParens++;
    } else if (spaceRegex.test(char)) {
      continue;
    } else {
      break;
    }
  }

  if (openParens === 0) {
    return expression;
  }

  for (let i = expression.length - 1; i > -1; i--) {
    const char = expression[i];

    if (char === ')') {
      end = i;
      openParens--;
      if (openParens === 0) {
        break;
      }
    } else if (spaceRegex.test(char)) {
      continue;
    } else {
      break;
    }
  }

  if (openParens !== 0) {
    errors.push(new ParseError(param.sourceSpan, 'Unclosed parentheses in expression'));
    return null;
  }

  return expression.slice(start, end);
}
