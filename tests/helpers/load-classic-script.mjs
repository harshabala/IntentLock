import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export function createClassicContext(globals = {}) {
  return vm.createContext({
    ...globals,
    URL,
    console,
    setInterval: globals.setInterval || setInterval,
    clearInterval: globals.clearInterval || clearInterval,
  });
}

export async function runClassicScript(scriptUrl, context) {
  const code = await readFile(scriptUrl, 'utf8');
  vm.runInContext(code, context, { filename: fileURLToPath(scriptUrl) });
  return context;
}

export async function loadClassicScript(scriptUrl, globals = {}) {
  return runClassicScript(scriptUrl, createClassicContext(globals));
}
