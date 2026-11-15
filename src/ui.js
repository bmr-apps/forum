// src/ui.js — 아주 작은 화면 도우미 (요소 만들기 · 알림)
export const $ = (id) => document.getElementById(id);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

let toastTimer = null;
export function toast(msg, kind = '') {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 5200 : 3200);
}
