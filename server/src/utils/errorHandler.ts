import { Response } from 'express';
import { z } from 'zod';
import { writeSSEEvent, isStreamWritable } from './sse';
import { logger } from './logger';

export type ErrorCategory =
  | 'VALIDATION_ERROR'
  | 'AUTH_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'INTERNAL_ERROR';

function defaultCategoryForStatus(statusCode: number): ErrorCategory {
  if (statusCode === 400) return 'VALIDATION_ERROR';
  if (statusCode === 401 || statusCode === 403) return 'AUTH_ERROR';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 409) return 'CONFLICT';
  if (statusCode === 413) return 'PAYLOAD_TOO_LARGE';
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return 'EXTERNAL_SERVICE_ERROR';
  }
  return 'INTERNAL_ERROR';
}

/**
 * Custom application error with explicit HTTP status code and error category.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly category: ErrorCategory;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode = 500,
    isOperational = true,
    category?: ErrorCategory
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.category = category ?? defaultCategoryForStatus(statusCode);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isZodValidationError(error: unknown): error is z.ZodError {
  if (error instanceof z.ZodError) return true;
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as any).name === 'ZodError' &&
    Array.isArray((error as any).issues)
  ) {
    return true;
  }
  return false;
}

function formatZodError(err: z.ZodError): string {
  const details = err.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${field}${issue.message}`;
    })
    .join('; ');
  return details ? `Invalid request payload (${details}).` : 'Invalid request payload.';
}

/**
 * Extracts a clean readable error message from any thrown value.
 */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (isZodValidationError(error)) return formatZodError(error);
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}

/**
 * Standardized controller error dispatcher:
 * - Converts ZodError to HTTP 400 VALIDATION_ERROR
 * - Logs full error internally via unified logger
 * - Exposes detailed message ONLY for operational AppErrors
 * - Masks unexpected internal errors behind a generic 500 message
 */
export function handleControllerError(res: Response, error: unknown, context: string): void {
  const normalizedError = isZodValidationError(error)
    ? new AppError(formatZodError(error), 400, true, 'VALIDATION_ERROR')
    : error;

  const isOperational = normalizedError instanceof AppError && normalizedError.isOperational;
  const statusCode = normalizedError instanceof AppError ? normalizedError.statusCode : 500;
  const category: ErrorCategory =
    normalizedError instanceof AppError ? normalizedError.category : 'INTERNAL_ERROR';

  const internalMessage = getErrorMessage(normalizedError, `Unexpected error in ${context}`);
  logger.error(context, `[${category}] ${internalMessage}`, normalizedError);

  const clientMessage = isOperational
    ? internalMessage
    : 'An unexpected internal error occurred.';

  if (res.headersSent) {
    if (isStreamWritable(res)) {
      writeSSEEvent(res, { type: 'error', error: clientMessage, code: category });
      try {
        res.end();
      } catch {
        // Socket closed
      }
    }
  } else {
    res.status(statusCode).json({
      error: clientMessage,
      code: category,
      timestamp: new Date().toISOString(),
    });
  }
}