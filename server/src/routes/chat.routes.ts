import { Router } from 'express';
import { streamGeneralChat, streamRagChat } from '../controllers/chat.controller';

const router = Router();

router.post('/stream', streamGeneralChat);
router.post('/rag/stream', streamRagChat);

export default router;