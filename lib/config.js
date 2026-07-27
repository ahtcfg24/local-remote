function numberFromEnv(value, fallback, { min, max, integer = false }) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = integer ? Math.trunc(parsed) : parsed;
  return Math.min(max, Math.max(min, normalized));
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: numberFromEnv(env.PORT, 8787, { min: 1, max: 65535, integer: true }),
    fps: numberFromEnv(env.FPS, 15, { min: 1, max: 30, integer: true }),
    quality: numberFromEnv(env.QUALITY, 0.6, { min: 0.2, max: 0.95 }),
    maxWidth: numberFromEnv(env.MAX_WIDTH, 1920, { min: 640, max: 3840, integer: true }),
    maxClients: numberFromEnv(env.MAX_CLIENTS, 4, { min: 1, max: 32, integer: true }),
  };
}
