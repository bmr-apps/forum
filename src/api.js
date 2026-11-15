// src/api.js — forum-fn 서버 함수 호출 모음
// 화면 코드는 이 파일만 쓰면 됩니다. 진짜 서버 대신 '체험 모드'를 끼울 때도 같은 모양(인터페이스)을 씁니다.
import { supabase, FN_URL } from './supabase.js';

async function accessToken() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token ?? '';
  } catch { return ''; }
}

async function req(path, { method = 'GET', body = null, query = null } = {}) {
  const url = new URL(FN_URL + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, String(v));
  const headers = {};
  const token = await accessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body != null) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let r;
  try {
    r = await fetch(url, { method, headers, body: payload });
  } catch {
    throw new Error('서버에 닿지 못했어요. 인터넷 연결을 확인해 주세요.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `요청을 마치지 못했어요 (${r.status})`);
  return data;
}

export const api = {
  /** 입장 코드 확인 */
  lookup: (code) => req('/session/lookup', { query: { code } }),
  /** 수업 방 만들기 → {code, key, ...state} */
  create: (title, hostName) => req('/session/create', { method: 'POST', body: { title, host_name: hostName } }),
  /** 들어가기(또는 같은 기기로 다시 들어가기) */
  join: (code, name, key) => req('/session/join', { method: 'POST', body: { code, name, key } }),
  /** 상태 한 번에 (heartbeat 겸용) */
  state: (code, key) => req('/session/state', { query: { code, key } }),
  timeline: (code, key, timeline) => req('/session/timeline', { method: 'POST', body: { code, key, timeline } }),
  step: (code, key, index) => req('/session/step', { method: 'POST', body: { code, key, index } }),
  openPoll: (code, key, poll) => req('/session/poll', { method: 'POST', body: { code, key, ...poll } }),
  closePoll: (code, key) => req('/session/poll/close', { method: 'POST', body: { code, key } }),
  vote: (code, key, vote) => req('/poll/vote', { method: 'POST', body: { code, key, ...vote } }),
  breakout: (code, key, opts) => req('/session/breakout', { method: 'POST', body: { code, key, ...opts } }),
  saveWorkbook: (code, key, group, content) => req('/workbook', { method: 'POST', body: { code, key, group, content } }),
  talk: (code, key, seconds, signals) => req('/session/talk', { method: 'POST', body: { code, key, seconds, signals } }),
  end: (code, key) => req('/session/end', { method: 'POST', body: { code, key } }),
  aiReport: (code, key) => req('/ai-report', { method: 'POST', body: { code, key } }),
  reports: (code, key) => req('/reports', { query: { code, key } }),
};
