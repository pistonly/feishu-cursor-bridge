/**
 * Error formatter utility module
 *
 * Provides functions to format errors for consistent error handling and reporting.
 */

import { AdapterError, SessionError, ToolError } from '../types';

/**
 * Formats an error for human-readable display
 */
export function formatError(error: Error | AdapterError): string {
  if (error instanceof AdapterError) {
    let formatted = `[${error.code}] ${error.message}`;

    // Add specific context for different error types
    if (error instanceof SessionError && error.sessionId) {
      formatted = `${formatted} (Session: ${error.sessionId})`;
    }

    if (error instanceof ToolError && error.toolName) {
      formatted = `${formatted} (Tool: ${error.toolName})`;
    }

    // Include cause if present
    if (error.cause) {
      formatted = `${formatted}\nCaused by: ${formatError(error.cause)}`;
    }

    return formatted;
  }

  return `${error.name}: ${error.message}`;
}
