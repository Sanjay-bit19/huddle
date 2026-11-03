import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, ROLES, type Role } from '@huddle/shared';
import { AppHeader } from '../components/Layout';
import { SearchBox } from '../components/SearchBox';
import { Avatar, Button, ErrorBanner, Field, Input, Modal, Spinner } from '../components/ui';
import { useCurrentUser } from '../lib/auth';
import {
  useBoards,
  useCreateBoard,
  useCreateInvite,
  useDeleteBoard,
  useInvites,
  useMembers,
  useRemoveMember,
  useRevokeInvite,
  useUpdateMember,
  useWorkspace,
} from '../lib/queries';
import { RoleBadge } from './HomePage';

type Tab = 'boards' | 'members' | 'invites';

export function WorkspacePage() {
  const { workspaceId = '' } = useParams();
  const workspace = useWorkspace(workspaceId);
  const [tab, setTab] = useState<Tab>('boards');

  if (workspace.isPending) {
    return (
      <div className="min-h-full">
        <AppHeader />
        <div className="p-10">
          <Spinner />
        </div>
      </div>
    );
  }
  if (workspace.error) {
    return (
      <div className="min-h-full">
        <AppHeader />
        <div className="mx-auto max-w-5xl p-10">
          <ErrorBanner error={workspace.error} />
        </div>
      </div>
    );
  }
  const role = workspace.data.role;
  const tabs: Tab[] = can(role, 'invite:manage')
    ? ['boards', 'members', 'invites']
    : ['boards', 'members'];

  return (
    <div className="min-h-full">
      <AppHeader>
        <span className="text-slate-300">/</span>
        <span className="truncate font-medium">{workspace.data.name}</span>
        <RoleBadge role={role} />
        <div className="ml-auto w-72">
          <SearchBox workspaceId={workspaceId} />
        </div>
      </AppHeader>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div role="tablist" className="mb-6 flex gap-1 border-b border-slate-200">
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize ${
                tab === t
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {tab === 'boards' ? <BoardsTab workspaceId={workspaceId} role={role} /> : null}
        {tab === 'members' ? <MembersTab workspaceId={workspaceId} role={role} /> : null}
        {tab === 'invites' ? <InvitesTab workspaceId={workspaceId} /> : null}
      </main>
    </div>
  );
}

function BoardsTab({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const boards = useBoards(workspaceId);
  const create = useCreateBoard(workspaceId);
  const remove = useDeleteBoard(workspaceId);
  const navigate = useNavigate();
  const [title, setTitle] = useState('');

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const res = await create.mutateAsync({ title });
    setTitle('');
    navigate(`/b/${res.board.id}`);
  };

  return (
    <section className="space-y-6">
      {can(role, 'board:create') ? (
        <form onSubmit={onCreate} className="flex max-w-md gap-2">
          <Input
            aria-label="New board title"
            placeholder="New board title"
            value={title}
            maxLength={120}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button type="submit" disabled={create.isPending || !title.trim()}>
            Create board
          </Button>
        </form>
      ) : null}
      <ErrorBanner error={create.error ?? remove.error} />
      {boards.isPending ? (
        <Spinner />
      ) : boards.error ? (
        <ErrorBanner error={boards.error} />
      ) : boards.data.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-slate-200 p-10 text-center text-sm text-slate-500">
          No boards yet.
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {boards.data.map((b) => (
            <li key={b.id} className="group relative">
              <Link
                to={`/b/${b.id}`}
                className="block h-full rounded-xl bg-white p-5 shadow-xs ring-1 ring-slate-200 transition hover:shadow-md hover:ring-indigo-300"
              >
                <h3 className="font-semibold">{b.title}</h3>
                {b.description ? (
                  <p className="mt-1 line-clamp-2 text-sm text-slate-500">{b.description}</p>
                ) : null}
                <p className="mt-3 text-xs text-slate-400">
                  Updated {new Date(b.updatedAt).toLocaleDateString()}
                </p>
              </Link>
              {can(role, 'board:delete') ? (
                <button
                  className="absolute top-3 right-3 hidden rounded p-1 text-xs text-slate-400 group-hover:block hover:bg-rose-50 hover:text-rose-600"
                  aria-label={`Delete board ${b.title}`}
                  onClick={() => {
                    if (confirm(`Delete "${b.title}"? This cannot be undone.`)) remove.mutate(b.id);
                  }}
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MembersTab({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const me = useCurrentUser();
  const members = useMembers(workspaceId);
  const update = useUpdateMember(workspaceId);
  const remove = useRemoveMember(workspaceId);
  const navigate = useNavigate();
  const isAdmin = can(role, 'member:manage');

  if (members.isPending) return <Spinner />;
  if (members.error) return <ErrorBanner error={members.error} />;

  return (
    <section className="space-y-3">
      <ErrorBanner error={update.error ?? remove.error} />
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {members.data.map((m) => (
          <li key={m.userId} className="flex items-center gap-3 px-4 py-3">
            <Avatar id={m.userId} name={m.name} size={32} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {m.name} {m.userId === me.id ? <span className="text-slate-400">(you)</span> : null}
              </div>
              <div className="truncate text-xs text-slate-500">{m.email}</div>
            </div>
            {isAdmin ? (
              <select
                aria-label={`Role for ${m.name}`}
                className="rounded-md border-0 py-1 pr-7 pl-2 text-xs ring-1 ring-slate-300"
                value={m.role}
                onChange={(e) => update.mutate({ userId: m.userId, role: e.target.value as Role })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <RoleBadge role={m.role} />
            )}
            {isAdmin || m.userId === me.id ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const self = m.userId === me.id;
                  if (!confirm(self ? 'Leave this workspace?' : `Remove ${m.name}?`)) return;
                  await remove.mutateAsync(m.userId);
                  if (self) navigate('/');
                }}
              >
                {m.userId === me.id ? 'Leave' : 'Remove'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function InvitesTab({ workspaceId }: { workspaceId: string }) {
  const invites = useInvites(workspaceId, true);
  const create = useCreateInvite(workspaceId);
  const revoke = useRevokeInvite(workspaceId);
  const [role, setRole] = useState<Role>('EDITOR');
  const [hours, setHours] = useState(72);
  const [maxUses, setMaxUses] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const res = await create.mutateAsync({
      role,
      expiresInHours: hours,
      maxUses: maxUses ? Number(maxUses) : null,
    });
    // Build the link from our own origin: the token is what matters.
    setCreated(`${window.location.origin}/invite/${res.token}`);
    setCopied(false);
  };

  return (
    <section className="space-y-6">
      <form
        onSubmit={onCreate}
        className="grid gap-4 rounded-xl bg-white p-5 ring-1 ring-slate-200 sm:grid-cols-4 sm:items-end"
      >
        <Field label="Role">
          <select
            className="block w-full rounded-md border-0 py-2 pl-3 text-sm ring-1 ring-slate-300"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field label="Expires in">
          <select
            className="block w-full rounded-md border-0 py-2 pl-3 text-sm ring-1 ring-slate-300"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value={1}>1 hour</option>
            <option value={24}>1 day</option>
            <option value={72}>3 days</option>
            <option value={168}>7 days</option>
            <option value={720}>30 days</option>
          </select>
        </Field>
        <Field label="Max uses">
          <Input
            type="number"
            min={1}
            max={1000}
            placeholder="Unlimited"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          Create invite link
        </Button>
      </form>
      <ErrorBanner error={create.error ?? revoke.error} />

      {created ? (
        <Modal title="Invite link created" onClose={() => setCreated(null)}>
          <p className="mb-3 text-sm text-slate-600">
            Share this link. It is shown only once; we store just a hash of it.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={created}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Invite link"
            />
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(created);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Modal>
      ) : null}

      {invites.isPending ? (
        <Spinner />
      ) : invites.error ? (
        <ErrorBanner error={invites.error} />
      ) : invites.data.length === 0 ? (
        <p className="text-sm text-slate-500">No active invites.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {invites.data.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <RoleBadge role={i.role} />
              <span className="flex-1 text-slate-600">
                Expires {new Date(i.expiresAt).toLocaleString()} · used {i.useCount}
                {i.maxUses ? ` / ${i.maxUses}` : ''}
              </span>
              <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
