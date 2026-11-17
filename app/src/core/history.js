// 撤销/重做：快照式历史，限制步数与内存。纯逻辑，不碰 DOM。
import { deepClone } from './util.js';

export class History {
  constructor(initial, limit = 100) {
    this.limit = limit;
    this.stack = [deepClone(initial)];
    this.index = 0;
    this.onChange = null;
  }

  _notify() {
    if (this.onChange) this.onChange(this.canUndo(), this.canRedo());
  }

  get current() {
    return this.stack[this.index];
  }

  canUndo() {
    return this.index > 0;
  }

  canRedo() {
    return this.index < this.stack.length - 1;
  }

  // 提交一个新状态（编辑后调用）
  push(state) {
    // 丢弃 redo 分支
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(deepClone(state));
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    this._notify();
  }

  undo() {
    if (!this.canUndo()) return null;
    this.index -= 1;
    this._notify();
    return deepClone(this.current);
  }

  redo() {
    if (!this.canRedo()) return null;
    this.index += 1;
    this._notify();
    return deepClone(this.current);
  }

  // 用外部载入的文档重置历史
  reset(state) {
    this.stack = [deepClone(state)];
    this.index = 0;
    this._notify();
  }
}
