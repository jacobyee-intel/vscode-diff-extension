export interface DisposableInset {
  dispose(): void;
}

export class InsetOwnership<
  TEditor extends object,
  TInset extends DisposableInset
> {
  private readonly owned = new Map<TEditor, Set<TInset>>();

  public replace(
    editor: TEditor,
    createAll: (candidate: Set<TInset>) => void,
    isCurrent: () => boolean
  ): void {
    const candidate = new Set<TInset>();
    try {
      createAll(candidate);
      if (!isCurrent()) {
        this.disposeSet(candidate);
        return;
      }
      const previous = this.owned.get(editor);
      this.owned.set(editor, candidate);
      if (previous !== undefined) {
        this.disposeSet(previous);
      }
    } catch (error) {
      this.disposeSet(candidate);
      throw error;
    }
  }

  public clearEditor(editor: TEditor): void {
    const handles = this.owned.get(editor);
    if (handles !== undefined) {
      this.owned.delete(editor);
      this.disposeSet(handles);
    }
  }

  public clearWhere(predicate: (editor: TEditor) => boolean): void {
    for (const editor of [...this.owned.keys()]) {
      if (predicate(editor)) {
        this.clearEditor(editor);
      }
    }
  }

  public clearAll(): void {
    this.clearWhere(() => true);
  }

  public count(editor?: TEditor): number {
    if (editor !== undefined) {
      return this.owned.get(editor)?.size ?? 0;
    }
    let total = 0;
    for (const handles of this.owned.values()) {
      total += handles.size;
    }
    return total;
  }

  private disposeSet(handles: ReadonlySet<TInset>): void {
    for (const handle of handles) {
      handle.dispose();
    }
  }
}
