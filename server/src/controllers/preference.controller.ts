import { Request, Response } from 'express';
import { z } from 'zod';
import { preferenceStore } from '../services/preference.service';
import { AppError, handleControllerError } from '../utils/errorHandler';

/* -----------------------------------------------------------------
   Types & validation schema – mirrors `UserPreferences` in the
   PreferenceStore class.
   ----------------------------------------------------------------- */
const PreferencesSchema = z
  .object({
    temperature: z.number().min(0).max(1).optional(),
    responseStyle: z
      .enum(['concise', 'balanced', 'detailed'] as const)
      .optional(),
    defaultModel: z.enum(['qwen2.5:1.5b', 'qwen2.5:3b'] as const).optional(),
    maxContextTurns: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional(),
  })
  .strict();

/* -----------------------------------------------------------------
   GET /api/preferences
   Returns the complete preferences object (merged with defaults).
   ----------------------------------------------------------------- */
export async function getPreferences(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const all = preferenceStore.getAll();
    res.json(all);
  } catch (err) {
    handleControllerError(res, err, 'Preference Controller');
  }
}

/* -----------------------------------------------------------------
   PATCH /api/preferences
   Accepts a *partial* preferences payload, validates it strictly,
   stores the values and returns the new merged object.
   ----------------------------------------------------------------- */
export async function updatePreferences(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const payload = req.body as Record<string, unknown>;
    const parsed = PreferencesSchema.parse(payload);

    const updated = preferenceStore.update(parsed);
    res.json(updated);
  } catch (err) {
    handleControllerError(res, err, 'Preference Controller');
  }
}

/* -----------------------------------------------------------------
   POST /api/preferences/reset
   Clears the SQLite table and returns the default preferences.
   ----------------------------------------------------------------- */
export async function resetPreferences(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const reset = preferenceStore.reset();
    res.json(reset);
  } catch (err) {
    handleControllerError(res, err, 'Preference Controller');
  }
}

/* -----------------------------------------------------------------
   PUT /api/preferences/:key
   Updates a *single* preference key and validates it against the schema.
   ----------------------------------------------------------------- */
export async function setPreference(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { key } = req.params;
    const value = req.body?.value;

    const preferenceKey = String(key);
    const fieldSchema = PreferencesSchema.shape[
      preferenceKey as keyof typeof PreferencesSchema.shape
    ];
    if (!fieldSchema) {
      throw new AppError(`Unknown preference key: ${preferenceKey}`, 400);
    }
    const singleSchema = z.object({ [preferenceKey]: fieldSchema }).strict();
    const parsed = singleSchema.parse({ [preferenceKey]: value });

    // @ts-ignore – the index signature is safe after validation
    preferenceStore.set(key as any, parsed[key as any]);

    const updated = preferenceStore.getAll();
    res.json(updated);
  } catch (err) {
    handleControllerError(res, err, 'Preference Controller');
  }
}