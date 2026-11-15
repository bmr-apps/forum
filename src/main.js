// src/main.js — 별무리 액티브 러닝 포럼 (입구·수업 시작)
//
//  · 입구: 코드로 참여 / 수업 열기(교사) / 체험 모드(?preview=1)
//  · 수업 화면은 room.js, 화상 연결은 rtc.js, 체험 모드는 preview.js 가 맡습니다.
//  · 서버 호출은 api.js 하나로 모읍니다(체험 모드에서는 같은 모양의 가짜 서버로 바꿔 끼웁니다).
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './style.css';
import { applyAppInfo } from './app-info.js';
import { api } from './api.js';
import { supabase } from './supabase.js';
import { local } from './store.js';
import { loginWithGoogle, logout as authLogout, onUserChange } from './auth.js';
import { Classroom } from './rtc.js';
import { PreviewRoom } from './preview.js';
import { Room } from './room.js';
import { $, toast } from './ui.js';

api.supabase = supabase;

const S = { user: null, room: null, classroom: null, preview: null, mode: 'home', previewMode: false };

// ---------- 화면 전환 ----------
function showScreen(name) {
  S.mode = name;
  $('home').hidden = name !== 'home';
  $('room').hidden = name !== 'room';
  $('boot').hidden = true;
  window.scrollTo(0, 0);
}

function goHome() {
  S.room = null;
  S.classroom = null;
  S.preview = null;
  showScreen('home');
  renderResumeChip();
}

/** 입장 코드 · 내 이름을 기억해 두었다가 다시 들어올 때 씁니다 (이 앱 것만: 'forum:' 접두어) */
function recall(code) {
  const map = local.get('sessions', {}) || {};
  return code ? map[code] || null : null;
}
function remember(code, key, name, title) {
  const map = local.get('sessions', {}) || {};
  map[code] = { key, name, title, at: Date.now() };
  const keys = Object.keys(map).sort((a, b) => (map[b].at || 0) - (map[a].at || 0)).slice(0, 12);
  const trimmed = {};
  for (const k of keys) trimmed[k] = map[k];
  local.set('sessions', trimmed);
  local.set('last', code);
}
function forget(code) {
  const map = local.get('sessions', {}) || {};
  delete map[code];
  local.set('sessions', map);
  if (local.get('last') === code) local.remove('last');
}

function renderResumeChip() {
  const existing = document.getElementById('resume');
  existing?.remove();
  const last = local.get('last');
  const rec = last ? recall(last) : null;
  if (!rec) return;
  const card = document.createElement('button');
  card.id = 'resume';
  card.type = 'button';
  card.className = 'resume';
  card.append(
    Object.assign(document.createElement('b'), { textContent: rec.title || last }),
    Object.assign(document.createElement('span'), { textContent: `코드 ${last} · ${rec.name} 으로 이어서 들어가기` }),
  );
  card.onclick = () => joinSession({ code: last, name: rec.name, key: rec.key });
  document.querySelector('.panel-card')?.prepend(card);
}

// ---------- 로그인(선택) ----------
function initAuth() {
  $('login').onclick = () => loginWithGoogle();
  $('logout').hidden = true;
  $('logout').onclick = async () => { await authLogout(); toast('이 앱에서 로그아웃했어요.'); };
  onUserChange((user) => {
    S.user = user;
    const who = $('who');
    if (user) {
      who.hidden = false;
      who.textContent = user.email || '로그인됨';
      $('login').hidden = true;
      $('logout').hidden = false;
    } else {
      who.hidden = true;
      $('login').hidden = false;
      $('logout').hidden = true;
    }
  });
}

