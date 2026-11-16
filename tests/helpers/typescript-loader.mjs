import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const root = resolve('');

export function typescriptLoader(overrides = {}, transform = text => text) {
  const cache = new Map();
  function load(filename) {
    const absolute = resolve(root, filename);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const localRequire = request => {
      if (Object.hasOwn(overrides, request)) return overrides[request];
      const target = request.startsWith('@/') ? resolve(root, request.slice(2))
        : request.startsWith('.') ? resolve(dirname(absolute), request) : null;
      if (target && existsSync(target + '.ts')) return load(target + '.ts');
      return nativeRequire(target ?? request);
    };
    const source = transform(readFileSync(absolute, 'utf8'), absolute);
    const javascript = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    } }).outputText;
    new Function('require', 'module', 'exports', '__dirname', '__filename', javascript)(
      localRequire, module, module.exports, dirname(absolute), absolute,
    );
    return module.exports;
  }
  return load;
}
