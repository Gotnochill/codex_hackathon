const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

function computeCyclomatic(code) {
  let complexity = 1;

  try {
    const ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });

    traverse(ast, {
      IfStatement() {
        complexity += 1;
      },
      ForStatement() {
        complexity += 1;
      },
      ForInStatement() {
        complexity += 1;
      },
      ForOfStatement() {
        complexity += 1;
      },
      WhileStatement() {
        complexity += 1;
      },
      DoWhileStatement() {
        complexity += 1;
      },
      SwitchCase() {
        complexity += 1;
      },
      LogicalExpression(pathRef) {
        if (['&&', '||', '??'].includes(pathRef.node.operator)) {
          complexity += 1;
        }
      },
      ConditionalExpression() {
        complexity += 1;
      },
      CatchClause() {
        complexity += 1;
      },
    });
  } catch (_) {
    return 1;
  }

  return complexity;
}

module.exports = { computeCyclomatic };
