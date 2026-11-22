
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

const COOKIE_NAME = 'localmind_agent_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/i;

function getCookieValue(
  cookieHeader: string | undefined,
  cookieName: string
): string | undefined {
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader.split(';');

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf('=');

    if (separatorIndex === -1) continue;

    const name = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();

    if (name === cookieName) {
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

export function ensureAgentSession(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const existingSessionId = getCookieValue(
    req.headers.cookie,
    COOKIE_NAME
  );

  let sessionId: string;

  if (
    existingSessionId &&
    SESSION_ID_PATTERN.test(existingSessionId)
  ) {
    sessionId = existingSessionId;
  } else {
    sessionId = crypto.randomBytes(32).toString('hex');

    const secureCookie =
      req.secure || env.isProduction;

    const cookie = [
      `${COOKIE_NAME}=${sessionId}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${SESSION_TTL_SECONDS}`,
      ...(secureCookie ? ['Secure'] : []),
    ].join('; ');

    res.append('Set-Cookie', cookie);
  }

  res.locals.agentSessionId = sessionId;

  next();
}
 