import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

// Memory may produce advisory rows, but cannot gain a static import path to contract writers.
test('memory source import graph stays inside memory and its data-only dependencies', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const allowed = new Set(['node:crypto', 'node:fs', 'node:path', 'node:util', 'typebox', 'typebox/value']);
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path.endsWith('.ts')) sources.push(path);
    }
  };
  walk(root);
  assert.ok(sources.length > 0);
  for (const path of sources) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const checkSpecifier = (value: string): void => {
      if (allowed.has(value)) return;
      assert.ok(value.startsWith('.'), 'memory imported a dependency outside its data-only boundary');
      const target = relative(root, resolve(dirname(path), value));
      assert.ok(target && target !== '..' && !target.startsWith('../'), 'memory imported another package or contract writer');
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier));
        checkSpecifier(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        assert.ok(node.expression.kind !== ts.SyntaxKind.ImportKeyword, 'dynamic imports cannot evade the boundary');
        assert.ok(!(ts.isIdentifier(node.expression) && node.expression.text === 'require'), 'require cannot evade the boundary');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test('offline evaluator and settle decision module do not import memory', () => {
  for (const module of ['../../contract/src/evaluator.ts', '../../core/src/settle/gate.ts']) {
    const path = fileURLToPath(new URL(module, import.meta.url));
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier));
        assert.ok(!/(?:^@oms\/memory(?:\/|$)|(?:^|\/)memory(?:\/|$))/.test(node.moduleSpecifier.text), 'completion authority imports advisory memory');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
