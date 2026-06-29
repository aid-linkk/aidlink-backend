import multer from 'multer';
import { Request, Response, NextFunction } from 'express';
import { ApiErrorCode, createErrorResponse } from './error';

const multerInstance = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // outer ceiling; per-type limits enforced in StorageService
    files: 1,
  },
});

export function uploadSingle(fieldName = 'file') {
  return (req: Request, res: Response, next: NextFunction): void => {
    multerInstance.single(fieldName)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json(createErrorResponse(ApiErrorCode.PAYLOAD_TOO_LARGE, 'File too large'));
          return;
        }
        res.status(400).json(createErrorResponse(ApiErrorCode.BAD_REQUEST, err.message));
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  };
}
