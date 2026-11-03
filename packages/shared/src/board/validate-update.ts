import * as Y from 'yjs';
import { z } from 'zod';

/**
 * Validates an incoming Yjs update at the WebSocket boundary WITHOUT applying
 * it. A CRDT update cannot be "partially rejected" after it is merged (that
 * would fork replicas), so the only safe place to say no is before apply.
 *
 * Y.decodeUpdate exposes every struct in the update. Map entries carry their
 * key (`parentSub`), so each field the board schema knows about is checked
 * against a Zod schema; unknown keys may only hold nested Y types or `true`
 * (CRDT set membership, e.g. assignees). Binary blobs and subdocuments are
 * never part of the schema and are rejected outright.
 *
 * This is a shape/size gate, not business logic: it stops a hostile client
 * from writing a 50 MB title or a malformed `pos` that would crash readers.
 */

export const MAX_UPDATE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHUNK = 20_000;

const orderKey = z.string().min(1).max(256);
const shortId = z.string().min(1).max(128);

const fieldSchemas: Record<string, z.ZodType> = {
  id: shortId,
  title: z.string().max(500),
  order: orderKey,
  pos: z.object({ columnId: shortId, order: orderKey }).strict(),
  dueDate: z.iso.date().nullable(),
  text: z.string().max(1000),
  done: z.boolean(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  createdBy: shortId.nullable(),
  updatedBy: shortId.nullable(),
  schemaVersion: z.number().int().positive(),
};

/** Keys whose value must be a nested shared type (Y.Map / Y.XmlFragment). */
const typeFields = new Set(['description', 'assignees', 'labels', 'checklist']);

export type UpdateValidation = { ok: true } | { ok: false; reason: string };

function isSmallPrimitive(v: unknown): boolean {
  return (
    v === null ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.length <= 256)
  );
}

const idKey = (id: Y.ID) => `${id.client}:${id.clock}`;

/**
 * When a map key is overwritten, Yjs does not encode `parentSub` (it is
 * implied by the item's left origin, the previous value). Resolve it from
 * earlier structs in this update, or from the server's current document.
 * Returns undefined when it cannot be resolved.
 */
function makeKeyResolver(structs: Array<Y.Item | Y.GC | Y.Skip>, doc?: Y.Doc) {
  const byId = new Map<string, Y.Item>();
  for (const s of structs) if (s instanceof Y.Item) byId.set(idKey(s.id), s);
  const memo = new Map<Y.Item, string | null | undefined>();

  const resolve = (item: Y.Item, depth = 0): string | null | undefined => {
    if (memo.has(item)) return memo.get(item);
    let result: string | null | undefined;
    const ref = item.origin ?? item.rightOrigin;
    if (item.parentSub !== null || ref === null) {
      result = item.parentSub; // explicitly encoded (null = array/text content)
    } else {
      const local = byId.get(idKey(ref));
      if (local && depth < 1000) {
        result = resolve(local, depth + 1);
      } else if (doc) {
        try {
          result = (Y.getItem(doc.store, ref) as Y.Item).parentSub;
        } catch {
          result = undefined;
        }
      }
    }
    memo.set(item, result);
    return result;
  };
  return resolve;
}

/**
 * @param doc the document the update will be applied to; needed to resolve
 *   overwritten map keys. Without it, unresolvable entries get the strictest
 *   rule (small primitives or nested types only).
 */
export function validateBoardUpdate(update: Uint8Array, doc?: Y.Doc): UpdateValidation {
  if (update.byteLength > MAX_UPDATE_BYTES) {
    return { ok: false, reason: `update too large (${update.byteLength} bytes)` };
  }
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return { ok: false, reason: 'malformed update' };
  }

  const resolveKey = makeKeyResolver(decoded.structs, doc);

  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) continue; // GC / Skip carry no content
    const { content } = struct;

    if (content instanceof Y.ContentBinary || content instanceof Y.ContentDoc) {
      return { ok: false, reason: 'binary content and subdocuments are not allowed' };
    }
    if (content instanceof Y.ContentString && content.str.length > MAX_TEXT_CHUNK) {
      return { ok: false, reason: 'text chunk too large' };
    }
    if (content instanceof Y.ContentEmbed || content instanceof Y.ContentFormat) {
      const size = JSON.stringify(
        content instanceof Y.ContentEmbed ? content.embed : content.value,
      ).length;
      if (size > 2000) return { ok: false, reason: 'embed/format too large' };
    }

    const isType = content instanceof Y.ContentType;
    const values = content instanceof Y.ContentAny ? content.arr : null;
    const parentSub = resolveKey(struct);

    if (parentSub === null) continue; // array / text content (rich text body)
    if (parentSub === undefined) {
      // Unresolvable: allow only what any key could legitimately hold.
      if (isType || content instanceof Y.ContentDeleted) continue;
      if (values && values.every(isSmallPrimitive)) continue;
      if (content instanceof Y.ContentString || content instanceof Y.ContentFormat) continue;
      return { ok: false, reason: 'unresolvable map entry' };
    }
    if (parentSub.length > 128) return { ok: false, reason: 'map key too long' };

    if (typeFields.has(parentSub)) {
      if (!isType) return { ok: false, reason: `"${parentSub}" must be a shared type` };
      continue;
    }
    const schema = fieldSchemas[parentSub];
    if (schema) {
      if (!values || values.length !== 1) {
        return { ok: false, reason: `"${parentSub}" must be a plain value` };
      }
      const parsed = schema.safeParse(values[0]);
      if (!parsed.success) {
        return { ok: false, reason: `invalid "${parentSub}": ${parsed.error.issues[0]?.message}` };
      }
      continue;
    }
    // Unknown key: an id-keyed nested type (cards, columns, checklist items),
    // a set member (assignee id / label -> true), or a rich-text node
    // attribute (heading level, list start) which must be a small primitive.
    if (isType) continue;
    if (content instanceof Y.ContentDeleted) continue;
    if (values && values.length === 1 && isSmallPrimitive(values[0])) continue;
    return { ok: false, reason: `unexpected value for key "${parentSub.slice(0, 40)}"` };
  }
  return { ok: true };
}
