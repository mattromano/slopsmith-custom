// Verify static/highway.js exposes `getAudioElement()` on the public api
// so plugins don't have to reach for `document.getElementById('audio')`
// directly. Static + behavioral checks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

test('highway.api object declares getAudioElement', () => {
    // Source-level guard: catches a future contributor renaming or
    // dropping the method silently. The api object lives at the bottom
    // of the closure; we look for the method's signature inside it.
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    // Locate the api block boundaries.
    const apiStart = src.indexOf('const api = {');
    assert.ok(apiStart !== -1, 'highway api block not found');
    // The api block extends to `return api;`.
    const apiEnd = src.indexOf('return api;', apiStart);
    assert.ok(apiEnd !== -1, 'api block end (return api) not found');
    const apiBlock = src.slice(apiStart, apiEnd);

    assert.match(
        apiBlock,
        /getAudioElement\s*\(\s*\)\s*\{/,
        'api object must declare getAudioElement()',
    );
});

// Brace-balanced extraction so a future getAudioElement that grows
// (guards, try/catch, nested object literals) doesn't get truncated by
// a naive `[^}]*\}` regex.
function extractMethodBody(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${signature}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

test('getAudioElement returns the #audio element from document', () => {
    // Behavioral check: extract the getAudioElement method body and
    // exercise it against a fake document. Confirms it's calling
    // getElementById('audio') (not 'btn-play' or anything else).
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const body = extractMethodBody(src, 'getAudioElement()');

    // Wrap it so we can call it standalone.
    const stub = { id: 'audio-stub' };
    const sandbox = {
        document: {
            getElementById: (id) => (id === 'audio' ? stub : null),
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(`globalThis.__getAudioElement = function ${body};`, sandbox);

    const result = sandbox.__getAudioElement();
    assert.equal(result, stub, 'getAudioElement must return getElementById("audio")');
});
