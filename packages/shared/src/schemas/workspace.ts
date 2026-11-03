import { z } from 'zod';
import { ROLES } from '../permissions';

export const roleSchema = z.enum(ROLES);
export const uuidParam = z.uuid();

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
});
export const updateWorkspaceSchema = createWorkspaceSchema;

export const updateMemberSchema = z.object({ role: roleSchema });

export const createInviteSchema = z.object({
  role: roleSchema.default('EDITOR'),
  /** 1 hour .. 30 days. Invite links are bearer secrets, so they must expire. */
  expiresInHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
  /** null = unlimited uses until expiry. */
  maxUses: z.coerce.number().int().min(1).max(1000).nullable().default(null),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const createBoardSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120),
  description: z.string().trim().max(2000).default(''),
});
export const updateBoardSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: z.infer<typeof roleSchema>;
  memberCount: number;
  boardCount: number;
  createdAt: string;
}

export interface MemberDto {
  userId: string;
  name: string;
  email: string;
  role: z.infer<typeof roleSchema>;
  joinedAt: string;
}

export interface InviteDto {
  id: string;
  role: z.infer<typeof roleSchema>;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
  createdBy: string | null;
}

export interface BoardDto {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}
