// Command-based undo/redo. Each command: { label, do(), undo() }.
export class History {
  constructor(onChange) {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange || (() => {});
  }
  exec(cmd) {
    cmd.do();
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.onChange();
  }
  undo() {
    const c = this.undoStack.pop();
    if (!c) return;
    c.undo();
    this.redoStack.push(c);
    this.onChange();
  }
  redo() {
    const c = this.redoStack.pop();
    if (!c) return;
    c.do();
    this.undoStack.push(c);
    this.onChange();
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this.onChange(); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
