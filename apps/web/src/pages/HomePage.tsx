import { AppHeader } from '../components/Layout';
import { useCurrentUser } from '../lib/auth';

export function HomePage() {
  const user = useCurrentUser();
  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-2xl font-bold">Welcome, {user.name}</h1>
      </main>
    </div>
  );
}
