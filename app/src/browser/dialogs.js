// Toast 与模态框：错误必须带修复建议，不允许静默失败。
let wrap;

export function initToast(host) {
  wrap = host;
}

export function toast(message, level = 'ok', fix = null, title = null) {
  if (!wrap) wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  const t = document.createElement('div');
  t.className = 't-title';
  t.textContent = title || (level === 'err' ? '出错了' : level === 'warn' ? '注意' : '完成');
  const body = document.createElement('div');
  body.textContent = message;
  el.appendChild(t);
  el.appendChild(body);
  if (fix) {
    const f = document.createElement('div');
    f.className = 't-fix';
    f.textContent = `修复建议：${fix}`;
    el.appendChild(f);
  }
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, 6500);
}

export function showModal({ title, bodyHTML, okText = '确定', cancelText = '取消', hideCancel = false }) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('modal-backdrop');
    document.getElementById('modal-title').textContent = title;
    const body = document.getElementById('modal-body');
    body.innerHTML = bodyHTML;
    const ok = document.getElementById('modal-ok');
    const cancel = document.getElementById('modal-cancel');
    ok.textContent = okText;
    cancel.textContent = cancelText;
    cancel.style.display = hideCancel ? 'none' : '';
    backdrop.hidden = false;
    const close = (val) => {
      backdrop.hidden = true;
      ok.onclick = null;
      cancel.onclick = null;
      backdrop.onclick = null;
      resolve(val);
    };
    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    backdrop.onclick = (e) => { if (e.target === backdrop) close(false); };
  });
}

// 校验结果转成可读 HTML（导出前弹窗用）
export function issuesHTML(issues) {
  if (issues.length === 0) return '<p style="color:var(--ok)">✅ 未发现问题：所有元素位于安全区内，文字不会被裁切。</p>';
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  return `
    <p>发现 <b style="color:var(--err)">${errors.length} 个错误</b>、<b style="color:var(--warn)">${warns.length} 个警告</b>：</p>
    <ul style="padding-left:18px">
      ${issues.map((i) => `<li style="color:${i.level === 'error' ? 'var(--err)' : 'var(--warn)'};margin:6px 0">
        <b>${i.message}</b><br><span style="color:var(--txt-dim)">修复：${i.fix}</span></li>`).join('')}
    </ul>
    <label class="chk" style="margin-top:8px"><input type="checkbox" id="m-include-safe"/> 导出中包含安全框参考线</label>`;
}
