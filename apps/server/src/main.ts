import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = await createApp(config);
const port = await app.listen();
app.log.info({ port, storage: app.db.kind }, 'Football Trivia server listening');

const stop = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
