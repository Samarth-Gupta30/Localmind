const configuredApiUrl = import.meta.env.VITE_API_URL;

export const API_BASE = (
  configuredApiUrl ?? 'http://localhost:5000'
).replace(/\/+$/, '');