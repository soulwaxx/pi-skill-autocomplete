import assert from "node:assert/strict";
import { Editor } from "@earendil-works/pi-tui";

const tui = { requestRender() {} };
const theme = { borderColor: (text) => text, selectList: {} };
const enter = "\r";
function type(editor, text) {
  for (const character of text) editor.handleInput(character);
}
function paste(editor, text) {
  editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

async function rejectWithNewerEditorContent({ newer }) {
  const editor = new Editor(tui, theme);
  let submittedText;
  let finish;
  const rejected = new Promise((resolve) => { finish = resolve; });
  editor.onSubmit = async (text) => {
    submittedText = text;
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Same public TUI API operation used by the probe extension's recovery plan:
    // pasteToEditor() routes through Editor.handleInput's bracketed-paste handler.
    paste(editor, text);
    finish();
  };
  type(editor, "draft @disposable-image.png [[skill:missing]] ");
  paste(editor, "ORIGINAL_PASTE_TEXT");
  editor.handleInput(enter);
  assert.equal(editor.getExpandedText(), "", "real editor clears its buffer before onSubmit completes");
  if (newer === "type-delete") {
    type(editor, "x");
    editor.handleInput("\x7f");
  } else {
    type(editor, "NEWER_TYPED_TEXT ");
    paste(editor, "NEWER_PASTE_TEXT");
  }
  await rejected;
  assert.ok(submittedText.includes("ORIGINAL_PASTE_TEXT"), "submit callback receives expanded original paste content");
  const restored = editor.getExpandedText();
  assert.ok(restored.includes("draft @disposable-image.png [[skill:missing]]"));
  assert.ok(restored.includes("ORIGINAL_PASTE_TEXT"));
  if (newer !== "type-delete") {
    assert.ok(restored.includes("NEWER_TYPED_TEXT"), "paste recovery overwrote typed edits");
    assert.ok(restored.includes("NEWER_PASTE_TEXT"), "paste recovery overwrote newer paste data");
  }
  assert.ok(restored.includes("@disposable-image.png"), "clipboard image path text survives rejection and resubmission draft recovery");
  return { submittedText, restored };
}

const withNewer = await rejectWithNewerEditorContent({ newer: "newer" });
const afterDelete = await rejectWithNewerEditorContent({ newer: "type-delete" });
console.log(`PASS real Pi Editor submit/paste behavior: ${JSON.stringify(withNewer.restored)}`);
console.log(`PASS type-then-delete recovery: ${JSON.stringify(afterDelete.restored)}`);
