import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { uploadDocument, listDocuments, deleteDocument } from '../controllers/document.controller';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

const router = Router();

// Middleware to handle Multer upload errors cleanly as JSON
export const handleUploadMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'File size exceeds the 10MB upload limit.' });
        return;
      }
      res.status(400).json({ error: `Upload error: ${err.message}` });
      return;
    }

    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown upload error.' });
      return;
    }

    next();
  });
};

router.post('/upload', handleUploadMiddleware, uploadDocument);
router.get('/', listDocuments);
router.delete('/:fileName', deleteDocument);

export default router;