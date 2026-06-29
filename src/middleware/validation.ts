import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodSchema } from 'zod';
import logger from '../config/logger';
import { ApiErrorCode, createErrorResponse } from './error';

const formatZodErrors = (error: ZodError): Record<string, string> => {
  const formattedErrors: Record<string, string> = {};
  error.errors.forEach((err) => {
    const path = err.path.join('.');
    formattedErrors[path] = err.message;
  });
  return formattedErrors;
};

export const validate = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      schema.parse(req.body);
      next();
    } catch (error: unknown) {
      logger.error('Validation error:', error);
      
      if (error instanceof ZodError) {
        res.status(400).json(createErrorResponse(
          ApiErrorCode.VALIDATION_ERROR,
          'Validation failed',
          formatZodErrors(error),
        ));
      } else {
        const message = error instanceof Error ? error.message : 'Validation failed';
        res.status(400).json(createErrorResponse(ApiErrorCode.VALIDATION_ERROR, message));
      }
    }
  };
};

export const validateQuery = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      schema.parse(req.query);
      next();
    } catch (error: unknown) {
      logger.error('Query validation error:', error);
      
      if (error instanceof ZodError) {
        res.status(400).json(createErrorResponse(
          ApiErrorCode.VALIDATION_ERROR,
          'Query validation failed',
          formatZodErrors(error),
        ));
      } else {
        const message = error instanceof Error ? error.message : 'Query validation failed';
        res.status(400).json(createErrorResponse(ApiErrorCode.VALIDATION_ERROR, message));
      }
    }
  };
};
