'use strict';

const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Admin password — required, no default so it must be explicitly set
  ADMIN_PASSWORD: z.string().min(4, 'ADMIN_PASSWORD must be at least 4 characters'),

  // Mapillary client token
  MAPILLARY_CLIENT_TOKEN: z.string().min(1),

  // CORS origin
  CORS_ORIGIN: z.string().default('*'),

  // Room TTL
  ROOM_TTL_MS: z.coerce.number().default(30 * 60 * 1000),

  // Round counts
  MAX_WORLD_ROUNDS:  z.coerce.number().int().min(1).default(6),
  MAX_CAMPUS_ROUNDS: z.coerce.number().int().min(0).default(4),

  // Checkpoint file path
  CHECKPOINT_PATH: z.string().default('./gamestate.json'),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error(
      '[config] Invalid environment variables:\n',
      result.error.flatten().fieldErrors
    );
    process.exit(1);
  }

  return Object.freeze(result.data);
}

module.exports = loadConfig();