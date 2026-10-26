/** Insert the official Settings-page section and its slot registration into lib/client.js. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'lib/client.js');
let source = fs.readFileSync(file, 'utf8');

if (source.includes("'settings.section'")) {
  console.log('already patched');
  process.exit(0);
}

const section = fs.readFileSync(path.join(__dirname, 'settings-section.js'), 'utf8');
const registration = fs.readFileSync(path.join(__dirname, 'settings-registration.js'), 'utf8');

const anchor = '    // ── sidebar icon ────────────────────────────────────────────────────────\n    function PanellistIcon(props) {';
if (!source.includes(anchor)) throw new Error('settings section anchor missing');
source = source.replace(anchor, section + anchor);

const mountAnchor = "          mountWhenDeclared('main', registerPage);";
if (!source.includes(mountAnchor)) throw new Error('mount anchor missing');
source = source.replace(mountAnchor, mountAnchor + '\n' + registration);

fs.writeFileSync(file, source);
console.log('settings section inserted:', source.length, 'bytes');
