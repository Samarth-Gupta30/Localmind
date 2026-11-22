import { Router } from 'express';
import { getPreferences, updatePreferences, resetPreferences } from '../controllers/preference.controller';

const router = Router();

router.get('/', getPreferences);
router.patch('/', updatePreferences);
router.delete('/', resetPreferences);

export default router;