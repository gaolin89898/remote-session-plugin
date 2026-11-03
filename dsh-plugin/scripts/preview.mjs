import { createServer } from 'node:http';
import { createHandler, PREFIX } from '../lib/server.js';

const port = Number(process.env.FRONTEND_PORT || 5174);
const backendPort = Number(process.env.WORKBUDDY_BACKEND_PORT || 7863);
const handler = createHandler({ backendPort });
const server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(302, { location: PREFIX }); return res.end(); }
  return handler(req, res);
});
server.listen(port, '127.0.0.1', () => console.log(`独立前端：http://127.0.0.1:${port}${PREFIX}`));
