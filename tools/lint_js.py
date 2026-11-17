#!/usr/bin/env python3 -I
"""lint_js.py — 无 JS 引擎环境下的基础结构检查：
1) 括号/花括号/方括号配平（忽略字符串、模板串、注释、正则外的常见情况）
2) 单/双引号、反引号配平
3) import 的具名符号在目标模块里确有 export
"""
import os
import re
import sys

SRC = os.path.join(os.path.dirname(__file__), '..', 'src')


def strip_noise(text):
    """粗略去掉注释与字符串，保留结构符号，避免被内容干扰。"""
    out = []
    i, n = 0, len(text)
    state = None  # None | 'line' | 'block' | 'sq' | 'dq' | 'tpl'
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ''
        if state is None:
            if c == '/' and nxt == '/':
                state = 'line'; i += 2; continue
            if c == '/' and nxt == '*':
                state = 'block'; i += 2; continue
            if c == "'":
                state = 'sq'; i += 1; continue
            if c == '"':
                state = 'dq'; i += 1; continue
            if c == '`':
                state = 'tpl'; i += 1; continue
            out.append(c); i += 1; continue
        if state == 'line':
            if c == '\n':
                state = None; out.append('\n')
            i += 1; continue
        if state == 'block':
            if c == '*' and nxt == '/':
                state = None; i += 2; continue
            i += 1; continue
        if state in ('sq', 'dq'):
            quote = "'" if state == 'sq' else '"'
            if c == '\\':
                i += 2; continue
            if c == quote:
                state = None
            i += 1; continue
        if state == 'tpl':
            if c == '\\':
                i += 2; continue
            if c == '`':
                state = None
            i += 1; continue
    return ''.join(out), state


def check_balance(path, text):
    code, unclosed = strip_noise(text)
    pairs = {')': '(', ']': '[', '}': '{'}
    stack = []
    for ch in code:
        if ch in '([{':
            stack.append(ch)
        elif ch in ')]}':
            if not stack or stack[-1] != pairs[ch]:
                return f'括号不配平，遇到 {ch}，栈={stack[-3:]}'
            stack.pop()
    if stack:
        return f'括号未闭合，残留 {stack[-5:]}'
    if unclosed is not None:
        return f'字符串/注释未闭合: {unclosed}'
    # 引号原始计数（模板串允许跨行，单独看反引号奇偶）
    raw = re.sub(r'//[^\n]*|/\*.*?\*/', '', text, flags=re.S)
    if raw.count('`') % 2:
        return '反引号数量为奇数，模板串可能未闭合'
    return None


def collect_exports(text):
    names = set()
    for m in re.finditer(r'export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)', text):
        names.add(m.group(1))
    for m in re.finditer(r'export\s+const\s+([A-Za-z0-9_]+)', text):
        names.add(m.group(1))
    for m in re.finditer(r'export\s*\{([^}]*)\}', text):
        for part in m.group(1).split(','):
            part = part.strip()
            if part:
                names.add(part.split(' as ')[-1].strip())
    return names


def main():
    files = sorted(f for f in os.listdir(SRC) if f.endswith('.js'))
    modules = {}
    problems = []
    for f in files:
        text = open(os.path.join(SRC, f), encoding='utf-8').read()
        err = check_balance(f, text)
        if err:
            problems.append(f'{f}: {err}')
        modules[f.replace('.js', '')] = collect_exports(text)

    # import 解析
    import_re = re.compile(r'import\s*(?:([\w$]+)\s*,?\s*)?\{([^}]*)\}\s*from\s*[\'"](\.[^\'"]+)[\'"]')
    side_re = re.compile(r'import\s+[\'"](\.[^\'"]+)[\'"]')
    for f in files:
        text = open(os.path.join(SRC, f), encoding='utf-8')
        text = text.read()
        for m in import_re.finditer(text):
            named = [s.strip().split(' as ')[0] for s in m.group(2).split(',') if s.strip()]
            target = os.path.basename(m.group(3)).replace('.js', '')
            if target not in modules:
                problems.append(f'{f}: 找不到模块 {m.group(3)}')
                continue
            missing = [s for s in named if s not in modules[target]]
            if missing:
                problems.append(f'{f}: 从 {target} 导入了不存在的导出 {missing}')
    if problems:
        print('JS 结构检查发现问题：')
        for p in problems:
            print(' -', p)
        return 1
    print(f'JS 结构检查通过：{len(files)} 个模块，括号/字符串配平、import 导出全部一致')
    return 0


if __name__ == '__main__':
    sys.exit(main())
