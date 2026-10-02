import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { Role } from '@huddle/shared';
import { Button, ErrorBanner, Spinner, buttonClass } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { qk } from '../lib/queries';
import { RoleBadge } from './HomePage';

interface InvitePreview {
  workspaceId: string;
  workspaceName: string;
  inviterName: string | null;
  role: Role;
  expiresAt: string;
  valid: boolean;
  problem: string | null;
}

export function InvitePage() {
  const { token = '' } = useParams();
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () =>
      api<{ invite: InvitePreview }>(`/api/invites/${encodeURIComponent(token)}`, {
        anonymous: true,
      }),
    select: (d) => d.invite,
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () =>
      api<{ workspaceId: string }>(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      navigate(`/w/${res.workspaceId}`, { replace: true });
    },
  });

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
        <img src="/favicon.svg" alt="" className="mx-auto size-10" />
        {preview.isPending ? (
          <div className="mt-6 flex justify-center">
            <Spinner />
          </div>
        ) : preview.error ? (
          <div className="mt-6">
            <ErrorBanner error={preview.error} />
          </div>
        ) : (
          <>
            <h1 className="mt-4 text-xl font-bold">Join {preview.data.workspaceName}</h1>
            <p className="mt-2 text-sm text-slate-500">
              {preview.data.inviterName ?? 'Someone'} invited you as{' '}
              <RoleBadge role={preview.data.role} />
            </p>
            {!preview.data.valid ? (
              <div className="mt-6">
                <ErrorBanner error={preview.data.problem} />
              </div>
            ) : auth.status === 'authenticated' ? (
              <div className="mt-6 space-y-3">
                <ErrorBanner error={accept.error} />
                <Button
                  className="w-full"
                  onClick={() => accept.mutate()}
                  disabled={accept.isPending}
                >
                  {accept.isPending ? 'Joining…' : `Join as ${auth.user.name}`}
                </Button>
              </div>
            ) : auth.status === 'anonymous' ? (
              <div className="mt-6 flex justify-center gap-2">
                <Link to="/login" state={{ from: location.pathname }} className={buttonClass()}>
                  Sign in to join
                </Link>
                <Link
                  to="/signup"
                  state={{ from: location.pathname }}
                  className={buttonClass('secondary')}
                >
                  Create account
                </Link>
              </div>
            ) : (
              <div className="mt-6 flex justify-center">
                <Spinner />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
