import { createServer } from 'node:http';
import { createHandler, PREFIX } from '../lib/toolbox-server.js';

// Standalone preview for the AI toolbox page: the same bridge the plugin
// serves, so page changes can be tested without restarting DSH or Go.
const port = Number(process.env.FRONTEND_PORT || 5174);
const backendPort = Number(process.env.WORKBUDDY_BACKEND_PORT || 7863);
const handler = createHandler({ backendPort });
const server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(302, { location: PREFIX }); return res.end(); }
  return handler(req, res);
});
server.listen(port, '127.0.0.1', () => console.log(`AI toolbox preview: http://127.0.0.1:${port}${PREFIX}`));
