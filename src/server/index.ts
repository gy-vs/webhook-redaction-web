// Server entry point. All routing lives in ./app.ts so tests can build an app
// without opening a socket.
import {fileURLToPath} from 'node:url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {createApp} = await import('./app.js');
  const port = Number(process.env.PORT ?? 4174);
  const dataDir = process.env.WEBHOOK_DATA_DIR ?? fileURLToPath(new URL('../../data', import.meta.url));
  const staticDir = fileURLToPath(new URL('../../dist/client', import.meta.url));
  const {app} = createApp({dataDir, staticDir});
  app.listen(port, '127.0.0.1', () => {
    console.log(`webhook lab http://127.0.0.1:${port} (data: ${dataDir})`);
  });
}

export {createApp, type AppContext} from './app';
export {MAX_EVENTS, Store} from './store';
