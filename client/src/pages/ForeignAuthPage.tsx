/**
 * ForeignAuthPage — /auth/foreign
 *
 * Landing page for users arriving from another app (Obliguard) via SSO.
 * Flow:
 *   1. Read ?token=xxx&from=https://obliguard.example.com&redirect=/agents/18 from URL
 *   2. Call POST /api/sso/exchange → get { user, isFirstLogin }
 *   3. If isFirstLogin → show optional "set local password" dialog
 *   4. Update auth store, then redirect (to `redirect` param or `/`)
 *      (ProtectedRoute will send to /enroll if enrollmentVersion = 0)
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Eye, EyeOff, Loader2, ShieldAlert } from 'lucide-react';
import { ssoApi } from '@/api/sso.api';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';

type Stage = 'loading' | 'link-required' | 'set-password' | 'error';

export function ForeignAuthPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { checkSession } = useAuthStore();

  const token    = searchParams.get('token') ?? '';
  const from     = searchParams.get('from') ?? '';
  const redirect = searchParams.get('redirect') ?? '/';
  const source   = searchParams.get('source') ?? '';   // e.g. 'obliguard'

  const [stage, setStage]               = useState<Stage>('loading');
  const [errorMsg, setErrorMsg]         = useState('');
  const [password, setPassword]         = useState('');
  const [confirm, setConfirm]           = useState('');
  const [pwError, setPwError]           = useState('');
  const [showPw, setShowPw]             = useState(false);
  const [saving, setSaving]             = useState(false);
  const [linkToken, setLinkToken]       = useState('');
  const [linkUsername, setLinkUsername] = useState('');
  const [linkPassword, setLinkPassword] = useState('');
  const [linkError, setLinkError]       = useState('');
  const [linking, setLinking]           = useState(false);

  // Derive a friendly source name: use the `source` param if provided, else hostname
  const sourceName = source
    ? source.charAt(0).toUpperCase() + source.slice(1)
    : (() => { try { return new URL(from).hostname; } catch { return 'external app'; } })();

  // ── Step 1: exchange token on mount ──────────────────────────────────────
  useEffect(() => {
    if (!token || !from) {
      setErrorMsg('Missing SSO parameters. Please try switching again.');
      setStage('error');
      return;
    }

    ssoApi.exchange(token, from)
      .then((data) => {
        if ('needsLinking' in data) {
          setLinkToken(data.linkToken);
          setLinkUsername(data.conflictingUsername);
          setStage('link-required');
        } else if (data.isFirstLogin) {
          setStage('set-password');
        } else {
          void finalize();
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'SSO authentication failed';
        setErrorMsg(msg);
        setStage('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Finalize: sync session store then redirect ───────────────────────────
  async function finalize() {
    await checkSession();
    navigate(redirect, { replace: true });
  }

  // ── Set password handler ─────────────────────────────────────────────────
  async function handleSetPassword() {
    setPwError('');
    if (password.length < 8) { setPwError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setPwError('Passwords do not match'); return; }
    setSaving(true);
    try {
      await ssoApi.setLocalPassword(password);
    } catch {
      // Non-blocking — just skip silently if it fails
    } finally {
      setSaving(false);
    }
    void finalize();
  }

  async function handleSkip() {
    void finalize();
  }

  // ── Link existing account handler ─────────────────────────────────────────
  async function handleLink() {
    setLinkError('');
    if (!linkPassword) { setLinkError('Password is required'); return; }
    setLinking(true);
    try {
      await ssoApi.completeLink(linkToken, linkPassword);
      void finalize();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Linking failed';
      setLinkError(msg);
    } finally {
      setLinking(false);
    }
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (stage === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-4 text-text-muted">
          <Loader2 size={36} className="animate-spin text-[#6366f1]" />
          <p className="text-sm">Signing you in via {sourceName}…</p>
        </div>
      </div>
    );
  }

  // ── Link required (username collision with existing local account) ────────
  if (stage === 'link-required') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-8 space-y-5">
          <div className="text-center space-y-2">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#1e1b4b]/60 border border-[#4338ca]/60">
              <ArrowLeftRight size={22} className="text-[#a5b4fc]" />
            </div>
            <h1 className="text-lg font-semibold text-text-primary">Link your accounts</h1>
            <p className="text-sm text-text-muted">
              An account <span className="font-medium text-text-secondary">{linkUsername}</span> already
              exists on Obliview. Enter your Obliview password to link it to your {sourceName} identity.
            </p>
          </div>
          <div className="space-y-3">
            <div className="relative">
              <Input
                label={`Obliview password for "${linkUsername}"`}
                type={showPw ? 'text' : 'password'}
                value={linkPassword}
                onChange={(e) => setLinkPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleLink(); }}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-3 top-8 text-text-muted hover:text-text-primary"
              >
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {linkError && <p className="text-xs text-status-down">{linkError}</p>}
          </div>
          <Button className="w-full" onClick={handleLink} disabled={linking || !linkPassword}>
            {linking ? 'Linking…' : 'Link accounts'}
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => navigate('/login', { replace: true })}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (stage === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-8 text-center space-y-4">
          <ShieldAlert size={40} className="mx-auto text-status-down" />
          <h1 className="text-lg font-semibold text-text-primary">SSO Failed</h1>
          <p className="text-sm text-text-muted">{errorMsg}</p>
          <Button variant="secondary" onClick={() => navigate('/login', { replace: true })}>
            Back to Login
          </Button>
        </div>
      </div>
    );
  }

  // ── Set local password (first login) ─────────────────────────────────────
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-8 space-y-5">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#1e1b4b]/60 border border-[#4338ca]/60">
            <ArrowLeftRight size={22} className="text-[#a5b4fc]" />
          </div>
          <h1 className="text-lg font-semibold text-text-primary">Welcome to Obliview!</h1>
          <p className="text-sm text-text-muted">
            You signed in via <span className="font-medium text-text-secondary">{sourceName}</span>.
            Set a local password to also log in directly — or skip for now.
          </p>
        </div>

        {/* Password fields */}
        <div className="space-y-3">
          <div className="relative">
            <Input
              label="Local password (optional)"
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-3 top-8 text-text-muted hover:text-text-primary"
            >
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <Input
            label="Confirm password"
            type={showPw ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repeat your password"
          />
          {pwError && <p className="text-xs text-status-down">{pwError}</p>}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={handleSkip}
            disabled={saving}
          >
            Skip for now
          </Button>
          <Button
            className="flex-1"
            onClick={handleSetPassword}
            disabled={saving || !password}
          >
            {saving ? 'Saving…' : 'Set password'}
          </Button>
        </div>
      </div>
    </div>
  );
}
