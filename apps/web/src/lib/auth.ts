import { useSyncExternalStore } from 'react';
import { authStore } from './api';

export function useAuth() {
  return useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
}

export function useCurrentUser() {
  const auth = useAuth();
  if (auth.status !== 'authenticated')
    throw new Error('useCurrentUser outside an authenticated route');
  return auth.user;
}
