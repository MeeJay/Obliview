import apiClient from './client';
import type { User, ApiResponse } from '@obliview/shared';

export const ssoApi = {
  /**
   * Generate a one-time 60s switch token for the current user.
   * Call this before redirecting to the other app's /auth/foreign page.
   */
  async generateSwitchToken(): Promise<string> {
    const res = await apiClient.post<ApiResponse<{ token: string }>>('/sso/generate-token');
    return res.data.data!.token;
  },

  /**
   * Exchange an incoming token from another app.
   * Called by ForeignAuthPage after arriving from Obliguard.
   * Creates a local session and returns the user.
   */
  async exchange(
    token: string,
    from: string,
  ): Promise<
    | { user: User; isFirstLogin: boolean }
    | { needsLinking: true; linkToken: string; conflictingUsername: string }
  > {
    const res = await apiClient.post<ApiResponse<
      | { user: User; isFirstLogin: boolean }
      | { needsLinking: true; linkToken: string; conflictingUsername: string }
    >>('/sso/exchange', { token, from });
    return res.data.data!;
  },

  /**
   * Complete the account-linking flow after verifying local password.
   */
  async completeLink(linkToken: string, password: string): Promise<{ user: User; isFirstLogin: boolean }> {
    const res = await apiClient.post<ApiResponse<{ user: User; isFirstLogin: boolean }>>(
      '/sso/complete-link',
      { linkToken, password },
    );
    return res.data.data!;
  },

  /**
   * Set a local password for the current user (SSO-only accounts only).
   * Called after first SSO login when user opts into local login.
   */
  async setLocalPassword(password: string): Promise<void> {
    await apiClient.post('/sso/set-password', { password });
  },
};
