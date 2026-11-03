import * as Y from 'yjs';
import { BOARD_SCHEMA_VERSION, boardRoots } from './model';
import { orderKeyAt } from './order';

const SEED_CLIENT_ID = 1;
const DEFAULT_COLUMNS = ['To do', 'In progress', 'Done'];

/**
 * The initial state of a new board, as a Yjs update.
 *
 * It is fully deterministic (fixed clientID, ids derived from the board id,
 * no timestamps), so applying it twice, or on two servers at once, produces
 * the exact same structs and Yjs de-duplicates them: a board can never end up
 * with two sets of default columns.
 */
export function createSeedUpdate(boardId: string, columnTitles = DEFAULT_COLUMNS): Uint8Array {
  const doc = new Y.Doc({ gc: true });
  doc.clientID = SEED_CLIENT_ID;
  const { meta, columns } = boardRoots(doc);
  doc.transact(() => {
    meta.set('schemaVersion', BOARD_SCHEMA_VERSION);
    const placed: { id: string; order: string }[] = [];
    columnTitles.forEach((title, i) => {
      const id = `${boardId}:col${i}`;
      const order = orderKeyAt(placed, placed.length);
      const col = new Y.Map<unknown>();
      col.set('id', id);
      col.set('title', title);
      col.set('order', order);
      col.set('createdAt', 0);
      columns.set(id, col);
      placed.push({ id, order });
    });
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
