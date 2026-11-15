// src/preview.js — 체험 모드(학생 12명 시뮬레이션)
//
// 서버나 카메라 없이 화면 전체를 그대로 둘러보기 위한 '가짜 교실'입니다.
// api.js 와 같은 모양(step·openPoll·vote·breakout·saveWorkbook·aiReport …)을 갖고 있어서,
// 수업 화면 코드는 진짜 서버인지 체험 모드인지 몰라도 됩니다.
export const PREVIEW_STUDENTS = [
  { name: '김하늘', hue: 205 }, { name: '이서윤', hue: 330 }, { name: '박도윤', hue: 150 },
  { name: '최지우', hue: 25 }, { name: '정민준', hue: 265 }, { name: '한예린', hue: 95 },
  { name: '오시우', hue: 15 }, { name: '서윤아', hue: 185 }, { name: '남지호', hue: 300 },
  { name: '윤서진', hue: 120 }, { name: '강하람', hue: 45 }, { name: '임태오', hue: 240 },
];

const DEFAULT_TIMELINE = [
  { id: 'intro', kind: 'intro', title: '도입 — 오늘의 질문', minutes: 5, note: '질문을 던지고 1분 생각 시간을 줍니다.' },
  { id: 'poll', kind: 'poll', title: '즉석 투표 — 찬반', minutes: 5, note: '찬성/반대로 의견을 모읍니다.' },
  { id: 'breakout', kind: 'breakout', title: '소그룹 분반 — 토론', minutes: 12, note: '의견이 다른 사람끼리 3~4명으로 묶습니다.' },
  { id: 'share', kind: 'discuss', title: '전체 정리 — 모둠 나눔', minutes: 8, note: '모둠 워크북을 함께 봅니다.' },
];

