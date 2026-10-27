// Lets the tests import `src/main/*.ts` while the sources keep their
// `.js`-suffixed relative specifiers (the ones tsc emits and Node needs after
// a build). A specifier that names a missing `.js` file but has a `.ts`
// sibling is resolved to that sibling, so `npm test` needs no build step.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

function swapExtension(specifier, parentURL) {
    if (typeof parentURL !== 'string') {
        return null;
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        return null;
    }
    if (!specifier.endsWith('.js')) {
        return null;
    }
    const target = new URL(specifier, parentURL);
    if (existsSync(fileURLToPath(target))) {
        return null;
    }
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, parentURL);
    return existsSync(fileURLToPath(candidate)) ? candidate.href : null;
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        const swapped = swapExtension(specifier, context.parentURL);
        if (swapped !== null) {
            return { url: swapped, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
