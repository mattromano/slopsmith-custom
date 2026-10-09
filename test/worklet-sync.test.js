// Drift guard: the pitch worklet is inlined in screen.js (loaded via Blob URL
// because core serves no generic plugin-asset route) AND kept as a standalone
// canonical file assets/pitch-shift-worklet.js (documented + DSP-tested). This
// asserts the two copies stay identical so an edit to one can't silently rot
// the other.
//
// Run: node test/worklet-sync.test.js   (exit 0 = pass, 1 = fail)

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const asset = fs.readFileSync(path.join(root, 'assets', 'pitch-shift-worklet.js'), 'utf8');
const screen = fs.readFileSync(path.join(root, 'screen.js'), 'utf8');

// Extract the template-literal body of PITCH_WORKLET_SRC. The body is a JS
// template literal in which the worklet's own backticks are escaped as \` , so
// match chars that are either non-backtick/backslash or an escaped pair, then
// stop at the first real (unescaped) terminating backtick.
const m = screen.match(/PITCH_WORKLET_SRC\s*=\s*`((?:[^`\\]|\\.)*)`/);
if (!m) {
    console.error('FAIL: could not find PITCH_WORKLET_SRC template literal in screen.js');
    process.exit(1);
}
// Unescape the template-literal escapes we introduced (only backticks).
const inlined = m[1].replace(/\\`/g, '`');

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');
if (norm(inlined) !== norm(asset)) {
    console.error('FAIL: inlined PITCH_WORKLET_SRC has drifted from assets/pitch-shift-worklet.js');
    // Show the first differing line to make the fix obvious.
    const a = norm(inlined).split('\n');
    const b = norm(asset).split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
            console.error(`  first diff at line ${i + 1}:`);
            console.error(`    inline: ${JSON.stringify(a[i])}`);
            console.error(`    asset : ${JSON.stringify(b[i])}`);
            break;
        }
    }
    process.exit(1);
}

console.log('ok   inlined worklet matches assets/pitch-shift-worklet.js');
