import * as Y from 'yjs';

/**
 * Card descriptions are Y.XmlFragments in the ProseMirror shape TipTap's
 * Collaboration extension uses (paragraph / heading / bulletList... elements
 * wrapping Y.XmlText). These helpers convert to and from plain text for the
 * server side (search index, AI context, AI-created cards).
 */

const BLOCK_SEPARATOR = '\n';

export function fragmentToText(fragment: Y.XmlFragment | Y.XmlElement): string {
  const parts: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment) => {
    if (node instanceof Y.XmlText) {
      const text = node
        .toDelta()
        .map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : ''))
        .join('');
      parts.push(text);
      return;
    }
    const children = node.toArray() as Array<Y.XmlElement | Y.XmlText>;
    const isListItem = node instanceof Y.XmlElement && node.nodeName === 'listItem';
    if (isListItem) parts.push('- ');
    children.forEach((child) => {
      walk(child);
      if (child instanceof Y.XmlElement) parts.push(BLOCK_SEPARATOR);
    });
  };
  walk(fragment);
  // Nested blocks (listItem > paragraph) emit consecutive separators.
  return parts
    .join('')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Replaces the fragment's content with one paragraph per line of `text`. */
export function setFragmentText(fragment: Y.XmlFragment, text: string): void {
  if (fragment.length > 0) fragment.delete(0, fragment.length);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const paragraphs = lines.map((line) => {
    const p = new Y.XmlElement('paragraph');
    // Always give the paragraph a text node, even when empty. Otherwise two
    // people typing into the same empty paragraph each create a sibling
    // Y.XmlText; ProseMirror merges adjacent text into one node and
    // y-prosemirror's re-diff then duplicates a character. With one shared
    // Y.XmlText, concurrent keystrokes interleave character by character.
    p.insert(0, [new Y.XmlText(line)]);
    return p;
  });
  fragment.insert(0, paragraphs);
}
