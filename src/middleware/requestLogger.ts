import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const encoding = res.getHeader('Content-Encoding') as string | undefined;
    const contentLength = res.getHeader('Content-Length');

    // Build a compact compression note shown only when compression fired
    const compressionNote = encoding && encoding !== 'identity'
      ? { encoding, compressedBytes: contentLength ?? 'chunked' }
      : undefined;

    logger.info({
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      ...(compressionNote ? { compression: compressionNote } : {}),
      timestamp: new Date().toISOString(),
    });
  });

  next();
};

export const errorLogger = (err: any, req: Request, res: Response, next: NextFunction): void => {
  logger.error({
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url,
    ip: req.ip,
    timestamp: new Date().toISOString(),
  });

  next(err);
};
