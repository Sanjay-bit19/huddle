import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { RequireAuth } from './components/Layout';
import { refreshSession } from './lib/api';
import { useAuth } from './lib/auth';
import { LoginPage, SignupPage } from './pages/AuthPages';
import { HomePage } from './pages/HomePage';

function AnonymousOnly({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  if (auth.status === 'authenticated') return <Navigate to="/" replace />;
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
      <Route element={<RequireAuth />}>
        <Route path="/" element={<HomePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
