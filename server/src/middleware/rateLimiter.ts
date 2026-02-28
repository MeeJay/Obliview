import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip machine-to-machine endpoints: agent pushes and passive heartbeats are
  // already authenticated (API key / token) and can be high-frequency.
  skip: (req) =>
    req.path.startsWith('/api/agent/push') ||
    req.path.startsWith('/api/heartbeat/'),
  message: {
    success: false,
    error: 'Too many requests, please try again later',
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many login attempts, please try again later',
  },
});