/** 카메라 대신 쓸 그림 — 이름이 적힌 판이 천천히 흔들리는 영상 */
function fakeStream(label, hue) {
  try {
    const c = document.createElement('canvas');
    c.width = 480; c.height = 360;
    const g = c.getContext('2d');
    if (!g) return null;
    let t = 0;
    const draw = () => {
      const t2 = t++;
      g.fillStyle = `hsl(${hue} 62% ${38 + (t2 % 12)}%)`;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = `hsl(${hue} 70% 74% / .35)`;
      for (let i = 0; i < 4; i++) {
        const y = ((t2 * 0.7 + i * 90) % (c.height + 90)) - 45;
        g.fillRect(0, y, c.width, 26);
      }
      g.fillStyle = 'rgba(255,255,255,.92)';
      g.beginPath();
      g.arc(c.width / 2, c.height / 2 - 26, 54, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = `hsl(${hue} 55% 35%)`;
      g.font = '900 44px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(label).slice(0, 2), c.width / 2, c.height / 2 - 26);
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.fillRect(0, c.height - 46, c.width, 46);
      g.fillStyle = '#fff';
      g.font = '700 26px system-ui, sans-serif';
      g.fillText(label, c.width / 2, c.height - 22);
    };
    draw();
    const timer = setInterval(draw, 250);
    const s = c.captureStream ? c.captureStream(4) : null;
    if (!s) { clearInterval(timer); return null; }
    s.getVideoTracks()[0]?.addEventListener('ended', () => clearInterval(timer));
    s.__timer = timer;
    return s;
  } catch { return null; }
}

export class PreviewRoom {
  constructor({ hostName = '선생님' } = {}) {
    const now = Date.now();
    this.hostKey = 'p:host';
    this.me = { key: this.hostKey, name: hostName, role: 'host', breakout_group: 'main' };
    this.streams = new Map();
    this.speaking = new Map();
    this.students = PREVIEW_STUDENTS.map((s, i) => ({
      key: `p:s${i + 1}`,
      name: s.name,
      role: 'student',
      hue: s.hue,
      breakout_group: 'main',
      talk_seconds: Math.round(6 + Math.random() * 40),
      signals_count: 0,
      online: true,
      chattiness: i < 3 ? 0.55 : i < 8 ? 0.25 : 0.08,   // 발화가 많은/고른/적은 학생
    }));
    this.state = {
      code: 'DEMO12',
      me: { key: this.me.key, name: this.me.name, role: 'host', breakout_group: 'main' },
      session: {
        title: '체험 모드 — 10학년 중핵 「정의란 무엇인가」',
        host_name: this.me.name,
        status: 'open',
        current_step_index: 0,
        timeline: DEFAULT_TIMELINE.map((s) => ({ ...s })),
        breakout_config: {},
        created_at: new Date(now - 7 * 60000).toISOString(),
        updated_at: new Date().toISOString(),
        active_poll_id: null,
      },
      participants: [
        { key: this.me.key, name: this.me.name, role: 'host', breakout_group: 'main', talk_seconds: 62, signals_count: 0, online: true },
        ...this.students.map((s) => ({ key: s.key, name: s.name, role: 'student', breakout_group: s.breakout_group, talk_seconds: s.talk_seconds, signals_count: 0, online: true })),
      ],
      poll: null,
      workbook: { group_id: 'main', content: '', updated_by: '', updated_at: null },
      workbooks: [{ group_id: 'main', content: '', updated_by: '', updated_at: null }],
      last_report: null,
      server_time: new Date().toISOString(),
    };
    this.pollSeq = 0;
    this.workbook = new Map([['main', '']]);
    this.onChange = () => {};
    this.local = { micOn: true, camOn: false, listening: false };
    this.timer = null;
    this.startedAt = now;
  }

  /** 화면이 주기적으로 부르는 '가짜 수업 진행' — 말하고, 가끔 투표한다 */
  start(onChange) {
    this.onChange = onChange || (() => {});
    const tick = () => {
      const speaking = new Set();
      for (const s of this.students) {
        if (Math.random() < s.chattiness * 0.45) speaking.add(s.key);
        if (speaking.has(s.key)) s.talk_seconds += 1;
      }
      // 교사도 가끔 말한다
      for (const k of [...this.speaking.keys()]) this.speaking.set(k, speaking.has(k));
      this.speaking.set(this.me.key, Math.random() < 0.25);
      for (const p of this.state.participants) {
        if (p.key === this.me.key) { if (this.speaking.get(p.key)) p.talk_seconds += 1; continue; }
        const s = this.students.find((x) => x.key === p.key);
        if (s) p.talk_seconds = s.talk_seconds;
      }
      // 열린 투표에는 천천히 표가 쌓인다
      const poll = this.state.poll;
      if (poll && poll.status === 'open') {
        const answered = new Set((poll.by_key ? Object.keys(poll.by_key) : []));
        const left = this.students.filter((s) => !answered.has(s.key));
        if (left.length && Math.random() < 0.4) {
          const pick = left[Math.floor(Math.random() * left.length)];
          const size = poll.type === 'yesno' ? 2 : poll.options.length;
          const choice = Math.floor(Math.random() * size);
          this.castVote(pick, poll, choice);
        }
      }
      this.state.server_time = new Date().toISOString();
      this.onChange(this.state);
    };
    this.timer = setInterval(tick, 1000);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  castVote(student, poll, choice) {
    poll.by_key = poll.by_key || {};
    poll.by_key[student.key] = choice;
    poll.counts[choice] = (poll.counts[choice] || 0) + 1;
    poll.total = (poll.total || 0) + 1;
    if (poll.type === 'text') poll.texts.push({ name: student.name, text: '체험 모드 의견입니다.' });
  }

  streamFor(key) {
    if (key === this.me.key) return null; // 체험 모드에서는 내 카메라를 켜지 않는다
    if (!this.streams.has(key)) {
      const s = this.students.find((x) => x.key === key);
      if (s) this.streams.set(key, fakeStream(s.name, s.hue));
    }
    return this.streams.get(key) || null;
  }

  /** rtc.view() 와 같은 모양 */
  view() {
    const out = [{
      key: this.me.key, name: this.me.name, role: 'host', local: true,
      stream: null, video: false, micOn: true, speaking: Boolean(this.speaking.get(this.me.key)), group: 'main',
    }];
    for (const p of this.state.participants) {
      if (p.key === this.me.key) continue;
      const speaking = Boolean(this.speaking.get(p.key));
      out.push({
        key: p.key, name: p.name, role: p.role, local: false,
        stream: this.streamFor(p.key), video: true, micOn: true, speaking, group: p.breakout_group || 'main',
      });
    }
    return out;
  }

  async setGroup() { /* 체험 모드에서는 연결이 없다 */ }
  async applyQuality() { /* 없음 */ }
  async toggleMic() { this.local.micOn = !this.local.micOn; this.onChange(this.state); }
  async toggleCam() { this.local.camOn = !this.local.camOn; this.onChange(this.state); }
  flushTalk() { return { seconds: 0, signals: 0 }; }
  async leave() { this.stop(); }

  // ---------- api.js 와 같은 모양 ----------
  async step(index) {
    const tl = this.state.session.timeline;
    this.state.session.current_step_index = Math.max(0, Math.min(tl.length - 1, Number(index) || 0));
    this.onChange(this.state);
    return this.state;
  }

  async timeline(timeline) {
    this.state.session.timeline = timeline.map((s, i) => ({ ...s, id: s.id || `s${i + 1}` }));
    this.state.session.current_step_index = Math.min(this.state.session.current_step_index, timeline.length - 1);
    this.onChange(this.state);
    return this.state;
  }

  async openPoll({ type = 'yesno', question = '', options = [] }) {
    this.pollSeq += 1;
    const opts = type === 'yesno' ? ['찬성', '반대'] : type === 'choice' ? options : [];
    this.state.poll = {
      id: `demo-${this.pollSeq}`, type, question, options: opts, status: 'open',
      step_index: this.state.session.current_step_index,
      total: 0, counts: new Array(Math.max(type === 'text' ? 0 : opts.length, type === 'yesno' ? 2 : 0)).fill(0),
      texts: [], by_key: {}, my_vote: null,
    };
    this.state.session.active_poll_id = this.state.poll.id;
    this.onChange(this.state);
    return this.state;
  }

  async closePoll() {
    if (this.state.poll) this.state.poll.status = 'closed';
    this.onChange(this.state);
    return this.state;
  }

  async vote({ choice = null, text = '' }) {
    const poll = this.state.poll;
    if (!poll || poll.status !== 'open') return this.state;
    poll.by_key = poll.by_key || {};
    const before = poll.by_key[this.me.key];
    if (typeof before === 'number' && poll.counts[before] > 0) poll.counts[before] -= 1;
    if (typeof before === 'number') poll.total = Math.max(0, poll.total - 1);
    if (typeof choice === 'number') {
      poll.by_key[this.me.key] = choice;
      poll.counts[choice] = (poll.counts[choice] || 0) + 1;
      poll.total += 1;
    } else if (text) {
      poll.by_key[this.me.key] = -1;
      poll.texts.push({ name: this.me.name, text });
      poll.total += 1;
    }
    poll.my_vote = { choice, text };
    this.onChange(this.state);
    return this.state;
  }

  async breakout({ mode = 'random', size = 4 } = {}) {
    const people = this.state.participants;
    if (mode === 'clear') {
      for (const p of people) p.breakout_group = 'main';
      this.state.session.breakout_config = { active: false, size, mode, groups: 0 };
      this.workbook.set('main', this.workbook.get('main') ?? '');
      this.syncWorkbooks();
      this.onChange(this.state);
      return this.state;
    }
    // 의견 섞기 — 투표 결과가 있으면 다른 표끼리 번갈아
    let ordered = [...people];
    const poll = this.state.poll;
    if (mode === 'opinion' && poll && poll.by_key) {
      const buckets = new Map();
      for (const p of ordered) {
        const c = poll.by_key[p.key];
        const k = typeof c === 'number' ? String(c) : 'none';
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(p);
      }
      const lists = [...buckets.values()];
      ordered = [];
      let guard = 0;
      while (lists.some((l) => l.length) && guard++ < 100) for (const l of lists) if (l.length) ordered.push(l.shift());
    } else {
      ordered = ordered.sort(() => Math.random() - 0.5);
    }
    const groups = Math.max(1, Math.ceil(ordered.length / size));
    ordered.forEach((p, i) => { p.breakout_group = `group-${(i % groups) + 1}`; });
    for (let i = 1; i <= groups; i++) if (!this.workbook.has(`group-${i}`)) this.workbook.set(`group-${i}`, '');
    this.state.session.breakout_config = { active: true, size, mode, groups };
    this.syncWorkbooks();
    this.onChange(this.state);
    return this.state;
  }

  syncWorkbooks() {
    const list = [...this.workbook.entries()].map(([group_id, content]) => ({
      group_id, content, updated_by: content ? this.me.name : '', updated_at: content ? new Date().toISOString() : null,
    }));
    this.state.workbooks = list;
    const mine = this.me.breakout_group || 'main';
    const found = list.find((w) => w.group_id === mine);
    this.state.workbook = found ?? { group_id: mine, content: '', updated_by: '', updated_at: null };
  }

  async saveWorkbook(group, content) {
    this.workbook.set(group || 'main', content);
    this.syncWorkbooks();
    this.onChange(this.state);
    return { ok: true };
  }

  async talk() { return { ok: true }; }
  async end() { this.state.session.status = 'ended'; this.onChange(this.state); return this.state; }
  async stateRead() { return this.state; }

  async aiReport() {
    const people = this.state.participants.filter((p) => p.role !== 'host');
    const total = this.state.participants.reduce((a, p) => a + p.talk_seconds, 0);
    const mean = people.reduce((a, p) => a + p.talk_seconds, 0) / Math.max(1, people.length);
    const quiet = people.filter((p) => p.talk_seconds < mean * 0.5);
    const top = [...people].sort((a, b) => b.talk_seconds - a.talk_seconds).slice(0, 3);
    await new Promise((r) => setTimeout(r, 1200));
    const report = {
      summary: `[체험 모드 예시] ${this.state.session.title} — 12명 참여, 발화는 대체로 고른 편입니다. `
        + `상위 발화는 ${top.map((t) => t.name).join(', ')} 쪽에 몰렸고, ${quiet.slice(0, 2).map((q) => q.name).join(', ') || '일부'} 학생은 발화가 적었습니다. `
        + '투표에서 의견이 갈렸으니, 다음 시간에는 반대 의견을 먼저 말하게 하는 2인 인터뷰로 시작해 보세요.',
      metrics: { students: people.length, total_people: this.state.participants.length, minutes: 28, mean_seconds: Math.round(mean), host_share: 12, participation: 92 },
      highlights: [
        `발화 상위: ${top.map((t) => `${t.name}(${Math.round(t.talk_seconds)}초)`).join(', ')}`,
        quiet.length ? `발화가 적은 편: ${quiet.map((q) => q.name).join(', ')}` : '모두 고르게 발화했습니다.',
        this.state.poll ? `투표 「${this.state.poll.question}」 ${this.state.poll.total}명 참여` : '투표 없이 진행된 수업입니다.',
      ],
      students: people.slice(0, 12).map((p) => ({
        name: p.name,
        talk: `${Math.round(p.talk_seconds)}초`,
        note: p.talk_seconds >= mean * 1.4 ? '토론을 이끌었어요. 친구 말을 요약해 주는 역할도 맡겨 보세요.'
          : p.talk_seconds < mean * 0.5 ? '발화가 적은 편이에요. 짝 토론에서 먼저 말하게 해 보세요.'
            : '고르게 참여했어요. 핵심을 한 문장으로 정리하는 연습을 더해 보세요.',
      })),
      tips: [
        '교사 발화 비율을 30% 아래로 두고, 질문 뒤 1분 침묵(생각 시간)을 지켜 주세요.',
        '분반은 3~4명이 가장 활발합니다. 의견이 다른 사람끼리 묶으면 토론이 깊어집니다.',
        '모둠 워크북에 ‘아직 의문인 것’을 한 줄씩 남기게 하면 다음 수업 도입이 쉬워집니다.',
      ],
      generated_by: 'rule',
    };
    this.state.last_report = { id: 'demo', summary: report.summary, model: '체험 모드', created_at: new Date().toISOString() };
    this.onChange(this.state);
    return { report, model: '체험 모드', fallback: true, created_at: new Date().toISOString() };
  }
}
