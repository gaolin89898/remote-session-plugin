/** Delete the retired hand-drawn sidebar row styles and components. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/client.js');
let source = fs.readFileSync(file, 'utf8');

function removeBetween(startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    console.warn('start missing:', label);
    return;
  }
  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    console.warn('end missing:', label);
    return;
  }
  source = source.slice(0, start) + source.slice(end);
  console.log('removed:', label, (end - start), 'bytes');
}

removeBetween('    var hostRowStyle = {', '    var emptyHintStyle = {', 'old sidebar style vars');
removeBetween('    function SessionRow(props) {', '    function PeerSection(props) {', 'old SessionRow/FolderGlyph/Chevron');

fs.writeFileSync(file, source);
console.log('client.js now', source.length, 'bytes');
