import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { RequireAuth } from './components/Layout';
import { refreshSession } from './lib/api';
import { useAuth } from './lib/auth';
import { LoginPage, SignupPage } from './pages/AuthPages';
import { HomePage } from './pages/HomePage';
import { InvitePage } from './pages/InvitePage';
import { WorkspacePage } from './pages/WorkspacePage';

function AnonymousOnly({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from?.startsWith('/') ? from : '/'} replace />;
  }
  return <>{children}</>;
}

export function App() {
  // Restore the session from the refresh cookie on first load.
  useEffect(() => {
    void refreshSession();
  }, []);

  return (
    <Routes>
      <Route
        path="/login"
        element={
          <AnonymousOnly>
            <LoginPage />
          </AnonymousOnly>
        }
      />
      <Route
        path="/signup"
        element={
          <AnonymousOnly>
            <SignupPage />
          </AnonymousOnly>
        }
      />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/w/:workspaceId" element={<WorkspacePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
