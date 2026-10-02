import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import type { PresenceUser } from '@huddle/shared';

/**
 * Rich-text description bound directly to the card's Y.XmlFragment, so
 * concurrent typing merges character by character. Undo/redo comes from the
 * Collaboration extension (Yjs UndoManager: only undoes *your* changes), so
 * StarterKit's own history is disabled.
 */
export function DescriptionEditor({
  fragment,
  provider,
  user,
  editable,
}: {
  fragment: Y.XmlFragment;
  provider: HocuspocusProvider;
  user: PresenceUser;
  editable: boolean;
}) {
  const editor = useEditor(
    {
      editable,
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Placeholder.configure({ placeholder: editable ? 'Add a description…' : 'No description' }),
        Collaboration.configure({ fragment }),
        CollaborationCaret.configure({ provider, user }),
      ],
      editorProps: {
        attributes: {
          class:
            'prose-sm min-h-24 rounded-md px-3 py-2 text-sm ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:font-semibold [&_p]:my-1',
          'aria-label': 'Card description',
          'data-testid': 'description-editor',
        },
      },
    },
    [fragment, editable],
  );
  return <EditorContent editor={editor} />;
}
