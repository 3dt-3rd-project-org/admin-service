import winston from 'winston';

winston.addColors({
  info: 'white',
  warn: 'yellow',
  error: 'red'
});

const customFormat = winston.format.printf(({ level, message, timestamp }) => {
  const formattedMessage = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
  return `[${timestamp}] [${level}] ${formattedMessage}`;
});

export const logger = winston.createLogger({
  levels: {
    error: 0,
    warn: 1,
    info: 2
  },
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize({ all: true }),
    customFormat
  ),
  transports: [
    new winston.transports.Console()
  ]
});
