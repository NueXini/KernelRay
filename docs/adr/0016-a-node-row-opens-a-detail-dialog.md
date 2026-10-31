# 0016 — A node row opens a detail dialog; its Apply button switches

Status: accepted (amends [ADR 0007](0007-one-tap-switches-the-node.md)'s one-tap rule; leaves
[ADR 0012](0012-import-applies-the-first-node-when-nothing-is-applied.md)'s import exception in
place)

## Context

ADR 0007 made tapping a row both the selection and the apply gesture, because the list replaced
a single-node page and a separate Apply button would have made the common action three steps.
The list now has a second job the single-node page never had: users want to inspect a node's
fields and copy its share link before committing, and the one-tap gesture leaves no room for
either. Applying also restarts a running core, so a mis-tap costs every live connection.

## Decision

**Tapping a node row outside edit mode opens a read-only 节点详情弹窗.** Opening it writes
nothing: not `state.selected`, not `outbound.json`, and not the core. The dialog shows the
node's fields, its 节点链接, the applied/selected/changed state, and an Apply button.

**The Apply button is the 切换节点 gesture.** It runs the same `selected` → `outbound.meta` →
`outbound.json` → `kernelray.sh apply` sequence ADR 0007 defined, including the atomic
test/swap/rollback path. The button is a small state machine: 应用 for a normal node, 重试应用
for a selected-but-unapplied node (a failed switch), 重新应用 for an applied node whose fields
changed (`dirty`), and 应用 for an applied clean node — the last one only re-syncs `selected`
and never restarts the core, preserving the old recovery gesture after a failed switch.

**The dialog owns the copy actions.** 复制链接 copies the canonical link derived from the node
fields; the caret menu also copies the Base64 encoding of that whole link, which is the
one-line subscription form. The link is derived, not stored, so it always matches what the
module would render. Base64 is an encoding, not encryption; the menu labels it as the
subscription format.

**Nothing else moves.** Edit mode still toggles checkboxes, the row's ✕ still deletes, and the
delete gate is unchanged. The import into a store with no applied node still applies a node
without the dialog (ADR 0012): it is the one apply path a user did not reach by tapping a row.

## Consequences

- Switching costs one extra tap. That is the price of inspecting/copying before a core restart,
  and the dialog is also the place a failed switch is retried from.
- The applied node's dialog is useful even though Apply does no core work: it is where the link
  is copied and where a failed switch's pointer is repaired.
- The canonical link can differ from the text originally pasted: the parser drops fields the
  module does not use, and the copy reflects the node store. That is deliberate — a copied link
  should describe the node the module actually runs, not a field it ignores.
- The dialog's credentials are visible in full (the user chose that), so every field is written
  with `textContent`, never `innerHTML`; the row and dialog share the same rule.
- The copy fallback is `navigator.clipboard` → a temporary textarea + `execCommand`, because a
  WebView is not guaranteed to expose the async Clipboard API. It needs a device check.

## Rejected alternatives

- **Keep one-tap and add a separate details/copy button per row.** Two targets in a small row,
  and the applied row would still have no place for its link.
- **Make the dialog a pure confirmation with no copy.** It would add the tap without paying for
  it; the copy surface is why the dialog exists.
- **Store the original link and copy it verbatim.** It duplicates credentials in `state.json`
  and can reproduce parameters the module never honours. The node fields are the model; the
  link is derived from them.
- **Disable Apply on an applied clean node.** It looks safer, but it removes the only way to
  re-sync `selected` after a failed switch without re-applying the attempted node.
