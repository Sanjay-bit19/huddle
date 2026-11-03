import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { BoardView } from '@huddle/shared/board';
import type { Database } from './client';
import { boards, cardSearch } from './schema';

export type CardHashes = Map<string, string>;

/**
 * Projects a board's cards into card_search. Only rows whose content changed
 * since `previous` are written; cards that no longer exist are deleted.
 * Returns the new hash map for the caller to keep.
 */
export async function syncCardSearch(
  db: Database,
  boardId: string,
  view: BoardView,
  previous?: CardHashes,
): Promise<CardHashes> {
  const [board] = await db
    .select({ workspaceId: boards.workspaceId })
    .from(boards)
    .where(eq(boards.id, boardId));
  if (!board) return new Map();

  const titles = new Map(view.columns.map((c) => [c.id, c.title]));
  const hashes: CardHashes = new Map();
  const changed: Array<typeof cardSearch.$inferInsert> = [];
  for (const card of view.cards) {
    const row = {
      boardId,
      cardId: card.id,
      workspaceId: board.workspaceId,
      title: card.title,
      body: [card.descriptionText, ...card.checklist.map((i) => i.text)].join('\n'),
      labels: card.labels.join(' '),
      columnTitle: titles.get(card.columnId) ?? '',
    };
    const hash = createHash('sha1').update(JSON.stringify(row)).digest('hex');
    hashes.set(card.id, hash);
    if (previous?.get(card.id) !== hash) changed.push({ ...row, updatedAt: new Date() });
  }

  await db.transaction(async (tx) => {
    const ids = [...hashes.keys()];
    await tx
      .delete(cardSearch)
      .where(
        ids.length
          ? and(eq(cardSearch.boardId, boardId), notInArray(cardSearch.cardId, ids))
          : eq(cardSearch.boardId, boardId),
      );
    if (changed.length) {
      await tx
        .insert(cardSearch)
        .values(changed)
        .onConflictDoUpdate({
          target: [cardSearch.boardId, cardSearch.cardId],
          set: {
            title: sql`excluded.title`,
            body: sql`excluded.body`,
            labels: sql`excluded.labels`,
            columnTitle: sql`excluded.column_title`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  });
  return hashes;
}

/**
 * Turns user input into a safe prefix tsquery ("lau pla" -> 'lau':* & 'pla':*)
 * so results appear while typing. Only letters/digits survive, so the input
 * can never inject tsquery operators.
 */
export function toPrefixQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}:*`).join(' & ');
}

export interface SearchHit {
  boardId: string;
  boardTitle: string;
  cardId: string;
  title: string;
  columnTitle: string;
  snippet: string;
  rank: number;
}

export async function searchCards(
  db: Database,
  workspaceId: string,
  query: string,
  limit = 20,
  boardIds?: string[],
): Promise<SearchHit[]> {
  const tsquery = toPrefixQuery(query);
  if (!tsquery) return [];
  const q = sql`to_tsquery('english', ${tsquery})`;
  const rows = await db
    .select({
      boardId: cardSearch.boardId,
      boardTitle: boards.title,
      cardId: cardSearch.cardId,
      title: cardSearch.title,
      columnTitle: cardSearch.columnTitle,
      // ts_headline marks matches with << >>; the client renders them as <mark>.
      snippet: sql<string>`ts_headline('english', ${cardSearch.title} || ' — ' || ${cardSearch.body}, ${q}, 'StartSel=<<,StopSel=>>,MaxWords=20,MinWords=8,MaxFragments=1')`,
      rank: sql<number>`ts_rank(${cardSearch.document}, ${q})`,
    })
    .from(cardSearch)
    .innerJoin(boards, eq(boards.id, cardSearch.boardId))
    .where(
      and(
        eq(cardSearch.workspaceId, workspaceId),
        sql`${cardSearch.document} @@ ${q}`,
        ...(boardIds ? [inArray(cardSearch.boardId, boardIds)] : []),
      ),
    )
    .orderBy(sql`ts_rank(${cardSearch.document}, ${q}) desc`, cardSearch.title)
    .limit(limit);
  return rows.map((r) => ({ ...r, rank: Number(r.rank) }));
}
