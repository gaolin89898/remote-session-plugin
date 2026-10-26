/** Prevent fallback styling from flashing before the official vendor bundle is ready. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/client.js');
let source = fs.readFileSync(file, 'utf8');

// 1) compute readiness/pending flags before the transcript body render
const historyAnchor = "      var officialHistory = transcript && transcript.officialHistory ? transcript.officialHistory : null;";
if (!source.includes(historyAnchor)) throw new Error('officialHistory anchor missing');
source = source.replace(historyAnchor, `      var vendorFlowReady = !!(flowVendor && typeof flowVendor.VendorChatFlow === 'function');
      // Official fold is authoritative: hold the body blank for the few ms the
      // inline bundle evaluates instead of flashing the hand-drawn fallback.
      var officialPending = !!(transcript && transcript.official && !flowFailed && !vendorFlowReady);
${historyAnchor}`);

// 2) body branch: pending -> nothing; official only when ready; fallback only after a real failure
const oldBranch = "              : messages.length === 0\n                ? h('div', { style: emptyHintStyle }, '（暂无消息）')\n              : transcript && transcript.official && !flowFailed && flowVendor && typeof flowVendor.VendorChatFlow === 'function'";
const newBranch = "              : messages.length === 0\n                ? h('div', { style: emptyHintStyle }, '（暂无消息）')\n              : officialPending\n                ? null\n              : transcript && transcript.official && !flowFailed && vendorFlowReady";
if (!source.includes(oldBranch)) throw new Error('transcript branch anchor missing');
source = source.replace(oldBranch, newBranch);

// 3) sidebar list: render nothing until the official rows are available
const listAnchor = "              loading && !snapshot\n                ? h('div', { style: emptyHintStyle }, '正在读取主机状态…')\n                : peers.length === 0";
const listReplacement = "              loading && !snapshot\n                ? h('div', { style: emptyHintStyle }, '正在读取主机状态…')\n                : !sidebarVendor\n                  ? null\n                : peers.length === 0";
if (!source.includes(listAnchor)) throw new Error('sidebar list anchor missing');
source = source.replace(listAnchor, listReplacement);

fs.writeFileSync(file, source);
console.log('flash guards applied:', source.length, 'bytes');
