import { z } from 'zod';

/**
 * Preferences accepted on PUT /profile. Must stay in sync with the shape
 * declared by `UserPreferences` in shared/src/types.ts — Zod's default
 * behaviour is to STRIP unknown keys, so any field missing here is silently
 * dropped before it reaches the DB. Ultracode review caught `preferredTheme`
 * being silently discarded because the enum grew (4 themes now) but this
 * schema hadn't been widened; the client's applyTheme() wrote to localStorage
 * so the UI looked fine until the user cleared storage / switched browser.
 */
const userPreferencesSchema = z.object({
  toastEnabled: z.boolean().optional(),
  toastPosition: z.enum(['top-center', 'bottom-right']).optional(),
  preferredTheme: z.enum(['obli-operator', 'obli-daylight', 'modern', 'neon']).optional(),
  anonymousMode: z.boolean().optional(),
  multiTenantNotificationsEnabled: z.boolean().optional(),
}).nullable().optional();

export const updateProfileSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  preferences: userPreferencesSchema,
  email: z.string().email().max(255).nullable().optional(),
  preferredLanguage: z.string().max(10).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(128),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
