import { Router } from 'express';
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import {
  activityEvents,
  comments,
  getBoardAccess,
  loadBoardDoc,
  searchCards,
  users,
} from '@huddle/db';
import { canDeleteComment } from '@huddle/shared';
import { boardRoots } from '@huddle/shared/board';
import type { AppDeps } from '../deps';
import { parseId, requireBoardPermission, requireWorkspacePermission } from '../http/access';
import { authOf } from '../http/auth-middleware';
import { forbidden, notFound } from '../http/errors';
import { parse } from '../http/validate';

const cardIdSchema = z.string().min(1).max(128);
const createCommentSchema = z.object({ body: z.string().trim().min(1).max(4000) });
const activityQuerySchema = z.object({
  cardId: cardIdSchema.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  boardId: z.uuid().optional(),
});

export interface ActivityDto {
  id: number;
  type: string;
  cardId: string | null;
  data: Record<string, string | null>;
  actor: { id: string; name: string } | null;
  createdAt: string;
}

export interface CommentDto {
  id: string;
  cardId: string;
  body: string;
  author: { id: string; name: string } | null;
  createdAt: string;
}

/** Activity log, comments and search: the Postgres-backed side of a board. */
export function boardCollabRouter(deps: AppDeps): Router {
  const { db, events } = deps;
  const router = Router();
  router.use(deps.requireAuth);

  router.get('/boards/:boardId/activity', async (req, res) => {
    const { userId } = authOf(req);
    const access = await requireBoardPermission(db, userId, req.params.boardId, 'activity:read');
    const q = parse(activityQuerySchema, req.query);
    const rows = await db
      .select({ event: activityEvents, actorName: users.name })
      .from(activityEvents)
      .leftJoin(users, eq(users.id, activityEvents.actorId))
      .where(
        and(
          eq(activityEvents.boardId, access.boardId),
          q.cardId ? eq(activityEvents.cardId, q.cardId) : undefined,
          q.before ? lt(activityEvents.id, q.before) : undefined,
        ),
      )
      .orderBy(desc(activityEvents.id))
      .limit(q.limit);
    const items: ActivityDto[] = rows.map(({ event, actorName }) => ({
      id: event.id,
      type: event.type,
      cardId: event.cardId,
      data: event.data,
      actor: event.actorId ? { id: event.actorId, name: actorName ?? 'Former member' } : null,
      createdAt: event.createdAt.toISOString(),
    }));
    // Keyset pagination: pass the last id as ?before= for the next page.
    res.json({ items, nextBefore: items.length === q.limit ? items.at(-1)!.id : null });
  });

  router.get('/boards/:boardId/cards/:cardId/comments', async (req, res) => {
    const { userId } = authOf(req);
    const access = await requireBoardPermission(db, userId, req.params.boardId, 'comment:read');
    const cardId = parse(cardIdSchema, req.params.cardId);
    const rows = await db
      .select({ comment: comments, authorName: users.name })
      .from(comments)
      .leftJoin(users, eq(users.id, comments.authorId))
      .where(
        and(
          eq(comments.boardId, access.boardId),
          eq(comments.cardId, cardId),
          isNull(comments.deletedAt),
        ),
      )
      .orderBy(asc(comments.createdAt));
    const body: CommentDto[] = rows.map(({ comment, authorName }) => ({
      id: comment.id,
      cardId: comment.cardId,
      body: comment.body,
      author: comment.authorId
        ? { id: comment.authorId, name: authorName ?? 'Former member' }
        : null,
      createdAt: comment.createdAt.toISOString(),
    }));
    res.json({ comments: body });
  });

  router.post('/boards/:boardId/cards/:cardId/comments', async (req, res) => {
    const { userId, name } = authOf(req);
    const access = await requireBoardPermission(db, userId, req.params.boardId, 'comment:create');
    const cardId = parse(cardIdSchema, req.params.cardId);
    const { body } = parse(createCommentSchema, req.body);
    // The card must exist on this board (ids are client-generated, so check).
    const doc = await loadBoardDoc(db, access.boardId);
    const card = boardRoots(doc).cards.get(cardId);
    const cardTitle = typeof card?.get('title') === 'string' ? (card.get('title') as string) : '';
    doc.destroy();
    if (!card) throw notFound('Card not found');

    const comment = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(comments)
        .values({ boardId: access.boardId, cardId, authorId: userId, body })
        .returning();
      await tx.insert(activityEvents).values({
        boardId: access.boardId,
        actorId: userId,
        type: 'comment.added',
        cardId,
        data: { title: cardTitle },
      });
      return row!;
    });
    await events.publish({
      type: 'board-broadcast',
      boardId: access.boardId,
      payload: { kind: 'comments-changed', cardId },
    });
    await events.publish({
      type: 'board-broadcast',
      boardId: access.boardId,
      payload: { kind: 'activity' },
    });
    const dto: CommentDto = {
      id: comment.id,
      cardId,
      body: comment.body,
      author: { id: userId, name },
      createdAt: comment.createdAt.toISOString(),
    };
    res.status(201).json({ comment: dto });
  });

  router.delete('/boards/:boardId/comments/:commentId', async (req, res) => {
    const { userId } = authOf(req);
    const boardId = parseId(req.params.boardId, 'Board');
    const commentId = parseId(req.params.commentId, 'Comment');
    const access = await getBoardAccess(db, userId, boardId);
    if (!access?.role) throw notFound('Board not found');
    const [comment] = await db
      .select()
      .from(comments)
      .where(
        and(eq(comments.id, commentId), eq(comments.boardId, boardId), isNull(comments.deletedAt)),
      );
    if (!comment) throw notFound('Comment not found');
    if (
      !canDeleteComment({ actorId: userId, actorRole: access.role, authorId: comment.authorId })
    ) {
      throw forbidden('Only the author or an admin can delete this comment');
    }
    await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
    await events.publish({
      type: 'board-broadcast',
      boardId,
      payload: { kind: 'comments-changed', cardId: comment.cardId },
    });
    res.status(204).end();
  });

  router.get('/workspaces/:workspaceId/search', async (req, res) => {
    const { userId } = authOf(req);
    const { workspaceId } = await requireWorkspacePermission(
      db,
      userId,
      req.params.workspaceId,
      'search:query',
    );
    const { q, boardId } = parse(searchQuerySchema, req.query);
    const hits = await searchCards(db, workspaceId, q, 20, boardId ? [boardId] : undefined);
    res.json({ hits });
  });

  return router;
}
