import { startServer } from './app.js';
import { defaultDataDir } from './paths.js';

const token = process.env.CLASSPAD_TOKEN;
const s = await startServer({
  dataDir: defaultDataDir(),
  token,
  dev: true,
  logger: true,
  watch: true,
  port: Number(process.env.PORT ?? 0),
});
console.log(`API ready at ${s.url}/api/v1 (data: ${defaultDataDir()})`);
if (!token) console.log(`Bearer token: ${s.token}`);
const stop = () => void s.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
