# Outliner

A single-page outliner: a tree of editable lines with keyboard-driven structure editing,
inline references between lines, and backlinks. The store is an append-only operation log;
the web experience is one rich inline-HTML single-page app. This spec deliberately makes the
web experience large enough that its module exceeds one bounded generation call.

## Outliner Store

- The service must persist the outline as an append-only log of operations; each operation has a
  monotonically increasing seq and a payload
- Users must append an operation (POST) and receive the assigned seq
- Users must list all operations in seq order (GET), optionally since a given seq
- An operation's type must be one of: set-content, split, join, indent, dedent, move, set-collapse,
  create-reference, add-existing, retire
- The store must never modify or remove a logged operation — history is immutable
- An invalid operation type or a missing payload must be rejected with a validation error
- The current outline is the fold of the log: applying every operation in seq order yields the node tree

## Web Experience

- The page must render the full outline as a nested tree of lines at GET /, as one self-contained
  HTML document with all CSS and JavaScript inline
- Each line must show a bullet, its text, a collapse caret when it has children, and a backlink count
- The page must load the outline by fetching the store's operations and folding them in the browser
- Pressing Enter must split the current line at the caret and append a split operation
- Pressing Tab must indent the current line under its previous sibling and append an indent operation
- Pressing Shift-Tab must dedent the current line and append a dedent operation
- Pressing Backspace at the start of a line must join it with the previous line and append a join operation
- Backspace on an empty line must retire that line and append a retire operation
- Pressing Shift-Enter must insert a sibling line below the current one
- The Up and Down arrow keys must move the caret between lines, preserving the horizontal position
- Clicking a collapse caret must toggle the subtree and append a set-collapse operation; collapsed
  subtrees must hide their descendants
- Typing @ must open an inline picker listing existing lines filtered by the text after the @
- Choosing a line in the picker on a line that already has text must insert an inline reference to the
  chosen line and append a create-reference operation
- Choosing a line in the picker on an empty line must place the chosen line as a child here and append an
  add-existing operation, without duplicating the line
- The picker must refuse a choice that would create a cycle (placing an ancestor under its own descendant)
- An inline reference must render as the referenced line's text and link to it
- A backlinks panel must list every line that references the focused line, and update as references change
- Edits to a line's text must be debounced and appended as a set-content operation
- The page must show a non-blocking hint when the store cannot be reached, and keep local edits
- The outline must remain responsive with at least 500 lines: rendering and keyboard handling must not
  freeze the page
- Keyboard focus must be visible at all times, and every interactive control must be reachable by keyboard