// ---------- 입구 ----------
function bindHome() {
  // 탭
  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll('.tab')) {
        t.classList.toggle('on', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      }
      $('form-join').hidden = tab.dataset.tab !== 'join';
      $('form-new').hidden = tab.dataset.tab !== 'new';
    };
  }

  // 입장 코드 확인 (2글자 이상이면 미리 확인)
  const codeIn = $('join-code');
  let lookupTimer = null;
  codeIn.addEventListener('input', () => {
    codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const code = codeIn.value.trim();
    const preview = $('join-preview');
    clearTimeout(lookupTimer);
    if (code.length < 4) { preview.textContent = ''; preview.className = 'hint'; return; }
    lookupTimer = setTimeout(async () => {
      try {
        const info = await api.lookup(code);
        const rec = recall(code);
        if (rec?.name) $('join-name').value = $('join-name').value || rec.name;
        preview.className = 'hint ok';
        preview.textContent = info.status === 'ended'
          ? `‘${info.title}’ — 끝난 수업이에요.`
          : `‘${info.title}’ · ${info.host_name || '선생님'} · ${info.participants}명 참여 중`;
      } catch (e) {
        preview.className = 'hint err';
        preview.textContent = e.message;
      }
    }, 350);
  });

  $('form-join').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('join-code').value.trim().toUpperCase();
    const name = $('join-name').value.trim();
    if (code.length < 4) { toast('입장 코드를 확인해 주세요.', 'err'); return; }
    if (!name) { toast('이름을 적어 주세요.', 'err'); $('join-name').focus(); return; }
    const rec = recall(code);
    await joinSession({ code, name, key: rec?.key });
  };

  $('form-new').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('new-title').value.trim() || '이름 없는 수업';
    const host = $('new-host').value.trim() || '선생님';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api.create(title, host);
      remember(res.code, res.key, host, title);
      await enterRoom({ mode: 'live', code: res.code, key: res.key, state: res });
      toast(`수업 방을 만들었어요. 입장 코드는 ${res.code} 입니다.`);
    } catch (err) {
      toast(err.message || '수업 방을 만들지 못했어요.', 'err');
    } finally {
      btn.disabled = false;
    }
  };

  $('preview-btn').onclick = () => enterRoom({ mode: 'preview' });

  // 모달 닫기 (room 이 열기 전에도 동작)
  $('modal-x').onclick = () => { $('modal').hidden = true; };
  $('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').hidden = true; };
}

async function joinSession({ code, name, key }) {
  const btn = $('form-join').querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    let res;
    try {
      res = await api.join(code, name, key);
    } catch (e) {
      // 기억해 둔 신분표가 어긋났을 때 — 신분표 없이 한 번만 다시 시도한다
      if (!key || !String(e.message || '').includes('다시 입장')) throw e;
      forget(code);
      res = await api.join(code, name, '');
    }
    remember(res.code, res.key, name, res.session.title);
    await enterRoom({ mode: 'live', code: res.code, key: res.key, state: res });
    toast(`‘${res.session.title}’ 수업에 들어왔어요.`);
  } catch (e) {
    toast(e.message || '수업에 들어가지 못했어요.', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 수업 화면 ----------
async function enterRoom({ mode, code, key, state }) {
  const isPreview = mode === 'preview' || S.previewMode;
  let classroom = null;
  let preview = null;
  let initialState = state;

  if (isPreview) {
    preview = new PreviewRoom({ hostName: '선생님' });
    preview.start(() => {});
    initialState = preview.state;
    classroom = preview;
  } else {
    classroom = new Classroom({
      code, me: { key, name: state.me.name, role: state.me.role },
      isHost: state.me.role === 'host',
      onChange: () => { S.room?.renderTiles?.(); },
      onNotice: (m) => toast(m),
      onTalk: () => {},
    });
  }

  const room = new Room({
    mode: isPreview ? 'preview' : 'live',
    api: isPreview ? preview : api,
    code: isPreview ? initialState.code : code,
    key: isPreview ? initialState.me.key : key,
    state: initialState,
    classroom,
    onLeave: goHome,
    onNotice: (m) => toast(m),
  });

  S.room = room;
  S.classroom = classroom;
  S.preview = preview;
  showScreen('room');
  room.mount();
  room.retryAudioOnGesture();
  if (!isPreview) await classroom.join({ video: false, group: initialState.me.breakout_group || 'main' });
  room.render();
  if (isPreview) toast('체험 모드예요 — 학생 12명이 함께 있는 화면을 그대로 둘러보세요.');
}

// ---------- 주소 파라미터 ----------
function handleParams() {
  const p = new URLSearchParams(location.search);
  if (p.get('preview') === '1' || p.get('demo') === '1') {
    S.previewMode = true;
    enterRoom({ mode: 'preview' }).catch((e) => toast(e.message || '체험 모드를 열지 못했어요.', 'err'));
    return true;
  }
  const code = (p.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code) {
    $('join-code').value = code;
    const rec = recall(code);
    if (rec?.name) $('join-name').value = rec.name;
    // 이름과 신분표가 기억되어 있으면 바로 들어간다
    if (code && p.get('join') === '1' && rec?.name) { joinSession({ code, name: rec.name, key: rec.key }); return true; }
  }
  return false;
}

// ---------- 시작 ----------
applyAppInfo(' · BMR APPS');
initAuth();
bindHome();
if (!handleParams()) {
  renderResumeChip();
  showScreen('home');
}
