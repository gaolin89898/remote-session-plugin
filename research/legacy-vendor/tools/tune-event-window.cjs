/** Smaller first event window + surface official-render failures. */
const fs = require('node:fs');
const path = require('node:path');

const clientFile = path.resolve(__dirname, '../lib/client.js');
let source = fs.readFileSync(clientFile, 'utf8');

source = source.replace('var windowSize = Math.max(200, Number(eventWindow) || 4000);',
  'var windowSize = Math.max(200, Number(eventWindow) || 1200);');
source = source.replace('var eventWindowRef = React.useRef(4000);',
  'var eventWindowRef = React.useRef(1200);');
source = source.replace('eventWindowRef.current = Math.min(60000, eventWindowRef.current + 4000);',
  'eventWindowRef.current = Math.min(60000, eventWindowRef.current + 1200);');

// surface why the official fold is unavailable
source = source.replace(`      var pollIndexRef = React.useRef(0);`,
`      var pollIndexRef = React.useRef(0);
      var officialIssueRef = React.useRef(null);`);
source = source.replace(`            if (folded && folded.official) lastEnrichedRef.current = folded;`,
`            if (folded && folded.official) lastEnrichedRef.current = folded;
            if (!folded || !folded.official) {
              var issue = !results[1]
                ? '会话事件数据加载失败（会话较大或中转超限）'
                : '事件窗口为空，无法构建官方渲染';
              if (officialIssueRef.current !== issue) {
                officialIssueRef.current = issue;
                setActionError('官方渲染未生效：' + issue);
              }
            } else if (officialIssueRef.current !== null) {
              officialIssueRef.current = null;
              setActionError(null);
            }`);
source = source.replace(`        foldRecoverRef.current = 0;
        pollIndexRef.current = 0;`, `        foldRecoverRef.current = 0;
        pollIndexRef.current = 0;
        officialIssueRef.current = null;`);

fs.writeFileSync(clientFile, source);
console.log('client window + diagnostics:', source.length, 'bytes');
