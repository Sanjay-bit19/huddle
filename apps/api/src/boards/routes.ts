import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { boards, workspaces, type DbBoard } from '@huddle/db';
import { createBoardSchema, updateBoardSchema, type BoardDto } from '@huddle/shared';
import type { AppDeps } from '../deps';
import { requireBoardPermission, requireWorkspacePermission } from '../http/access';
import { authOf } from '../http/auth-middleware';
import { parse } from '../http/validate';

export const toBoardDto = (b: DbBoard): BoardDto => ({
  id: b.id,
  workspaceId: b.workspaceId,
  title: b.title,
  description: b.description,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
});

/** Routes nested under /api/workspaces/:workspaceId/boards */
export function workspaceBoardsRouter(deps: AppDeps): Router {
  const { db } = deps;
  const router = Router({ mergeParams: true });
  router.use(deps.requireAuth);

  router.get('/', async (req, res) => {
    const { userId } = authOf(req);
    const params = req.params as { workspaceId?: string };
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      params.workspaceId,
      'board:read',
    );
    const rows = await db
      .select()
      .from(boards)
      .where(eq(boards.workspaceId, workspaceId))
      .orderBy(desc(boards.updatedAt));
    res.json({ boards: rows.map(toBoardDto) });
  });

  router.post('/', async (req, res) => {
    const { userId } = authOf(req);
    const params = req.params as { workspaceId?: string };
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      params.workspaceId,
      'board:create',
    );
    const input = parse(createBoardSchema, req.body);
    const [board] = await db
      .insert(boards)
      .values({ ...input, workspaceId, createdBy: userId })
      .returning();
    res.status(201).json({ board: toBoardDto(board!) });
  });

  return router;
}

/** Routes under /api/boards/:boardId */
export function boardsRouter(deps: AppDeps): Router {
  const { db, events } = deps;
  const router = Router();
  router.use(deps.requireAuth);

  router.get('/:boardId', async (req, res) => {
    const { userId } = authOf(req);
    const access = await requireBoardPermission(db, userId, req.params.boardId, 'board:read');
    const [row] = await db
      .select({ board: boards, workspaceName: workspaces.name })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(eq(boards.id, access.boardId));
    res.json({
      board: toBoardDto(row!.board),
      workspace: { id: access.workspaceId, name: row!.workspaceName },
      role: access.role,
    });
  });

  router.patch('/:boardId', async (req, res) => {
    const { userId } = authOf(req);
    const access = await requireBoardPermission(db, userId, req.params.boardId, 'board:update');
    const input = parse(updateBoardSchema, req.body);
    const [board] = await db
      .update(boards)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(boards.id, access.boardId))
      .returning();
    await events.publish({
      type: 'board-broadcast',
      boardId: access.boardId,
      payload: { kind: 'board-meta-changed' },
    });
    res.json({ board: toBoardDto(board!) });
  });

  router.delete('/:boardId', async (req, res) => {
    const { userId } = authOf(req);
    const access = await requireBoardPermission(db, userId, req.params.boardId, 'board:delete');
    await db.delete(boards).where(eq(boards.id, access.boardId));
    await events.publish({ type: 'board-deleted', boardId: access.boardId });
    res.status(204).end();
  });

  return router;
}
