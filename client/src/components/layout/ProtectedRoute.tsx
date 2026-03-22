import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

// Must match REQUIRED_ENROLLMENT_VERSION in server/src/controllers/enrollment.controller.ts
const REQUIRED_ENROLLMENT_VERSION = 2;

interface ProtectedRouteProps {
  requiredRole?: string;
}

export function ProtectedRoute({ requiredRole }: ProtectedRouteProps) {
  const { user, isInitialized } = useAuthStore();
  const location = useLocation();

  if (!isInitialized) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-primary">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // In ObliTools (native desktop app), the app runs inside a cross-site iframe.
  // Session cookies are blocked by SameSite policy until the server sends
  // SameSite=None; Secure — which requires a server restart after the fix.
  // Skip the enrollment redirect in this context to prevent a login loop:
  // the enrollment wizard calls checkSession() on completion, which would get
  // 401 (cookie not sent), clear the user, and redirect back to /login.
  const isInObliTools = (() => {
    try {
      return window !== window.top;
    } catch {
      return true; // cross-origin frame access blocked → definitely in iframe
    }
  })() || !!(window as { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

  // Redirect to enrollment if user hasn't completed the required enrollment version.
  // Skip the check when already on /enroll to prevent a redirect loop,
  // skip it entirely when running inside ObliTools (see above),
  // and skip it for Obligate SSO users (onboarding is managed by Gate).
  if (
    !isInObliTools &&
    user.foreignSource !== 'obligate' &&
    (user.enrollmentVersion ?? 0) < REQUIRED_ENROLLMENT_VERSION &&
    location.pathname !== '/enroll'
  ) {
    return <Navigate to="/enroll" replace />;
  }

  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
