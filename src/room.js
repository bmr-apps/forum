// src/room.js — 수업 화면(교실) 그리기와 조작
//
//  · 영상 타일 12개 · 발화량 막대 · 투표 결과 · 타임라인 · 모둠 관제 · 공동 워크북을 한 화면에 그립니다.
//  · 진짜 서버(api.js)와 체험 모드(preview.PreviewRoom)를 같은 코드로 다루려고,
//    서버 호출은 모두 this.api 로만 합니다(둘 다 같은 모양).
//  · 남의 소리는 영상이 꺼져 있어도 <audio> 로 붙입니다 — 화상이 아니라 음성 수업이어도 들려야 하므로.
import { el } from './ui.js';

const OPINION_COLORS = ['#2563eb', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899'];
const KIND_LABEL = { intro: '도입', poll: '투표', breakout: '분반', discuss: '나눔', wrap: '정리', custom: '활동' };

const mmss = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clock = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
};
function hue(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export class Room {
  /**
   * @param {{mode:'live'|'preview', api:object, code:string, key:string, state:object,
   *          classroom:object, onLeave:Function, onNotice:Function}} opts
   */
  constructor({ mode, api, code, key, state, classroom, onLeave, onNotice }) {
    this.mode = mode;
    this.api = api;
    this.code = code;
    this.key = key;
    this.state = state;
    this.classroom = classroom;
    this.onLeave = onLeave;
    this.onNotice = onNotice;

    this.tiles = new Map();
    this.pane = 'flow';
    this.bookGroup = null;
    this.bookTimer = null;
    this.bookDirty = false;
    this.refreshTimer = null;
    this.tickTimer = null;
    this.talkTimer = null;
    this.startedAt = Date.now();
    this.spot = null;
    this.videoBudget = 'all';  // 'all' | 'speaker' (13명 이상일 때 발표자·교사만 화상)
    this.lastSpeaker = '';
    this.lastSpeakerAt = 0;
    this.timelineEditing = false;
    this.watchChannel = null;
  }

  get isHost() { return this.state.me?.role === 'host'; }
  get session() { return this.state.session; }
  get me() { return this.state.me; }
  get participants() { return this.state.participants || []; }
  get myGroup() { return this.me?.breakout_group || 'main'; }

  // ---------- 시작 ----------
  mount() {
    this.bindTop();
    this.bindBar();
    this.bindRail();
    this.bindKeys();
    this.render();
    this.tickTimer = setInterval(() => this.renderClock(), 1000);
    this._onResize = () => this.layoutGrid(this.tilePeople().length, window.innerWidth < 620 ? 96 : 150);
    window.addEventListener('resize', this._onResize);
    if (this.mode === 'live') {
      this.watch();
      this.refreshTimer = setInterval(() => this.refresh(), 3500);
      this.talkTimer = setInterval(() => this.flushTalk(), 5000);
    } else {
      // 체험 모드: 가짜 수업이 1초마다 움직인다
      this.classroom.onChange = (state) => { if (state) this.update(state); };
    }
    setTimeout(() => this.refresh(), 600);
  }

  destroy() {
    clearInterval(this.tickTimer);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    clearInterval(this.refreshTimer);
    clearInterval(this.talkTimer);
    clearTimeout(this.bookTimer);
    if (this.watchChannel) { try { this.watchChannel.unsubscribe(); } catch { /* 무시 */ } }
    for (const t of this.tiles.values()) this.disposeTile(t);
    this.tiles.clear();
  }

  // ---------- 실시간 ----------
  watch() {
    try {
      const sb = this.api.supabase;
      if (!sb) return;
      const ch = sb.channel(`forum-live:${this.code}`, { config: { broadcast: { self: true } } });
      ch.on('broadcast', { event: 'refresh' }, () => this.scheduleRefresh());
      ch.on('broadcast', { event: 'budget' }, (msg) => {
        const mode = msg?.payload?.mode;
        if (mode === 'all' || mode === 'speaker') { this.videoBudget = mode; this.renderFlow(); this.renderTiles(); }
      });
      ch.subscribe();
      this.watchChannel = ch;
    } catch (e) { console.warn('watch', e); }
  }

  broadcast() {
    try { this.watchChannel?.send({ type: 'broadcast', event: 'refresh', payload: { at: Date.now() } }); } catch { /* 무시 */ }
  }

  setBudget(mode) {
    this.videoBudget = mode;
    try { this.watchChannel?.send({ type: 'broadcast', event: 'budget', payload: { mode } }); } catch { /* 무시 */ }
    this.renderFlow();
    this.renderTiles();
  }

  scheduleRefresh() {
    clearTimeout(this._sr);
    this._sr = setTimeout(() => this.refresh(), 220);
  }

  async refresh(silent = true) {
    if (this.mode !== 'live') return;
    try {
      const state = await this.api.state(this.code, this.key);
      this.update(state);
    } catch (e) {
      if (!silent) this.onNotice(e.message || '상태를 새로 받지 못했어요.');
    }
  }

  async act(fn, { notice = '', reload = true } = {}) {
    try {
      const res = await fn();
      if (res && res.session) this.update(res);
      else if (reload) await this.refresh();
      this.broadcast();
      if (notice) this.onNotice(notice);
      return res;
    } catch (e) {
      this.onNotice(e.message || '요청을 마치지 못했어요.');
      return null;
    }
  }

  // ---------- 상태 반영 ----------
  update(next) {
    const prevGroup = this.myGroup;
    this.state = next;
    const group = this.myGroup;
    if (group !== prevGroup) {
      // 모둠이 바뀌면 워크북도 내 모둠 것으로 따라간다
      this.bookGroup = group;
      this._sig = {};
      if (this.mode === 'live') {
        this.classroom?.setGroup?.(group);
        for (const t of this.tiles.values()) this.disposeTile(t);
        this.tiles.clear();
      }
    }
    this.render();
  }

  /** 이 패널 안에서 글을 쓰는 중이면 다시 그리지 않는다 (입력 중 화면이 튀지 않게) */
  typingIn(paneId) {
    const a = document.activeElement;
    const p = document.getElementById(paneId);
    if (!a || !p || !p.contains(a)) return false;
    return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT';
  }

  /** 같은 내용이면 다시 그리지 않는다 — 1초마다 상태가 와도 화면이 튀지 않게 */
  same(key, value) {
    const s = JSON.stringify(value);
    this._sig ??= {};
    if (this._sig[key] === s) return true;
    this._sig[key] = s;
    return false;
  }

  render() {
    this.renderTop();
    this.renderTiles();
    const s = this.session;
    const tl = s.timeline || [];
    // 패널은 '내용이 바뀌었을 때만' 다시 그린다 (입력 중 글자가 날아가지 않게)
    if (!this.same('flow', [tl, s.current_step_index, this.isHost, this.videoBudget, this.timelineEditing, this.participants.length, this.myGroup])
      && !this.typingIn('pane-flow')) this.renderFlow();
    if (!this.same('poll', [this.state.poll, this.isHost, this.myGroup]) && !this.typingIn('pane-poll')) this.renderPoll();
    if (!this.same('people', this.participants.map((p) => [p.key, p.name, Math.round(Number(p.talk_seconds)), p.online, p.breakout_group])) && !this.typingIn('pane-people')) this.renderPeople();
    const groups = this.groupList();
    if (!this.same('book', [this.bookGroup, groups, this.state.workbook, this.state.workbooks, this.isHost, this.myGroup])
      && !this.typingIn('pane-book')) this.renderBook();
    if (!this.same('groups', [s.breakout_config, this.participants.map((p) => [p.key, p.breakout_group, Math.round(Number(p.talk_seconds) / 5)]), this.state.workbooks, this.isHost, this.myGroup])
      && !this.typingIn('pane-groups')) this.renderGroups();
    this.renderBanner();
    this.renderBar();
    this.renderClock();
    this.playPendingAudio();
  }

  // ---------- 위쪽 ----------
  bindTop() {
    document.getElementById('rm-code').onclick = () => this.copyInvite();
    document.getElementById('rm-share').onclick = () => this.copyInvite();
    document.getElementById('rm-leave').onclick = () => this.leave();
    document.getElementById('rm-rail-toggle').onclick = () => {
      const rail = document.getElementById('rm-rail');
      const open = rail.classList.toggle('open');
      document.getElementById('rm-rail-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    document.getElementById('rm-banner-act').onclick = () => this.bannerAction?.();
  }

  renderTop() {
    const s = this.session;
    document.getElementById('rm-title').textContent = s.title || '수업';
    document.getElementById('rm-code').querySelector('b').textContent = this.code || s.code || '------';
    const step = this.stepInfo();
    document.getElementById('rm-step').textContent = `${step.index + 1}/${step.total} · ${step.title}`;
    const online = this.participants.filter((p) => p.online).length;
    document.getElementById('rm-count').textContent = `${this.participants.length}명${online !== this.participants.length ? ` (접속 ${online})` : ''}`;
    const mode = document.getElementById('rm-mode');
    if (s.status === 'ended') { mode.hidden = false; mode.textContent = '수업 끝'; mode.classList.add('ended'); }
    else if (this.mode === 'preview') { mode.hidden = false; mode.textContent = '체험 모드'; mode.classList.remove('ended'); }
    else if ((s.breakout_config?.active)) { mode.hidden = false; mode.textContent = `${s.breakout_config.groups}모둠 분반 중`; mode.classList.remove('ended'); }
    else mode.hidden = true;
    document.getElementById('bar-host').hidden = !this.isHost;
    document.getElementById('host-next').hidden = !this.isHost || s.status === 'ended';
    document.getElementById('host-report').textContent = this.state.last_report ? '🤖 지난 리포트' : '🤖 AI 리포트';
  }

  renderClock() {
    const started = this.session?.created_at ? Date.parse(this.session.created_at) : this.startedAt;
    const now = this.mode === 'preview' ? Date.now() : Date.now();
    document.getElementById('rm-clock').textContent = clock((now - started) / 1000);
  }

  copyInvite() {
    const code = this.code || this.session.code;
    const url = new URL(import.meta.env.BASE_URL, location.origin).href;
    const text = this.mode === 'preview'
      ? '체험 모드로 둘러보는 중이에요 (학생 12명 시뮬레이션)'
      : `별무리 액티브 러닝 포럼 — 입장 코드 ${code}\n${url} 에서 ‘코드로 참여’를 눌러 코드를 넣어 주세요.`;
    navigator.clipboard?.writeText(text).then(
      () => this.onNotice(this.mode === 'preview' ? '체험 모드 안내를 복사했어요.' : `입장 코드 ${code} 를 복사했어요.`),
      () => this.onNotice(`입장 코드: ${code}`),
    );
  }

  // ---------- 타일 ----------
  viewPeople() {
    const view = this.classroom?.view?.() ?? [];
    const byKey = new Map(view.map((p) => [String(p.key), p]));
    return this.participants
      .filter((p) => p.online || p.key === this.key)
      .map((p) => {
        const v = byKey.get(String(p.key)) || {};
        return {
          key: p.key, name: p.name, role: p.role, talk: Number(p.talk_seconds) || 0,
          group: p.breakout_group,
          stream: v.stream ?? null, video: Boolean(v.video), micOn: v.micOn ?? true,
          speaking: Boolean(v.speaking), local: p.key === this.key,
        };
      })
      .sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : Number(b.local) - Number(a.local)));
  }

  tilePeople() {
    const people = this.viewPeople();
    const breakout = Boolean(this.session.breakout_config?.active) && this.myGroup !== 'main';
    if (breakout) return people.filter((p) => p.group === this.myGroup);
    return people;
  }

  buildTile(p) {
    const tile = el('div', 'tile');
    tile.dataset.key = p.key;
    tile.setAttribute('role', 'listitem');
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = true;
    video.setAttribute('playsinline', '');
    const av = el('div', 'tile-av', String(p.name || '?').slice(0, 1));
    av.style.setProperty('--h', String(hue(p.key)));
    const bar = el('div', 'tile-bar');
    const name = el('span', 'tile-name', p.name);
    const talk = el('span', 'tile-talk', '0:00');
    const mic = el('span', 'tile-mic', '🎙️');
    const meta = el('div', 'tile-meta');
    meta.append(name, talk, mic);
    bar.append(meta);
    const strip = el('div', 'tile-strip');
    tile.append(video, av, strip, bar);
    // 남의 소리 전용 <audio> — 영상이 꺼져 있어도 이 요소로 목소리가 난다
    let audio = null;
    if (!p.local) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      tile.appendChild(audio);
    }
    tile.onclick = () => {
      const on = tile.classList.contains('spot');
      for (const t of this.tiles.values()) t.el.classList.remove('spot');
      if (!on) tile.classList.add('spot');
      this.spot = on ? null : p.key;
    };
    return { el: tile, video, audio, av, name, talk, mic, strip };
  }

  disposeTile(t) {
    this.pendingAudio?.delete(t);
    try { t.video.srcObject = null; } catch { /* 무시 */ }
    if (t.audio) { try { t.audio.pause(); t.audio.srcObject = null; } catch { /* 무시 */ } }
    t.el.remove();
  }

  playQuietly(node, tile = null) {
    const pr = node.play();
    if (!pr || !pr.catch) return;
    pr.catch(() => { if (tile) (this.pendingAudio ??= new Set()).add(tile); });
  }

  playPendingAudio() {
    for (const tile of [...(this.pendingAudio ?? [])]) {
      const a = tile.audio;
      if (!a || !a.srcObject) { this.pendingAudio.delete(tile); continue; }
      const pr = a.play();
      if (pr && pr.then) pr.then(() => this.pendingAudio.delete(tile)).catch(() => { /* 다음 손짓에 */ });
    }
  }

  /** 브라우저가 자동재생을 막았을 때 — 다음 손짓에 다시 틀어 본다 */
  retryAudioOnGesture() {
    if (this._gestureBound) return;
    this._gestureBound = true;
    const go = () => this.playPendingAudio();
    document.addEventListener('pointerdown', go, true);
    document.addEventListener('keydown', go, true);
  }

  /** 타일이 4:3 에 가장 가까워지는 열 수를 골라 무대를 채운다 */
  layoutGrid(count, minW = 0) {
    const grid = document.getElementById('rm-grid');
    if (!grid || !count) return;
    const W = Math.max(1, grid.clientWidth), H = Math.max(1, grid.clientHeight);
    let best = { cols: Math.min(4, count), score: Infinity };
    for (let c = 1; c <= Math.min(8, count); c++) {
      const rows = Math.ceil(count / c);
      const w = W / c, h = H / rows;
      if (minW && w < minW) continue;
      const score = Math.abs(w / h - 4 / 3);
      if (score < best.score) best = { cols: c, score };
    }
    grid.style.gridTemplateColumns = `repeat(${best.cols}, minmax(0, 1fr))`;
  }

  renderTiles() {
    const wrap = document.getElementById('rm-grid');
    const people = this.tilePeople();
    const grid = document.getElementById('rm-grid');
    grid.classList.toggle('many', people.length > 6);
    grid.classList.toggle('breakout', this.myGroup !== 'main');
    this.layoutGrid(people.length, window.innerWidth < 620 ? 96 : 150);
    const seen = new Set();
    for (const p of people) {
      seen.add(String(p.key));
      let t = this.tiles.get(String(p.key));
      if (!t) { t = this.buildTile(p); this.tiles.set(String(p.key), t); wrap.appendChild(t.el); }
      this.updateTile(t, p);
    }
    for (const [k, t] of [...this.tiles]) if (!seen.has(k)) { this.disposeTile(t); this.tiles.delete(k); }

    // 발화가 적은 학생 기준 (학생 평균의 절반)
    const students = people.filter((p) => p.role !== 'host');
    const mean = students.length ? students.reduce((a, p) => a + p.talk, 0) / students.length : 0;
    const total = people.reduce((a, p) => a + p.talk, 0) || 1;
    // 지금 말하는 사람 (8초 동안 유지) — 발표자 우선 화상 모드에서 화면을 켜 둘 사람
    const speaker = people.find((p) => p.speaking);
    if (speaker) { this.lastSpeaker = String(speaker.key); this.lastSpeakerAt = Date.now(); }
    const stickySpeaker = Date.now() - this.lastSpeakerAt < 8000 ? this.lastSpeaker : '';
    if (this.classroom?.setSendVideo) {
      const send = this.videoBudget === 'all' || this.isHost || String(this.key) === stickySpeaker;
      this.classroom.setSendVideo(send).catch(() => {});
    }
    for (const p of people) {
      const t = this.tiles.get(String(p.key));
      if (!t) continue;
      const share = p.talk / total;
      t.el.style.setProperty('--share', `${Math.min(100, Math.round(share * 100))}%`);
      t.talk.textContent = mmss(p.talk);
      t.el.classList.toggle('low', p.role !== 'host' && mean > 8 && p.talk < mean * 0.5);
      const hideForBudget = this.videoBudget === 'speaker' && p.role !== 'host' && !p.local && String(p.key) !== stickySpeaker;
      t.el.classList.toggle('video-on', Boolean(p.video && p.stream) && !hideForBudget);
      // 투표 의견 색 — 타일 왼쪽 띠
      const poll = this.state.poll;
      const mine = poll?.by_key ? poll.by_key[String(p.key)] : null;
      if (typeof mine === 'number' && mine >= 0) {
        t.strip.style.setProperty('--c', OPINION_COLORS[mine % OPINION_COLORS.length]);
        t.el.classList.add('has-opinion');
      } else {
        t.el.classList.remove('has-opinion');
      }
    }
    document.getElementById('rm-empty').hidden = people.some((p) => p.video && p.stream) || this.mode === 'preview';
    if (people.length === 0) {
      // 아무도 없을 때 안내
      wrap.appendChild(el('p', 'grid-empty', '아직 참가자가 없어요. ‘초대’로 입장 코드를 알려 주세요.'));
    } else {
      wrap.querySelector('.grid-empty')?.remove();
    }
  }

  updateTile(t, p) {
    // 소리 — 영상과 무관하게 늘 붙인다
    if (t.audio) {
      const sound = p.stream || null;
      if (t.audio.srcObject !== sound) {
        t.audio.srcObject = sound;
        if (!sound) this.pendingAudio?.delete(t);
        else if (t.audio.paused) this.playQuietly(t.audio, t);
      }
    }
    const stream = p.video && p.stream ? p.stream : null;
    if (t.video.srcObject !== stream) {
      t.video.srcObject = stream;
      if (stream) this.playQuietly(t.video);
    }
    t.el.classList.toggle('speaking', p.speaking);
    t.el.classList.toggle('muted', !p.micOn);
    t.mic.textContent = p.micOn ? '🎙️' : '🔇';
    t.name.textContent = p.name;
    t.el.classList.toggle('me', p.local);
    t.el.dataset.role = p.role;
  }

  hostKey() { return this.participants.find((p) => p.role === 'host')?.key || ''; }

  // ---------- 아래 조작 막대 ----------
  bindBar() {
    document.getElementById('me-mic').onclick = () => this.toggleMic();
    document.getElementById('me-cam').onclick = () => this.toggleCam();
    document.getElementById('me-talk').onclick = () => {
      const mine = this.participants.find((p) => p.key === this.key);
      this.onNotice(`내 발화 시간 ${mmss(mine?.talk_seconds || 0)}`);
    };
    document.getElementById('host-poll').onclick = () => this.openPollDialog();
    document.getElementById('host-break').onclick = () => this.openBreakDialog();
    document.getElementById('host-report').onclick = () => this.openReportDialog();
    document.getElementById('host-next').onclick = () => this.nextStep();
  }

  renderBar() {
    const micOn = this.classroom?.local?.micOn ?? true;
    const camOn = this.classroom?.local?.camOn ?? false;
    const mic = document.getElementById('me-mic');
    mic.classList.toggle('on', micOn);
    mic.classList.toggle('off', !micOn);
    mic.setAttribute('aria-pressed', micOn ? 'true' : 'false');
    mic.querySelector('span').textContent = micOn ? '마이크' : '마이크 꺼짐';
    const cam = document.getElementById('me-cam');
    cam.classList.toggle('on', camOn);
    cam.classList.toggle('off', !camOn);
    cam.setAttribute('aria-pressed', camOn ? 'true' : 'false');
    cam.querySelector('span').textContent = camOn ? '카메라' : '카메라 꺼짐';
    const mine = this.participants.find((p) => p.key === this.key);
    document.getElementById('me-talk').querySelector('b').textContent = mmss(mine?.talk_seconds || 0);
    if (this.isHost) {
      const s = this.session;
      const next = this.session.timeline?.[Math.min(s.current_step_index + 1, s.timeline.length - 1)];
      document.getElementById('host-next').textContent = s.current_step_index >= (s.timeline?.length ?? 1) - 1 ? '마지막 단계' : `다음: ${next?.title ?? '—'} ▶`;
    }
  }

  async toggleMic() {
    await this.classroom.toggleMic?.();
    this.renderBar();
  }

  async toggleCam() {
    await this.classroom.toggleCam?.();
    this.renderBar();
  }

  bindKeys() {
    this._keys = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'm') { this.toggleMic(); }
      else if (k === 'v') { this.toggleCam(); }
      else if (k === 'y' || k === 'n') {
        const poll = this.state.poll;
        if (poll && poll.status === 'open' && poll.type === 'yesno') {
          e.preventDefault();
          this.vote(k === 'y' ? 0 : 1);
        }
      } else if (/^[1-6]$/.test(k)) {
        const poll = this.state.poll;
        if (poll && poll.status === 'open' && poll.type === 'choice') {
          const i = Number(k) - 1;
          if (i < poll.options.length) this.vote(i);
        }
      } else if (k === 'escape') {
        this.closeModal();
      }
    };
    document.addEventListener('keydown', this._keys);
  }

  unbindKeys() { if (this._keys) document.removeEventListener('keydown', this._keys); }

  // ---------- 타임라인 패널 ----------
  stepInfo() {
    const tl = this.session?.timeline || [];
    const i = Math.max(0, Math.min(tl.length - 1, Number(this.session?.current_step_index) || 0));
    const s = tl[i];
    return { index: i, total: tl.length || 1, step: s, title: s?.title || '단계 없음', kind: s?.kind || 'custom' };
  }

  renderFlow() {
    const box = document.getElementById('pane-flow');
    box.textContent = '';
    const { index } = this.stepInfo();
    const tl = this.session.timeline || [];

    const head = el('div', 'rail-head');
    head.append(el('h3', null, '수업 타임라인'));
    if (this.isHost) {
      const edit = el('button', 'btn small ghost', this.timelineEditing ? '편집 끝내기' : '편집');
      edit.onclick = () => { this.timelineEditing = !this.timelineEditing; this.renderFlow(); };
      head.append(edit);
    }
    box.append(head);

    if (this.isHost && this.timelineEditing) {
      box.append(this.timelineEditor(tl));
      return;
    }

    const list = el('ol', 'steps');
    tl.forEach((s, i) => {
      const li = el('li', 'step' + (i === index ? ' on' : '') + (i < index ? ' done' : ''));
      const b = el('button', 'step-btn');
      b.type = 'button';
      b.append(
        el('span', 'step-n', String(i + 1)),
        el('span', 'step-txt', s.title),
        el('span', 'step-kind', KIND_LABEL[s.kind] || '활동'),
      );
      if (s.minutes) b.append(el('span', 'step-min', `${s.minutes}분`));
      b.onclick = () => { if (this.isHost) this.jumpStep(i); };
      li.append(b);
      if (i === index && s.note) li.append(el('p', 'step-note', s.note));
      if (i === index && this.isHost) {
        const acts = el('div', 'step-acts');
        if (s.kind === 'poll') {
          const b2 = el('button', 'btn small', '이 단계에서 투표 열기');
          b2.onclick = () => this.openPollDialog();
          acts.append(b2);
        }
        if (s.kind === 'breakout') {
          const b3 = el('button', 'btn small', '이 단계에서 분반');
          b3.onclick = () => this.openBreakDialog();
          acts.append(b3);
        }
        if (acts.childElementCount) li.append(acts);
      }
      list.append(li);
    });
    if (!tl.length) box.append(el('p', 'muted', '타임라인이 비어 있어요.'));
    else box.append(list);

    if (this.isHost) {
      const ctl = el('div', 'rail-acts');
      const prev = el('button', 'btn small ghost', '◀ 이전');
      prev.disabled = index <= 0;
      prev.onclick = () => this.jumpStep(index - 1);
      const next = el('button', 'btn small primary', '다음 단계 ▶');
      next.disabled = index >= tl.length - 1;
      next.onclick = () => this.jumpStep(index + 1);
      ctl.append(prev, next);
      box.append(ctl);

      // 13명 이상이면 화상 예산 모드
      const many = this.participants.length > 12;
      const budget = el('div', 'rail-note');
      budget.append(el('b', null, '화상 모드  '));
      const b1 = el('button', 'btn small' + (this.videoBudget === 'all' ? ' on' : ' ghost'), '전원 화상');
      const b2 = el('button', 'btn small' + (this.videoBudget === 'speaker' ? ' on' : ' ghost'), '발표자·교사만');
      b1.onclick = () => this.setBudget('all');
      b2.onclick = () => this.setBudget('speaker');
      budget.append(b1, b2);
      box.append(budget);
      if (many && this.videoBudget === 'all') box.append(el('p', 'warn', '지금 13명이 넘습니다. ‘발표자·교사만’으로 두면 연결이 훨씬 가벼워져요.'));
      box.append(el('p', 'hint', '단축키: M 마이크 · V 카메라 · Y/N 찬반 투표 · 1~6 객관식'));
    }
  }

  timelineEditor(tl) {
    const wrap = el('div', 'tl-edit');
    const items = tl.map((s) => ({ ...s }));
    const redraw = () => {
      wrap.textContent = '';
      const list = el('div', 'tl-list');
      items.forEach((s, i) => {
        const row = el('div', 'tl-row');
        const title = el('input', 'in tl-title');
        title.value = s.title || '';
        title.maxLength = 80;
        title.placeholder = '단계 이름';
        title.oninput = () => { s.title = title.value; save(); };
        const kind = el('select', 'in tl-kind');
        for (const [k, label] of Object.entries(KIND_LABEL)) {
          const o = document.createElement('option');
          o.value = k; o.textContent = label;
          if (s.kind === k) o.selected = true;
          kind.append(o);
        }
        kind.onchange = () => { s.kind = kind.value; save(); };
        const min = el('input', 'in tl-min');
        min.type = 'number'; min.min = '0'; min.max = '180'; min.value = String(s.minutes ?? 0);
        min.oninput = () => { s.minutes = Math.max(0, Math.min(180, Number(min.value) || 0)); save(); };
        const up = el('button', 'btn icon tiny', '↑');
        up.onclick = () => { if (i > 0) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; redraw(); save(); } };
        const down = el('button', 'btn icon tiny', '↓');
        down.onclick = () => { if (i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; redraw(); save(); } };
        const del = el('button', 'btn icon tiny danger', '✕');
        del.onclick = () => { items.splice(i, 1); redraw(); save(); };
        row.append(title, kind, min, up, down, del);
        list.append(row);
      });
      wrap.append(list);
      const add = el('button', 'btn small ghost', '+ 단계 추가');
      add.onclick = () => { items.push({ id: `s${items.length + 1}-${Date.now() % 1000}`, kind: 'custom', title: '새 단계', minutes: 5, note: '' }); redraw(); save(); };
      wrap.append(add);
      wrap.append(el('p', 'hint', '이름·시간을 고치면 바로 저장되고 학생 화면에도 반영됩니다.'));
    };
    let t = null;
    const save = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        this.act(() => this.api.timeline(this.code, this.key, items.map((s) => ({ ...s }))), { notice: '타임라인을 저장했어요.' });
      }, 700);
    };
    redraw();
    return wrap;
  }

  async jumpStep(i) {
    if (!this.isHost) return;
    const res = await this.act(() => this.api.step(this.code, this.key, i));
    if (res) this.onNotice(`‘${this.session.timeline?.[i]?.title ?? i + 1}’ 단계로 넘어갔어요.`);
  }

  nextStep() {
    const { index } = this.stepInfo();
    const last = (this.session.timeline?.length ?? 1) - 1;
    if (index >= last) { this.onNotice('마지막 단계예요. 수업을 마치려면 AI 리포트를 만들어 보세요.'); return; }
    this.jumpStep(index + 1);
  }

  // ---------- 투표 패널 ----------
  renderPoll() {
    const box = document.getElementById('pane-poll');
    box.textContent = '';
    const poll = this.state.poll;
    const head = el('div', 'rail-head');
    head.append(el('h3', null, '즉석 투표'));
    if (this.isHost) {
      const b = el('button', 'btn small ghost', poll ? '새 투표' : '투표 열기');
      b.onclick = () => this.openPollDialog();
      head.append(b);
    }
    box.append(head);

    if (!poll) {
      box.append(el('p', 'muted', this.isHost ? '아직 연 투표가 없어요. ‘투표 열기’로 찬반·객관식·한 줄 의견을 바로 물어보세요.' : '선생님이 투표를 열면 여기에 나타납니다.'));
      return;
    }
    const card = el('div', 'poll-card');
    const top = el('div', 'poll-top');
    top.append(
      el('span', `badge ${poll.type}`, poll.type === 'yesno' ? '찬반' : poll.type === 'choice' ? '객관식' : '한 줄 의견'),
      el('span', 'poll-status', poll.status === 'open' ? '진행 중' : '마감'),
      el('span', 'poll-total', `${poll.total}명 참여`),
    );
    card.append(top);
    card.append(el('p', 'poll-q', poll.question));

    if (poll.type === 'text') {
      const list = el('ul', 'poll-texts');
      for (const t of poll.texts.slice(-30)) {
        const li = el('li');
        li.append(el('b', null, t.name + ': '), document.createTextNode(t.text));
        list.append(li);
      }
      if (!poll.texts.length) list.append(el('li', 'muted', '아직 적은 의견이 없어요.'));
      card.append(list);
      if (poll.status === 'open' && !poll.my_vote) {
        const ta = el('textarea', 'in poll-in');
        ta.rows = 2; ta.maxLength = 500; ta.placeholder = '한 줄로 의견을 적어 주세요 (Enter 로 보냄)';
        ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.voteText(ta.value); } };
        const send = el('button', 'btn small primary', '의견 보내기');
        send.onclick = () => this.voteText(ta.value);
        card.append(ta, send);
      } else if (poll.my_vote?.text) {
        card.append(el('p', 'hint', `내 의견: ${poll.my_vote.text}`));
      }
    } else {
      const total = poll.counts.reduce((a, b) => a + b, 0) || 0;
      const bars = el('ul', 'poll-bars');
      poll.options.forEach((opt, i) => {
        const c = poll.counts[i] || 0;
        const pct = total ? Math.round((c / total) * 100) : 0;
        const li = el('li', 'poll-bar');
        li.style.setProperty('--c', OPINION_COLORS[i % OPINION_COLORS.length]);
        li.style.setProperty('--p', `${pct}%`);
        const mine = poll.my_vote && poll.my_vote.choice === i;
        if (mine) li.classList.add('mine');
        li.append(el('span', 'pb-label', `${poll.type === 'yesno' ? (i === 0 ? '찬성 (Y)' : '반대 (N)') : opt}`));
        li.append(el('span', 'pb-count', `${c}명 · ${pct}%`));
        if (poll.status === 'open') {
          li.classList.add('clickable');
          li.onclick = () => this.vote(i);
        }
        bars.append(li);
      });
      card.append(bars);
      if (poll.status === 'open') {
        card.append(el('p', 'hint', poll.my_vote ? '다른 보기를 누르면 표가 바뀝니다.' : '보기를 눌러 투표하세요 (찬반은 Y / N 키).'));
      }
      // 의견이 갈렸는지 한 줄 요약
      if (total >= 3) {
        const max = Math.max(...poll.counts);
        const min = Math.min(...poll.counts.filter((_, i) => i < poll.options.length));
        card.append(el('p', 'poll-split', max - min <= Math.max(1, total * 0.15) ? '의견이 팽팽합니다 — 분반에서 양쪽을 섞어 보세요.' : '의견이 한쪽으로 모였습니다 — 반대편 이유를 물어보세요.'));
      }
    }

    if (this.isHost && poll.status === 'open') {
      const close = el('button', 'btn small', '투표 마감');
      close.onclick = () => this.act(() => this.api.closePoll(this.code, this.key), { notice: '투표를 마감했어요.' });
      card.append(close);
    }
    box.append(card);

    if (this.isHost) {
      const brk = el('button', 'btn small ghost', '이 투표 결과로 분반 (의견 섞기)');
      brk.onclick = () => this.openBreakDialog('opinion');
      box.append(brk);
    }
  }

  async vote(choice) {
    const poll = this.state.poll;
    if (!poll || poll.status !== 'open') return;
    const res = await this.act(() => this.api.vote(this.code, this.key, { poll_id: poll.id, choice }));
    if (res) this.onNotice(poll.type === 'yesno' ? (choice === 0 ? '찬성에 표를 냈어요.' : '반대에 표를 냈어요.') : '표를 냈어요.');
  }

  async voteText(value) {
    const text = String(value || '').trim();
    if (!text) return;
    await this.act(() => this.api.vote(this.code, this.key, { poll_id: this.state.poll.id, text }));
  }

  // ---------- 참여자 패널 ----------
  renderPeople() {
    const box = document.getElementById('pane-people');
    box.textContent = '';
    const head = el('div', 'rail-head');
    head.append(el('h3', null, '참여자 · 발화량'));
    box.append(head);
    const people = [...this.participants].sort((a, b) => Number(b.talk_seconds) - Number(a.talk_seconds));
    const total = people.reduce((a, p) => a + Number(p.talk_seconds), 0) || 1;
    const students = people.filter((p) => p.role !== 'host');
    const mean = students.length ? students.reduce((a, p) => a + Number(p.talk_seconds), 0) / students.length : 0;
    const list = el('ul', 'people');
    for (const p of people) {
      const sec = Number(p.talk_seconds) || 0;
      const li = el('li', 'person');
      li.style.setProperty('--c', `hsl(${hue(p.key)} 65% 55%)`);
      li.style.setProperty('--w', `${Math.round((sec / total) * 100)}%`);
      const nm = el('span', 'p-name', p.name + (p.key === this.key ? ' (나)' : ''));
      if (p.role === 'host') nm.append(el('span', 'badge host', '교사'));
      if (p.key !== this.key && p.breakout_group !== 'main') nm.append(el('span', 'badge grp', p.breakout_group.replace('group-', '') + '모둠'));
      if (!p.online) nm.append(el('span', 'badge off', '자리 비움'));
      li.append(nm, el('span', 'p-sec', mmss(sec)));
      if (p.role !== 'host' && mean > 8 && sec < mean * 0.5) li.classList.add('low');
      if (p.online && this.state.poll?.by_key && typeof this.state.poll.by_key[p.key] === 'number') {
        const c = document.createElement('i');
        c.className = 'p-dot';
        c.style.setProperty('--c', OPINION_COLORS[this.state.poll.by_key[p.key] % OPINION_COLORS.length]);
        li.append(c);
      }
      list.append(li);
    }
    box.append(list);
    if (this.isHost) {
      box.append(el('p', 'hint', '학생 평균의 절반보다 적게 말한 학생이 주황색입니다. 발화 순서를 돌아가며 주면 좋아요.'));
    }
  }

  // ---------- 워크북 ----------
  renderBook() {
    const box = document.getElementById('pane-book');
    box.textContent = '';
    const head = el('div', 'rail-head');
    head.append(el('h3', null, '공동 워크북'));
    box.append(head);

    const groups = this.groupList();
    if (!this.bookGroup || !groups.includes(this.bookGroup)) this.bookGroup = this.myGroup;
    if (this.isHost && groups.length > 1) {
      const sel = el('select', 'in book-sel');
      for (const g of groups) {
        const o = document.createElement('option');
        o.value = g; o.textContent = g === 'main' ? '전체 방' : `${g.replace('group-', '')}모둠`;
        if (g === this.bookGroup) o.selected = true;
        sel.append(o);
      }
      sel.onchange = () => { this.bookGroup = sel.value; this.renderBook(); };
      box.append(sel);
    } else {
      box.append(el('p', 'hint', this.myGroup === 'main' ? '전체 방 워크북 — 모든 참가자가 함께 씁니다.' : `${this.myGroup.replace('group-', '')}모둠 워크북`));
    }

    const note = this.bookGroup === this.myGroup
      ? this.state.workbook
      : (this.state.workbooks || []).find((w) => w.group_id === this.bookGroup);
    const ta = el('textarea', 'in book-area');
    ta.rows = 12;
    ta.maxLength = 20000;
    ta.placeholder = '모둠에서 나온 생각을 적어 두세요.\n예)\n· 우리 모둠 주장:\n· 근거 3가지:\n· 아직 의문인 것:';
    ta.value = note?.content ?? '';
    ta.oninput = () => this.saveBook(ta.value);
    box.append(ta);
    const status = el('p', 'hint', note?.updated_by ? `마지막 저장: ${note.updated_by} · ${new Date(note.updated_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '아직 적은 내용이 없어요.');
    status.id = 'book-status';
    box.append(status);
    if (this.isHost) {
      const others = (this.state.workbooks || []).filter((w) => w.group_id !== this.bookGroup && w.content);
      if (others.length) {
        const ul = el('ul', 'book-others');
        for (const w of others) {
          const li = el('li');
          li.append(el('b', null, w.group_id === 'main' ? '전체 방' : `${w.group_id.replace('group-', '')}모둠: `), document.createTextNode(w.content.slice(0, 90)));
          li.onclick = () => { this.bookGroup = w.group_id; this.renderBook(); };
          ul.append(li);
        }
        box.append(el('h4', 'rail-sub', '다른 모둠 기록'), ul);
      }
    }
  }

  saveBook(content) {
    const group = this.bookGroup || this.myGroup;
    this.bookDirty = true;
    clearTimeout(this.bookTimer);
    const status = document.getElementById('book-status');
    if (status) status.textContent = '저장 중…';
    this.bookTimer = setTimeout(async () => {
      const res = await this.act(() => this.api.saveWorkbook(this.code, this.key, group, content), { reload: false });
      this.bookDirty = false;
      const st = document.getElementById('book-status');
      if (st) st.textContent = res ? `저장됨 · ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '저장하지 못했어요.';
      this.broadcast();
    }, 900);
  }

  groupList() {
    const set = new Set(['main']);
    for (const p of this.participants) if (p.breakout_group && p.breakout_group !== 'main') set.add(p.breakout_group);
    for (const w of this.state.workbooks || []) set.add(w.group_id);
    if (this.myGroup) set.add(this.myGroup);
    return [...set].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b, 'ko', { numeric: true })));
  }

  // ---------- 모둠 관제 ----------
  renderGroups() {
    const box = document.getElementById('pane-groups');
    box.textContent = '';
    const cfg = this.session.breakout_config || {};
    const head = el('div', 'rail-head');
    head.append(el('h3', null, '모둠 · 분반 관제'));
    if (this.isHost) {
      const b = el('button', 'btn small ghost', cfg.active ? '분반 설정' : '분반 시작');
      b.onclick = () => this.openBreakDialog();
      head.append(b);
    }
    box.append(head);

    if (!cfg.active) {
      box.append(el('p', 'muted', this.isHost
        ? '아직 분반하지 않았어요. 3~4명씩 나누면 소그룹에서는 화질이 자동으로 올라갑니다.'
        : '선생님이 소그룹으로 나누면 여기에서 우리 모둠을 볼 수 있어요.'));
      return;
    }
    box.append(el('p', 'hint', `${cfg.groups}개 모둠 · 모둠당 ${cfg.size}명 · ${cfg.mode === 'opinion' ? '의견 섞기' : '무작위'}`));

    const byGroup = new Map();
    for (const p of this.participants) {
      const g = p.breakout_group || 'main';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    }
    const notes = new Map((this.state.workbooks || []).map((w) => [w.group_id, w]));
    const keys = [...byGroup.keys()].filter((g) => g !== 'main').sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
    for (const g of keys) {
      const people = byGroup.get(g).slice().sort((a, b) => Number(b.talk_seconds) - Number(a.talk_seconds));
      const note = notes.get(g);
      const card = el('div', 'grp-card' + (g === this.myGroup ? ' mine' : ''));
      const ch = el('div', 'grp-head');
      ch.append(el('b', null, `${g.replace('group-', '')}모둠`), el('span', null, `${people.length}명 · 발화 ${mmss(people.reduce((a, p) => a + Number(p.talk_seconds), 0))}`));
      card.append(ch);
      const ul = el('ul', 'grp-people');
      for (const p of people) {
        const li = el('li');
        li.append(el('span', 'gp-name', p.name + (p.role === 'host' ? ' (교사)' : '')), el('span', 'gp-sec', mmss(p.talk_seconds)));
        if (p.online) li.classList.add('on');
        ul.append(li);
      }
      card.append(ul);
      if (note?.content) card.append(el('p', 'grp-note', note.content.slice(0, 160)));
      else card.append(el('p', 'grp-note muted', '워크북 비어 있음'));
      box.append(card);
    }
    if (this.isHost) {
      const back = el('button', 'btn small', cfg.active ? '전체 방으로 돌아가기' : '분반 없음');
      back.onclick = () => this.act(() => this.api.breakout(this.code, this.key, { mode: 'clear' }), { notice: '전체 방으로 모였어요.' });
      box.append(back);
    }
  }

  renderBanner() {
    const bar = document.getElementById('rm-banner');
    const txt = document.getElementById('rm-banner-text');
    const act = document.getElementById('rm-banner-act');
    const cfg = this.session.breakout_config || {};
    act.hidden = true;
    if (this.session.status === 'ended') {
      bar.hidden = false; txt.textContent = '수업이 끝났습니다. 워크북과 AI 리포트는 그대로 남아 있어요.';
      return;
    }
    if (cfg.active && this.myGroup !== 'main') {
      bar.hidden = false;
      txt.textContent = `지금은 소그룹 토론 — ${this.myGroup.replace('group-', '')}모둠 (${cfg.size}명). 분반에서는 화질이 자동으로 올라갑니다.`;
      if (this.isHost) {
        act.hidden = false; act.textContent = '전체 방으로';
        this.bannerAction = () => this.act(() => this.api.breakout(this.code, this.key, { mode: 'clear' }), { notice: '전체 방으로 모였어요.' });
      }
      return;
    }
    bar.hidden = true;
  }

  // ---------- 분반/투표/리포트 대화상자 ----------
  openModal(title, bodyNode, footNodes = []) {
    const modal = document.getElementById('modal');
    document.getElementById('modal-title').textContent = title;
    const body = document.getElementById('modal-body');
    body.textContent = '';
    body.append(bodyNode);
    const foot = document.getElementById('modal-foot');
    foot.textContent = '';
    for (const n of footNodes) foot.append(n);
    modal.hidden = false;
    document.getElementById('modal-x').onclick = () => this.closeModal();
    modal.onclick = (e) => { if (e.target === modal) this.closeModal(); };
    const first = body.querySelector('input, select, textarea, button');
    if (first) setTimeout(() => first.focus(), 40);
    this.modalOpen = true;
  }

  closeModal() {
    document.getElementById('modal').hidden = true;
    this.modalOpen = false;
  }

  openPollDialog() {
    const wrap = el('div', 'form');
    const type = el('select', 'in');
    for (const [v, t] of [['yesno', '찬반 (찬성/반대)'], ['choice', '객관식 (보기 2~6개)'], ['text', '한 줄 의견']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; type.append(o);
    }
    const q = el('input', 'in');
    q.maxLength = 300;
    q.placeholder = '예: 안락사는 허용되어야 하는가?';
    const opts = el('textarea', 'in');
    opts.rows = 4;
    opts.placeholder = '객관식일 때 보기를 한 줄에 하나씩\n예:\n찬성\n반대\n조건부 찬성';
    opts.hidden = true;
    const lblType = el('label', 'lbl', '투표 종류');
    const lblQ = el('label', 'lbl', '질문');
    type.onchange = () => { opts.hidden = type.value !== 'choice'; };
    wrap.append(lblType, type, lblQ, q, opts);
    const go = el('button', 'btn primary', '투표 열기');
    go.onclick = async () => {
      const question = q.value.trim();
      if (!question) { this.onNotice('질문을 적어 주세요.'); return; }
      const options = type.value === 'choice' ? opts.value.split('\n').map((x) => x.trim()).filter(Boolean) : [];
      if (type.value === 'choice' && options.length < 2) { this.onNotice('보기를 2개 이상 적어 주세요.'); return; }
      go.disabled = true;
      const res = await this.act(() => this.api.openPoll(this.code, this.key, { type: type.value, question, options }), { notice: '투표를 열었어요.' });
      go.disabled = false;
      if (res) { this.closeModal(); this.showPane('poll'); }
    };
    this.openModal('즉석 투표 열기', wrap, [go]);
  }

  openBreakDialog(defaultMode = 'random') {
    const wrap = el('div', 'form');
    const size = el('select', 'in');
    for (const n of [2, 3, 4, 5, 6]) {
      const o = document.createElement('option'); o.value = String(n); o.textContent = `${n}명씩`; if (n === 4) o.selected = true; size.append(o);
    }
    const mode = el('select', 'in');
    for (const [v, t] of [['opinion', '의견 섞기 (찬반이 다른 사람끼리)'], ['random', '무작위']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === defaultMode) o.selected = true; mode.append(o);
    }
    wrap.append(el('label', 'lbl', '모둠 크기'), size, el('label', 'lbl', '나누는 방식'), mode);
    const hasPoll = Boolean(this.state.poll);
    if (!hasPoll) wrap.append(el('p', 'hint', '아직 투표 결과가 없어 ‘의견 섞기’는 무작위로 처리됩니다.'));
    const n = this.participants.length;
    wrap.append(el('p', 'hint', `지금 ${n}명 → 약 ${Math.max(1, Math.ceil(n / Number(size.value)))}개 모둠`));
    size.onchange = () => {
      const last = wrap.querySelector('.hint:last-child');
      if (last) last.textContent = `지금 ${n}명 → 약 ${Math.max(1, Math.ceil(n / Number(size.value)))}개 모둠`;
    };
    const go = el('button', 'btn primary', '분반 시작');
    go.onclick = async () => {
      go.disabled = true;
      const res = await this.act(() => this.api.breakout(this.code, this.key, { mode: mode.value, size: Number(size.value) }), { notice: '모둠을 나눴어요. 분반에서는 화질이 올라갑니다.' });
      go.disabled = false;
      if (res) { this.closeModal(); this.showPane('groups'); }
    };
    this.openModal('소그룹 분반', wrap, [go]);
  }

  async openReportDialog() {
    const wrap = el('div', 'form');
    const existing = this.state.last_report;
    wrap.append(el('p', 'hint', '참가자 발화량·투표 결과·모둠 워크북을 모아 교사용 리포트와 학생 피드백 초안을 만듭니다. (학교 AI 허브 사용)'));
    if (existing) {
      const card = el('div', 'report-prev');
      card.append(el('b', null, '지난 리포트'), el('p', null, existing.summary));
      wrap.append(card);
    }
    const run = el('button', 'btn primary', '리포트 만들기');
    const out = el('div', 'report-out');
    wrap.append(out);
    run.onclick = async () => {
      run.disabled = true;
      out.textContent = '만드는 중… (10~30초)';
      try {
        const res = await this.api.aiReport(this.code, this.key);
        out.textContent = '';
        this.renderReport(out, res);
        await this.refresh();
      } catch (e) {
        out.textContent = e.message || '리포트를 만들지 못했어요.';
      }
      run.disabled = false;
    };
    this.openModal('AI 참여 리포트', wrap, [run]);
  }

  renderReport(box, res) {
    const r = res.report || {};
    const m = r.metrics || {};
    const card = el('div', 'report');
    card.append(el('p', 'report-sum', r.summary || '요약이 없습니다.'));
    if (m.total_people) {
      const stats = el('div', 'report-stats');
      for (const [label, value] of [
        ['참여', `${m.total_people}명`],
        ['학생 발화', `${m.student_share ?? 0}%`],
        ['1인 평균', mmss(m.mean_seconds || 0)],
        ['발언 참여', `${m.participation ?? 0}%`],
        ['수업 시간', `${m.minutes ?? 0}분`],
      ]) {
        const c = el('div', 'stat');
        c.append(el('b', null, String(value)), el('span', null, label));
        stats.append(c);
      }
      card.append(stats);
    }
    if (Array.isArray(r.highlights) && r.highlights.length) {
      const ul = el('ul', 'report-list');
      for (const h of r.highlights) ul.append(el('li', null, h));
      card.append(el('h4', 'rail-sub', '눈에 띈 점'), ul);
    }
    if (Array.isArray(r.students) && r.students.length) {
      const ul = el('ul', 'report-students');
      for (const s of r.students) {
        const li = el('li');
        li.append(el('b', null, `${s.name}`), el('span', 'rs-talk', s.talk || ''), el('p', null, s.note || ''));
        ul.append(li);
      }
      card.append(el('h4', 'rail-sub', '학생 피드백 초안'), ul);
    }
    if (Array.isArray(r.tips) && r.tips.length) {
      const ul = el('ul', 'report-list');
      for (const t of r.tips) ul.append(el('li', null, t));
      card.append(el('h4', 'rail-sub', '다음 수업 제안'), ul);
    }
    const foot = el('div', 'report-foot');
    foot.append(el('span', 'hint', `${res.fallback ? '규칙 기반 초안' : 'AI 초안'} · ${res.model || ''}`));
    const copy = el('button', 'btn small ghost', '전체 복사');
    copy.onclick = () => {
      const text = [r.summary, '', ...(r.highlights || []), '', ...(r.students || []).map((s) => `${s.name} (${s.talk}): ${s.note}`), '', ...(r.tips || [])].join('\n');
      navigator.clipboard?.writeText(text).then(() => this.onNotice('리포트를 복사했어요.'), () => this.onNotice('복사하지 못했어요.'));
    };
    foot.append(copy);
    card.append(foot);
    box.append(card);
  }

  // ---------- 패널 탭 ----------
  bindRail() {
    for (const tab of document.querySelectorAll('.rtab')) {
      tab.onclick = () => this.showPane(tab.dataset.pane);
    }
  }

  showPane(name) {
    this.pane = name;
    for (const tab of document.querySelectorAll('.rtab')) tab.classList.toggle('on', tab.dataset.pane === name);
    for (const p of ['flow', 'poll', 'people', 'book', 'groups']) {
      const box = document.getElementById('pane-' + p);
      if (box) box.hidden = p !== name;
    }
    if (name === 'book') this.renderBook();
    if (name === 'groups') this.renderGroups();
  }

  // ---------- 나가기 ----------
  async leave() {
    if (this.session.status === 'open' && this.isHost) {
      if (!confirm('수업을 끝내고 나갈까요? 학생 화면에는 ‘수업 끝’으로 보입니다. (워크북·리포트는 남습니다)')) return;
      await this.act(() => this.api.end(this.code, this.key), { reload: false });
    }
    await this.classroom?.leave?.();
    this.destroy();
    this.unbindKeys();
    this.onLeave?.();
  }

  flushTalk() {
    const t = this.classroom?.flushTalk?.();
    if (t && t.seconds > 0) this.api.talk(this.code, this.key, t.seconds, 0).catch(() => { /* 다음에 */ });
  }

  updateTalkMine() { /* 발화량은 상태 새로고침으로 반영된다 */ }
}
