import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'football-trivia' },
    redact: { paths: ['resumeToken', '*.resumeToken', 'token', 'headers.authorization'], censor: '[redacted]' },
  });
}
export type Logger = ReturnType<typeof createLogger>;
