import { useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { logout, logoutEverywhere } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, Spinner } from './ui';

export function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Restoring session" />
      </div>
    );
  }
  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

export function AppHeader({ children }: { children?: ReactNode }) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  if (auth.status !== 'authenticated') return null;
  const { user } = auth;
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-slate-200 bg-white/90 px-4 backdrop-blur">
      <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
        <img src="/favicon.svg" alt="" className="size-7" />
        Huddle
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      <div className="relative">
        <button
          className="flex items-center gap-2 rounded-full p-0.5 hover:bg-slate-100"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
        >
          <Avatar id={user.id} name={user.name} />
        </button>
        {open ? (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-56 rounded-lg bg-white py-1 text-sm shadow-lg ring-1 ring-slate-200"
            onMouseLeave={() => setOpen(false)}
          >
            <div className="border-b border-slate-100 px-3 py-2">
              <div className="font-medium">{user.name}</div>
              <div className="truncate text-xs text-slate-500">{user.email}</div>
            </div>
            <button
              role="menuitem"
              className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              onClick={() => void logout()}
            >
              Log out
            </button>
            <button
              role="menuitem"
              className="block w-full px-3 py-2 text-left text-rose-600 hover:bg-rose-50"
              onClick={() => void logoutEverywhere()}
            >
              Log out everywhere
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
