'use strict';

const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Mapillary client token (required for world round Street View)
  MAPILLARY_CLIENT_TOKEN: z.string().min(1),

  // CORS origin — in prod lock this to your actual domain
  CORS_ORIGIN: z.string().default('*'),

  // How long (ms) to keep an ended/empty room in memory before purging
  ROOM_TTL_MS: z.coerce.number().default(30 * 60 * 1000), // 30 min
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Log to stderr directly — logger may not be initialised yet
    console.error(
      '[config] Invalid environment variables:\n',
      result.error.flatten().fieldErrors
    );
    process.exit(1);
  }

  return Object.freeze(result.data);
}

module.exports = loadConfig();