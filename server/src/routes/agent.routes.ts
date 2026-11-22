import { Router } from 'express';
import {
  executeTool,
  streamAgentChat,
} from '../controllers/agent.controller';
import { ensureAgentSession } from '../utils/agentSession';

const router = Router();

// Establish or retrieve the browser session
router.use(ensureAgentSession);

router.post('/tools/execute', executeTool);
router.post('/stream', streamAgentChat);

export default router;
