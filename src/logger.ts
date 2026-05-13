import pino from 'pino';

// Use pino-pretty only when stdout is an interactive TTY (local `npm run dev`).
// In containers, CI, or piped output, emit newline-delimited JSON so log
// aggregators (and tests that grep for `"level":` or parse audit lines) work.
const isTTY = Boolean(process.stdout.isTTY);

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isTTY
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
