import {parse} from '@babel/parser';
import traverseImport, {NodePath} from '@babel/traverse';
import type {
  ArrowFunctionExpression,
  CallExpression,
  FunctionExpression,
  Identifier,
  Node,
  Statement,
  YieldExpression,
} from '@babel/types';
import MagicString from 'magic-string';
import type {Plugin} from 'vite';

// `@babel/traverse` exports as ESM `default` under CJS interop — pick whichever
// shape Node actually hands us at runtime.
const traverse = (traverseImport as unknown as {default?: typeof traverseImport})
  .default ?? traverseImport;

const SUPPORTED_EXTENSIONS = /\.(ts|tsx|js|jsx)(?:$|\?)/;
const SKIP_CALLEE_NAMES = new Set([
  'run',
  'animationGroup',
  '__mc_animationGroup',
]);
const IMPORT_LINE =
  "import {animationGroup as __mc_animationGroup} from '@motion-canvas/core';\n";

export function animationGroupPlugin(): Plugin {
  return {
    name: 'motion-canvas:animation-group',
    enforce: 'pre',
    transform(code, id) {
      if (!SUPPORTED_EXTENSIONS.test(id)) return null;
      if (id.includes('/node_modules/')) return null;
      // Cheap pre-check before parsing.
      if (!code.includes('makeScene2D(')) return null;
      if (code.includes('__mc_animationGroup')) return null;

      let ast;
      try {
        ast = parse(code, {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
          allowReturnOutsideFunction: true,
          errorRecovery: true,
        });
      } catch {
        return null;
      }

      const ms = new MagicString(code);
      let counter = 0;
      let didWrap = false;

      traverse(ast, {
        CallExpression(callPath: NodePath<CallExpression>) {
          const callee = callPath.node.callee;
          if (callee.type !== 'Identifier' || callee.name !== 'makeScene2D') {
            return;
          }
          const arg = callPath.node.arguments[0];
          if (
            !arg ||
            (arg.type !== 'FunctionExpression' &&
              arg.type !== 'ArrowFunctionExpression')
          ) {
            return;
          }

          counter = 0;
          const generator = arg as FunctionExpression | ArrowFunctionExpression;
          if (generator.body.type !== 'BlockStatement') return;

          for (const statement of generator.body.body) {
            wrapStatement(statement);
          }
        },
      });

      function wrapStatement(statement: Statement) {
        if (statement.type === 'ExpressionStatement') {
          const expr = statement.expression;
          if (
            expr.type === 'YieldExpression' &&
            expr.delegate &&
            expr.argument
          ) {
            wrapYield(expr);
          }
          return;
        }
        switch (statement.type) {
          case 'BlockStatement':
            statement.body.forEach(wrapStatement);
            return;
          case 'IfStatement':
            wrapStatement(statement.consequent);
            if (statement.alternate) wrapStatement(statement.alternate);
            return;
          case 'ForStatement':
          case 'ForOfStatement':
          case 'ForInStatement':
          case 'WhileStatement':
          case 'DoWhileStatement':
            wrapStatement(statement.body);
            return;
          case 'LabeledStatement':
            wrapStatement(statement.body);
            return;
          case 'TryStatement':
            wrapStatement(statement.block);
            if (statement.handler) wrapStatement(statement.handler.body);
            if (statement.finalizer) wrapStatement(statement.finalizer);
            return;
          case 'SwitchStatement':
            for (const c of statement.cases) {
              c.consequent.forEach(wrapStatement);
            }
            return;
          default:
            return;
        }
      }

      function wrapYield(yieldNode: YieldExpression) {
        const inner = yieldNode.argument!;
        if (inner.type === 'CallExpression') {
          const innerCallee = inner.callee;
          if (
            innerCallee.type === 'Identifier' &&
            SKIP_CALLEE_NAMES.has((innerCallee as Identifier).name)
          ) {
            return;
          }
        }

        const start = (inner as Node).start;
        const end = (inner as Node).end;
        if (start == null || end == null) return;

        counter++;
        const name = `anim${counter.toString().padStart(4, '0')}`;
        ms.appendLeft(start, `__mc_animationGroup('${name}', () => `);
        ms.appendRight(end, ')');
        didWrap = true;
      }

      if (!didWrap) return null;

      ms.prepend(IMPORT_LINE);
      return {
        code: ms.toString(),
        map: ms.generateMap({hires: true, source: id}),
      };
    },
  };
}
