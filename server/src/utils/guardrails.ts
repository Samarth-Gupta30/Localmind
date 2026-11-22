import { z } from 'zod';

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  rawText: string;
}

/**
 * Extracts and parses JSON from raw LLM output even if surrounded by
 * conversational preamble or markdown code fences (```json ... ```)
 */
export function extractJSONFromText(text: string): any {
  // 1. If text is wrapped in markdown code blocks: ```json { ... } ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return JSON.parse(codeBlockMatch[1].trim());
  }

  // 2. If text contains raw JSON object: { ... }
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    return JSON.parse(jsonObjectMatch[0].trim());
  }

  // 3. Fallback: try parsing directly
  return JSON.parse(text.trim());
}

/**
 * Validates extracted data against a strict Zod schema
 */
export function validateWithSchema<T>(
  rawText: string,
  schema: z.ZodSchema<T>
): ValidationResult<T> {
  try {
    const parsedJson = extractJSONFromText(rawText);
    const validatedData = schema.parse(parsedJson);

    return {
      success: true,
      data: validatedData,
      rawText
    };
  } catch (error: any) {
    let errorMessage = 'Failed to parse JSON';

    if (error instanceof z.ZodError) {
      // Format readable schema validation errors
      errorMessage = error.issues
        .map((issue) => `Field '${issue.path.join('.')}': ${issue.message}`)
        .join('; ');
    } else if (error instanceof SyntaxError) {
      errorMessage = `Malformed JSON syntax: ${error.message}`;
    }

    return {
      success: false,
      error: errorMessage,
      rawText
    };
  }
}