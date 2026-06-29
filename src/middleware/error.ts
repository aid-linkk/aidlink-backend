import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

export const ApiErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  GONE: 'GONE',
  CONFLICT: 'CONFLICT',
  BAD_REQUEST: 'BAD_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const;

export type ApiErrorCode = typeof ApiErrorCode[keyof typeof ApiErrorCode];

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, string>;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
}

export const getDefaultErrorCode = (statusCode: number): ApiErrorCode => {
  switch (statusCode) {
    case 400:
      return ApiErrorCode.BAD_REQUEST;
    case 401:
      return ApiErrorCode.UNAUTHORIZED;
    case 403:
      return ApiErrorCode.FORBIDDEN;
    case 404:
      return ApiErrorCode.NOT_FOUND;
    case 410:
      return ApiErrorCode.GONE;
    case 409:
      return ApiErrorCode.CONFLICT;
    case 413:
      return ApiErrorCode.PAYLOAD_TOO_LARGE;
    case 415:
      return ApiErrorCode.UNSUPPORTED_MEDIA_TYPE;
    case 422:
      return ApiErrorCode.VALIDATION_ERROR;
    case 429:
      return ApiErrorCode.RATE_LIMITED;
    default:
      return ApiErrorCode.INTERNAL_SERVER_ERROR;
  }
};

export const createErrorResponse = (
  code: ApiErrorCode,
  message: string,
  details?: ApiErrorBody['details']
): ApiErrorResponse => ({
  success: false,
  error: details ? { code, message, details } : { code, message },
});

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  code: ApiErrorCode;

  constructor(message: string, statusCode: number = 500, code?: ApiErrorCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code || getDefaultErrorCode(statusCode);
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  if (err instanceof AppError) {
    res.status(err.statusCode).json(createErrorResponse(err.code, err.message));
    return;
  }

  // Prisma errors
  if (err.name === 'PrismaClientKnownRequestError') {
    res.status(400).json(createErrorResponse(ApiErrorCode.BAD_REQUEST, 'Database error'));
    return;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    res.status(401).json(createErrorResponse(ApiErrorCode.UNAUTHORIZED, 'Invalid token'));
    return;
  }

  if (err.name === 'TokenExpiredError') {
    res.status(401).json(createErrorResponse(ApiErrorCode.UNAUTHORIZED, 'Token expired'));
    return;
  }

  // Default error
  res
    .status(500)
    .json(createErrorResponse(
      ApiErrorCode.INTERNAL_SERVER_ERROR,
      process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    ));
};

export const notFoundHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  res.status(404).json(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Route not found'));
};
