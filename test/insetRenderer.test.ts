import assert from "node:assert/strict";
import test from "node:test";
import { InsetOwnership } from "../src/insetOwnership";
import { renderDeletedBlockHtml } from "../src/insetRenderer";

void test("renders script-free escaped HTML with the required CSP", () => {
  const html = renderDeletedBlockHtml(
    {
      afterLine: -1,
      originalStartLine: 1,
      lines: ['<script>alert("x")</script>', "&\t'"]
    },
    { fontSize: 14, tabSize: 8 }
  );
  assert.match(
    html,
    /default-src 'none'; style-src 'unsafe-inline'/u
  );
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/u);
  assert.match(html, /&amp;\t&#39;/u);
  assert.match(html, /tab-size:8/u);
  assert.match(html, /aria-label="Deleted original lines 1 through 2"/u);
});

class Handle {
  public disposed = false;
  public dispose(): void {
    this.disposed = true;
  }
}

void test("transactionally replaces all handles and disposes the old set", () => {
  const owner = new InsetOwnership<object, Handle>();
  const editor = {};
  const old = new Handle();
  owner.replace(editor, (candidate) => candidate.add(old), () => true);
  const next = [new Handle(), new Handle()];
  owner.replace(
    editor,
    (candidate) => {
      for (const handle of next) {
        candidate.add(handle);
      }
    },
    () => true
  );
  assert.equal(old.disposed, true);
  assert.equal(owner.count(editor), 2);
  assert.equal(next.some((handle) => handle.disposed), false);
});

void test("rolls back every candidate on errors and staleness", () => {
  const owner = new InsetOwnership<object, Handle>();
  const editor = {};
  const retained = new Handle();
  owner.replace(editor, (candidate) => candidate.add(retained), () => true);

  const failed = [new Handle(), new Handle()];
  assert.throws(() =>
    owner.replace(
      editor,
      (candidate) => {
        candidate.add(failed[0] as Handle);
        candidate.add(failed[1] as Handle);
        throw new Error("creation failed");
      },
      () => true
    )
  );
  assert.equal(failed.every((handle) => handle.disposed), true);
  assert.equal(retained.disposed, false);

  const stale = new Handle();
  owner.replace(editor, (candidate) => candidate.add(stale), () => false);
  assert.equal(stale.disposed, true);
  assert.equal(retained.disposed, false);
  assert.equal(owner.count(editor), 1);
});
