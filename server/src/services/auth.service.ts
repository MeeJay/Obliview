import { db } from '../db';
import { hashPassword, comparePassword } from '../utils/crypto';

/** Thrown by findOrCreateForeignUser when the incoming username matches an existing local account. */
export class AccountLinkRequiredError extends Error {
  constructor(public readonly conflictingUsername: string) {
    super('account_link_required');
  }
}
import type { User, UserPreferences } from '@obliview/shared';
import { logger } from '../utils/logger';

interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  preferences?: UserPreferences | null;
  email?: string | null;
  preferred_language?: string;
  enrollment_version?: number;
  totp_enabled?: boolean;
  email_otp_enabled?: boolean;
  foreign_source?: string | null;
  foreign_id?: number | null;
  foreign_source_url?: string | null;
}

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as User['role'],
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    preferences: row.preferences ?? null,
    email: row.email ?? null,
    preferredLanguage: row.preferred_language ?? 'en',
    enrollmentVersion: row.enrollment_version ?? 0,
    totpEnabled: row.totp_enabled ?? false,
    emailOtpEnabled: row.email_otp_enabled ?? false,
    foreignSource: row.foreign_source ?? null,
    foreignId: row.foreign_id ?? null,
    foreignSourceUrl: row.foreign_source_url ?? null,
    hasPassword: row.password_hash !== null && row.password_hash !== '',
  };
}

export const authService = {
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = await db<UserRow>('users')
      .where({ username, is_active: true })
      .first();

    if (!row) return null;
    // Foreign users with no local password cannot login with password
    if (!row.password_hash) return null;

    const valid = await comparePassword(password, row.password_hash);
    if (!valid) return null;

    return rowToUser(row);
  },

  async getUserById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    if (!row) return null;
    return rowToUser(row);
  },

  async createUser(
    username: string,
    password: string,
    role: string = 'user',
    displayName?: string,
  ): Promise<User> {
    const passwordHash = await hashPassword(password);

    const [row] = await db<UserRow>('users')
      .insert({
        username,
        password_hash: passwordHash,
        display_name: displayName || null,
        role,
      })
      .returning('*');

    return rowToUser(row);
  },

  /**
   * Find or create a foreign SSO user.
   * Returns the user + whether this is their first ever login.
   */
  async findOrCreateForeignUser(
    foreignSource: string,
    foreignId: number,
    foreignSourceUrl: string,
    info: { username: string; email?: string | null },
  ): Promise<{ user: User; isFirstLogin: boolean }> {
    // Try to find existing foreign user
    const existing = await db<UserRow>('users')
      .where({ foreign_source: foreignSource, foreign_id: foreignId })
      .first();

    if (existing) {
      // Sync username/email from source (they may have changed)
      await db('users').where({ id: existing.id }).update({
        username: info.username,
        email: info.email ?? existing.email,
        foreign_source_url: foreignSourceUrl,
        updated_at: new Date(),
      });
      const updated = await db<UserRow>('users').where({ id: existing.id }).first() as UserRow;
      return { user: rowToUser(updated), isFirstLogin: false };
    }

    // If the username belongs to an existing LOCAL account, require password linking instead of
    // silently creating a suffixed duplicate. Throws AccountLinkRequiredError to the caller.
    const localCollision = await db('users')
      .where({ username: info.username })
      .whereNull('foreign_source')
      .first();
    if (localCollision) throw new AccountLinkRequiredError(info.username);

    // Create new foreign user (no password, enrollment pending)
    const [row] = await db<UserRow>('users')
      .insert({
        username: info.username,
        password_hash: null,
        display_name: info.username,
        role: 'user',
        is_active: true,
        email: info.email ?? null,
        preferred_language: 'en',
        enrollment_version: 0,
        foreign_source: foreignSource,
        foreign_id: foreignId,
        foreign_source_url: foreignSourceUrl,
      })
      .returning('*');

    return { user: rowToUser(row), isFirstLogin: true };
  },

  async ensureDefaultAdmin(username: string, password: string): Promise<void> {
    const existing = await db('users').where({ role: 'admin' }).first();
    if (existing) return;

    await this.createUser(username, password, 'admin', 'Administrator');
    logger.info(`Default admin user "${username}" created`);
  },
};
