import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { AppHeader } from '../components/Layout';
import { Button, ErrorBanner, Input, Spinner } from '../components/ui';
import { useCurrentUser } from '../lib/auth';
import { useCreateWorkspace, useWorkspaces } from '../lib/queries';

const roleBadge: Record<string, string> = {
  ADMIN: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  EDITOR: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  VIEWER: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ring-1 ${roleBadge[role] ?? ''}`}
    >
      {role}
    </span>
  );
}

export function HomePage() {
  const user = useCurrentUser();
  const workspaces = useWorkspaces();
  const create = useCreateWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const res = await create.mutateAsync(name);
    setName('');
    navigate(`/w/${res.workspace.id}`);
  };

  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-10">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hi {user.name.split(' ')[0]} 👋</h1>
          <p className="mt-1 text-sm text-slate-500">Pick a workspace or start a new one.</p>
        </div>

        <form onSubmit={onCreate} className="flex max-w-md gap-2">
          <Input
            aria-label="New workspace name"
            placeholder="New workspace name"
            value={name}
            maxLength={80}
            required
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            Create
          </Button>
        </form>
        <ErrorBanner error={create.error} />

        {workspaces.isPending ? (
          <Spinner />
        ) : workspaces.error ? (
          <ErrorBanner error={workspaces.error} />
        ) : workspaces.data.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-slate-200 p-10 text-center text-sm text-slate-500">
            No workspaces yet. Create one above, or open an invite link from a teammate.
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.data.map((ws) => (
              <li key={ws.id}>
                <Link
                  to={`/w/${ws.id}`}
                  className="block rounded-xl bg-white p-5 shadow-xs ring-1 ring-slate-200 transition hover:shadow-md hover:ring-indigo-300"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold">{ws.name}</h2>
                    <RoleBadge role={ws.role} />
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    {ws.boardCount} {ws.boardCount === 1 ? 'board' : 'boards'} · {ws.memberCount}{' '}
                    {ws.memberCount === 1 ? 'member' : 'members'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
