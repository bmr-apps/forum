// src/rtc.js — 12명 경량 화상 교실 (WebRTC P2P mesh)
//
//  · 신호(SDP·ICE)는 Supabase Realtime 의 presence + broadcast 로 주고받습니다. 서버 함수가 필요 없습니다.
//  · 소리·영상은 화면끼리 P2P(mesh)로 오갑니다. 12명이면 각자 11개 연결을 가집니다.
//  · 연결은 **한쪽만** 만듭니다: 신분표(key) 문자열을 비교해 작은 쪽이 offer 를 냅니다(glare 없음).
//  · 전체 방은 아주 가볍게(160×120 · 10fps · 최대 120kbps), 소그룹 분반에서는 선명하게(480×360 · 15fps).
//    화질은 협상을 다시 하지 않고 applyConstraints + 송신 비트레이트로 바꿉니다.
//  · 남의 소리는 **영상 트랙 유무와 상관없이** 항상 별도 <audio> 로 붙입니다(화면이 꺼져도 목소리는 나야 하므로).
//  · 발화량: 내 마이크 소리 크기를 AnalyserNode 로 재서 '말한 초'를 누적합니다. 말하는 중 표시는 모두에게서 잽니다.
import { supabase } from './supabase.js';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
};

/** 말하는 중으로 볼 소리 크기 (0~1) */
const SPEAK_LEVEL = 0.028;

/** 전체 방 / 분반 화질 */
export const QUALITY = {
  main: { width: 160, height: 120, frameRate: 10, maxBitrate: 120_000 },
  group: { width: 480, height: 360, frameRate: 15, maxBitrate: 420_000 },
};

export class Classroom {
  /**
   * @param {{code:string, me:{key:string,name:string,role:string}, isHost:boolean, onChange:Function, onNotice:Function, onTalk:Function}} opts
   */
  constructor({ code, me, isHost, onChange = () => {}, onNotice = () => {}, onTalk = () => {} }) {
    this.code = code;
    this.me = { key: String(me.key), name: String(me.name || '나'), role: me.role || 'student' };
    this.isHost = Boolean(isHost);
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.onTalk = onTalk;

    this.joined = false;
    this.left = false;
    this.ch = null;
    this.stream = null;          // 내 마이크·카메라
    this.local = { micOn: false, camOn: false, speaking: false, listenOnly: false, quality: 'main' };
    this.peers = new Map();      // key → { key, name, role, group, stream, micOn, camOn, speaking, video }
    this.pcs = new Map();        // key → { pc, audioTx, videoTx, stream }
    this.pendingIce = new Map();
    this.analysers = new Map();  // 'me' | 'r:'+key → { ctx, an, buf }
    this.meterTimer = null;
    this.timers = [];
    this.talkBank = 0;           // 아직 서버에 안 보낸 '말한 초'
    this.signals = 0;
    this.sendVideoWanted = true; // 영상 보내기 여부(발표자 우선 모드에서 바뀜)
    this.sentVideo = undefined;  // 지금 실제로 보내는 트랙(또는 null)
    this.group = 'main';
  }

  // ---------- 화면에 그릴 참가자 ----------
  view() {
    const out = [{
      key: this.me.key, name: this.me.name, role: this.me.role, local: true,
      stream: this.stream, video: Boolean(this.local.camOn), micOn: Boolean(this.local.micOn),
      speaking: Boolean(this.local.speaking), group: this.group,
    }];
    for (const p of this.peers.values()) {
      out.push({
        key: p.key, name: p.name, role: p.role, local: false,
        stream: p.stream || null, video: Boolean(p.video && p.stream), micOn: Boolean(p.micOn),
        speaking: Boolean(p.speaking), group: p.group,
      });
    }
    return out;
  }

  get count() { return 1 + this.peers.size; }
  changed() { try { this.onChange(this); } catch (e) { console.error(e); } }
  notice(msg) { try { this.onNotice(msg); } catch { /* 무시 */ } }

