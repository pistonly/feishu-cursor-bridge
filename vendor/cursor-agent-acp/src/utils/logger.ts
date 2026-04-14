/**
 * Logger utility module
 *
 * Provides a configurable logger using Winston for the Cursor Agent ACP Adapter.
 */

import winston from 'winston';
import type { Logger } from '../types';

export interface LoggerOptions {
  level?: 'error' | 'warn' | 'info' | 'debug' | undefined;
  format?: 'json' | 'simple' | 'colorized' | undefined;
  filename?: string | undefined;
  silent?: boolean | undefined;
}

/**
 * Creates a configured logger instance
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const {
    level = 'info',
    format = 'colorized',
    filename,
    silent = false,
  } = options;

  // Define custom format for different output types
  const formats = {
    json: winston.format.json(),
    simple: winston.format.simple(),
    colorized: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, stack }) => {
        return `${timestamp} [${level}]: ${stack || message}`;
      })
    ),
  };

  // Configure transports based on options
  const transports: winston.transport[] = [];

  if (!silent) {
    // Console transport - MUST use stderr for ACP protocol compliance
    // stdout is reserved for JSON-RPC messages only
    transports.push(
      new winston.transports.Console({
        format: formats[format],
        level,
        stderrLevels: ['error', 'warn', 'info', 'debug'], // Send ALL logs to stderr
      })
    );
  }

  // File transport if filename is specified
  if (filename) {
    transports.push(
      new winston.transports.File({
        filename,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.errors({ stack: true }),
          winston.format.printf(
            ({ timestamp, level, message, stack, ...meta }) => {
              const metaStr = Object.keys(meta).length
                ? ` ${JSON.stringify(meta)}`
                : '';
              return `${timestamp} [${level}]: ${stack || message}${metaStr}`;
            }
          )
        ),
        level,
      })
    );
  }

  // Create Winston logger
  const winstonLogger = winston.createLogger({
    level,
    transports,
    exitOnError: false,
    silent,
  });

  // Wrap Winston logger to match our Logger interface
  return {
    error: (message: string, ...args: any[]): void => {
      winstonLogger.error(message, ...args);
    },
    warn: (message: string, ...args: any[]): void => {
      winstonLogger.warn(message, ...args);
    },
    info: (message: string, ...args: any[]): void => {
      winstonLogger.info(message, ...args);
    },
    debug: (message: string, ...args: any[]): void => {
      winstonLogger.debug(message, ...args);
    },
  };
}