  // ---------- 들어가기 ----------
  async join({ video = false, group = 'main' } = {}) {
    if (this.joined) return;
    this.joined = true;
    this.left = false;
    this.group = group;
    await this.acquire(video);
    this.changed();

    const ch = supabase.channel(`forum-rtc:${this.code}`, {
      config: { presence: { key: this.me.key }, broadcast: { self: false } },
    });
    this.ch = ch;
    ch.on('presence', { event: 'sync' }, () => this.syncPeers());
    ch.on('presence', { event: 'join' }, () => this.syncPeers());
    ch.on('presence', { event: 'leave' }, () => this.syncPeers());
    ch.on('broadcast', { event: 'forum-signal' }, (msg) => this.onSignal(msg && msg.payload));

    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { ch.track(this.presenceMeta()).catch(() => {}); finish(); }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish();
      });
      this.timers.push(setTimeout(() => {
        if (!done) { this.notice('실시간 연결이 늦어지고 있어요. 상태는 몇 초마다 새로 받아 옵니다.'); finish(); }
      }, 7000));
    });

    this.startMeters();
    this.changed();
  }

  /** 마이크·카메라 얻기 — 하나씩 실패해도 되는 것만 챙긴다 */
  async acquire(wantVideo) {
    const v = QUALITY.main;
    const tries = [];
    if (wantVideo) tries.push({ audio: true, video: { width: { ideal: v.width }, height: { ideal: v.height }, frameRate: { ideal: v.frameRate } } });
    tries.push({ audio: true, video: false });
    if (wantVideo) tries.push({ audio: false, video: true });
    for (const c of tries) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c);
        this.stream = s;
        this.local.micOn = s.getAudioTracks().length > 0;
        this.local.camOn = s.getVideoTracks().length > 0;
        return;
      } catch { /* 다음 시도 */ }
    }
    this.stream = new MediaStream();
    this.local.listenOnly = true;
    this.notice('마이크를 쓸 수 없어 듣기만 합니다. 브라우저 권한을 허용하면 다시 켤 수 있어요.');
  }

  async leave() {
    if (this.left) return;
    this.left = true;
    this.joined = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = null; }
    for (const a of this.analysers.values()) { try { a.ctx.close(); } catch { /* 무시 */ } }
    this.analysers.clear();
    for (const k of [...this.pcs.keys()]) this.dropPeer(k);
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* 무시 */ }
    this.stream = null;
    const ch = this.ch;
    this.ch = null;
    if (ch) {
      try { await ch.untrack(); } catch { /* 무시 */ }
      try { await supabase.removeChannel(ch); } catch { /* 무시 */ }
    }
    this.peers.clear();
    this.changed();
  }

  // ---------- 신호 ----------
  presenceMeta() {
    return {
      name: this.me.name, role: this.me.role, group: this.group,
      audio: Boolean(this.local.micOn), video: Boolean(this.local.camOn && this.sendVideoWanted),
    };
  }

  async updatePresence() {
    if (!this.ch) return;
    try { await this.ch.track(this.presenceMeta()); } catch { /* 다음 신호에서 */ }
  }

  signal(to, data) {
    if (!this.ch) return;
    try {
      this.ch.send({ type: 'broadcast', event: 'forum-signal', payload: { from: this.me.key, to: String(to), ...data } });
    } catch (e) { console.error('signal', e); }
  }

  peerOf(key) { return this.peers.get(String(key)) || null; }

  addPeer(key, name, meta = {}) {
    const p = {
      key: String(key), name: name || '참가자', role: meta.role || 'student', group: meta.group || 'main',
      micOn: false, camOn: false, video: false, stream: null, speaking: false,
    };
    this.peers.set(p.key, p);
    return p;
  }

  /** 접속자 목록이 바뀔 때마다 — 같은 모둠 사람과만 연결하고, 사라진 사람 정리 */
  syncPeers() {
    if (!this.ch) return;
    const state = (this.ch.presenceState && this.ch.presenceState()) || {};
    const seen = new Set();
    for (const key of Object.keys(state)) {
      if (key === this.me.key) continue;
      const meta = (state[key] && state[key][0]) || {};
      const inGroup = (meta.group || 'main') === this.group;
      if (!inGroup) continue;
      seen.add(key);
      const p = this.peerOf(key) || this.addPeer(key, String(meta.name || ''), { role: meta.role, group: meta.group });
      if (meta.name) p.name = String(meta.name);
      p.role = meta.role || p.role;
      p.group = meta.group || 'main';
      p.micOn = Boolean(meta.audio);
      p.video = Boolean(meta.video);
    }
    for (const key of [...this.peers.keys()]) if (!seen.has(key)) this.dropPeer(key);
    for (const key of seen) {
      if (!this.pcs.has(key) && this.me.key < key) this.offer(key).catch((e) => console.error('offer', e));
    }
    this.changed();
  }

  createPeer(key) {
    if (this.pcs.has(key)) return this.pcs.get(key);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry = { pc, audioTx: null, videoTx: null, stream: new MediaStream() };
    this.pcs.set(key, entry);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
      this.signal(key, { type: 'ice', candidate: c });
    };
    pc.ontrack = (e) => {
      try { entry.stream.addTrack(e.track); } catch { /* 이미 있음 */ }
      const p = this.peerOf(key);
      if (p) { p.stream = entry.stream; this.addMeter('r:' + key, entry.stream); this.changed(); }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.dropPeer(key);
    };
    return entry;
  }

  async applyBitrate(entry, kind) {
    const tx = kind === 'audio' ? entry.audioTx : entry.videoTx;
    if (!tx || !tx.sender) return;
    try {
      const params = tx.sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{ maxBitrate: kind === 'audio' ? 32_000 : QUALITY[this.local.quality].maxBitrate }];
      else params.encodings[0].maxBitrate = kind === 'audio' ? 32_000 : QUALITY[this.local.quality].maxBitrate;
      await tx.sender.setParameters(params);
    } catch { /* 브라우저에 따라 무시 */ }
  }

  async offer(key) {
    const entry = this.createPeer(key);
    if (entry.audioTx) return;
    entry.audioTx = entry.pc.addTransceiver('audio', { direction: 'sendrecv' });
    entry.videoTx = entry.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.sentVideo = undefined;
    await entry.audioTx.sender.replaceTrack(this.audioTrack()).catch(() => {});
    await entry.videoTx.sender.replaceTrack(this.videoTrack()).catch(() => {});
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    await this.applyBitrate(entry, 'video');
    this.signal(key, { type: 'offer', sdp: entry.pc.localDescription });
  }

  async answer(key, sdp) {
    const entry = this.createPeer(key);
    await entry.pc.setRemoteDescription(sdp);
    for (const tx of entry.pc.getTransceivers()) {
      const kind = (tx.receiver && tx.receiver.track && tx.receiver.track.kind)
        || (tx.sender && tx.sender.track && tx.sender.track.kind) || '';
      if (kind === 'audio' && !entry.audioTx) entry.audioTx = tx;
      if (kind === 'video' && !entry.videoTx) entry.videoTx = tx;
    }
    try { if (entry.audioTx) await entry.audioTx.sender.replaceTrack(this.audioTrack()); } catch { /* 무시 */ }
    try { if (entry.videoTx) await entry.videoTx.sender.replaceTrack(this.videoTrack()); } catch { /* 무시 */ }
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    this.signal(key, { type: 'answer', sdp: entry.pc.localDescription });
    await this.flushIce(key);
  }

  async onSignal(payload) {
    if (!payload || !payload.to || String(payload.to) !== this.me.key) return;
    const from = String(payload.from || '');
    if (!from || from === this.me.key) return;
    if (!this.peers.has(from)) {
      // presence 를 아직 못 받았어도 같은 모둠이면 받아 둔다
      this.addPeer(from, '', { group: this.group });
    }
    try {
      if (payload.type === 'offer') await this.answer(from, payload.sdp);
      else if (payload.type === 'answer') {
        const entry = this.pcs.get(from);
        if (entry && entry.pc.signalingState === 'have-local-offer') {
          await entry.pc.setRemoteDescription(payload.sdp);
          await this.flushIce(from);
        }
      } else if (payload.type === 'ice' && payload.candidate) {
        const entry = this.pcs.get(from);
        if (!entry || !entry.pc.remoteDescription) {
          if (!this.pendingIce.has(from)) this.pendingIce.set(from, []);
          this.pendingIce.get(from).push(payload.candidate);
        } else {
          try { await entry.pc.addIceCandidate(payload.candidate); } catch { /* 늦은 후보는 버림 */ }
        }
      }
    } catch (e) { console.error('signal', payload.type, e); }
  }

  async flushIce(key) {
    const list = this.pendingIce.get(key);
    const entry = this.pcs.get(key);
    if (!list || !entry) return;
    this.pendingIce.delete(key);
    for (const c of list) { try { await entry.pc.addIceCandidate(c); } catch { /* 무시 */ } }
  }

  dropPeer(key) {
    const k = String(key);
    const entry = this.pcs.get(k);
    if (entry) {
      // 받고 있던 트랙을 먼저 끊어 소리가 남지 않게 한다
      try { entry.stream.getTracks().forEach((t) => t.stop()); } catch { /* 무시 */ }
      try { entry.pc.close(); } catch { /* 무시 */ }
      this.pcs.delete(k);
    }
    this.pendingIce.delete(k);
    this.peers.delete(k);
    const a = this.analysers.get('r:' + k);
    if (a) { try { a.ctx.close(); } catch { /* 무시 */ } this.analysers.delete('r:' + k); }
    this.changed();
  }

  // ---------- 내 장치 ----------
  audioTrack() { return this.stream ? (this.stream.getAudioTracks()[0] || null) : null; }
  camTrack() { return this.stream ? (this.stream.getVideoTracks()[0] || null) : null; }
  /** 지금 보낼 영상 — 발표자 우선 모드에서 내 차례가 아니면 null(소리만 보냄) */
  videoTrack() {
    if (!this.sendVideoWanted || !this.local.camOn) return null;
    return this.camTrack();
  }

  async setSendVideo(on) {
    const want = Boolean(on);
    if (this.sendVideoWanted === want) return;
    this.sendVideoWanted = want;
    await this.attach('video', this.videoTrack());
    await this.updatePresence();
  }

  async attach(kind, track) {
    for (const entry of this.pcs.values()) {
      const tx = kind === 'audio' ? entry.audioTx : entry.videoTx;
      if (!tx) continue;
      try { await tx.sender.replaceTrack(track); } catch { /* 무시 */ }
    }
  }

  /** 분반·전체 방 전환 — 같은 모둠 사람과만 연결한다 */
  async setGroup(group) {
    if (this.group === group) return;
    this.group = group;
    for (const k of [...this.pcs.keys()]) this.dropPeer(k);
    await this.updatePresence();
    this.syncPeers();
    await this.applyQuality(group === 'main' ? 'main' : 'group');
  }

  /** 화질 바꾸기 — 협상 없이 constraints 만 바꾼다 */
  async applyQuality(quality) {
    if (this.local.quality === quality) return;
    this.local.quality = quality;
    const q = QUALITY[quality] ?? QUALITY.main;
    const track = this.camTrack();
    if (track) {
      try {
        await track.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } });
      } catch {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } } });
          const nt = s.getVideoTracks()[0];
          if (nt) {
            if (this.stream) { this.stream.getVideoTracks().forEach((t) => { this.stream.removeTrack(t); t.stop(); }); this.stream.addTrack(nt); }
            if (!this.sendVideoWanted) { this.sendVideoWanted = true; }
            await this.attach('video', this.videoTrack());
          }
        } catch { /* 화질 전환 실패는 수업을 막지 않는다 */ }
      }
    }
    for (const entry of this.pcs.values()) await this.applyBitrate(entry, 'video');
    this.changed();
  }

  async toggleMic() {
    let t = this.audioTrack();
    if (this.local.micOn && t) {
      t.enabled = false;
      this.local.micOn = false;
      this.local.speaking = false;
    } else {
      if (!t) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          t = s.getAudioTracks()[0];
          if (!this.stream) this.stream = new MediaStream();
          this.stream.addTrack(t);
          await this.attach('audio', t);
          this.addMeter('me', this.stream);
        } catch {
          this.notice('마이크를 켤 수 없어요. 브라우저의 마이크 권한을 확인해 주세요.');
          return;
        }
      } else t.enabled = true;
      this.local.micOn = true;
    }
    await this.updatePresence();
    this.changed();
  }

  async toggleCam() {
    if (this.local.camOn) {
      const t = this.camTrack();
      if (t) t.enabled = false;
      this.local.camOn = false;
      await this.attach('video', this.videoTrack());
      await this.updatePresence();
      this.changed();
      return;
    }
    let t = this.camTrack();
    if (!t) {
      const q = QUALITY[this.local.quality] ?? QUALITY.main;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } } });
        t = s.getVideoTracks()[0];
        if (!this.stream) this.stream = new MediaStream();
        this.stream.addTrack(t);
      } catch {
        this.notice('카메라를 켤 수 없어요. 브라우저 권한이나 다른 앱이 쓰고 있는지 확인해 주세요.');
        return;
      }
    } else t.enabled = true;
    this.local.camOn = true;
    if (!this.sendVideoWanted) this.sendVideoWanted = true;
    await this.attach('video', this.videoTrack());
    await this.updatePresence();
    this.changed();
  }

  // ---------- 소리 크기·발화량 ----------
  startMeters() {
    if (this.meterTimer) return;
    this.meterTimer = setInterval(() => this.pollLevels(), 300);
    if (this.stream) this.addMeter('me', this.stream);
  }

  addMeter(id, stream) {
    if (!stream || !stream.getAudioTracks().length) return;
    if (this.analysers.has(id)) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.analysers.set(id, { ctx, an, buf: new Uint8Array(an.frequencyBinCount) });
    } catch { /* 발화량 표시는 없어도 된다 */ }
  }

  pollLevels() {
    for (const [id, m] of this.analysers) {
      try {
        m.an.getByteTimeDomainData(m.buf);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; sum += v * v; }
        const on = Math.sqrt(sum / m.buf.length) > SPEAK_LEVEL;
        if (id === 'me') {
          if (on && this.local.micOn) this.talkBank += 0.3;
          if (Boolean(this.local.speaking) !== on) { this.local.speaking = on; this.changed(); }
        } else {
          const p = this.peerOf(id.slice(2));
          if (p && Boolean(p.speaking) !== on) { p.speaking = on; this.changed(); }
        }
      } catch { /* 무시 */ }
    }
  }

  /** 쌓인 발화 초를 서버로 보낸다 (화면이 주기적으로 부름) */
  flushTalk() {
    const sec = Math.round(this.talkBank * 10) / 10;
    if (sec <= 0) return { seconds: 0, signals: 0 };
    this.talkBank = 0;
    return { seconds: sec, signals: 0 };
  }

  myTalkSeconds() { return this.local.speaking ? this.talkBank : 0; }
}
