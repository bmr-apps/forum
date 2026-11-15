// 수업 참여 지표 → 교사용 리포트 + 학생 피드백 초안 (hub-ai)
//
//  · 입력: loadState() 가 만든 수업 상태(참가자 발화 초, 투표 결과, 모둠 워크북)
//  · 출력: { report: { summary, metrics, students[], tips[], highlights[] }, model, fallback }
//  · AI(hub-ai)가 없거나 답이 JSON 이 아니면, 계산으로 만든 기본 리포트(fallback)를 돌려준다.
//    → 교사는 언제나 '무언가 쓸 수 있는' 결과를 받는다.
import { askHubAi } from './lib/hub.ts';

export type StateLike = {
  code: string;
  session: { title: string; host_name: string; current_step_index: number; timeline: unknown[]; created_at: string; status: string };
  participants: { key: string; name: string; role: string; breakout_group: string; talk_seconds: number; signals_count: number }[];
  poll: { id: string; type: string; question: string; options: string[]; status: string; total: number; counts: number[]; texts: { name: string; text: string }[] } | null;
  workbooks?: { group_id: string; content: string }[] | null;
  workbook?: { group_id: string; content: string };
  server_time: string;
};

export type StudentFeedback = { name: string; talk: string; note: string };
export type Report = {
  summary: string;
  metrics: Record<string, unknown>;
  highlights: string[];
  students: StudentFeedback[];
  tips: string[];
  generated_by: 'ai' | 'rule';
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const mmss = (sec: number) => `${Math.floor(sec / 60)}분 ${String(Math.round(sec % 60)).padStart(2, '0')}초`;

function metricsOf(state: StateLike) {
  const people = state.participants.filter((p) => p.role !== 'host');
  const host = state.participants.find((p) => p.role === 'host') ?? null;
  const total = state.participants.reduce((a, p) => a + Number(p.talk_seconds || 0), 0);
  const studentTotal = people.reduce((a, p) => a + Number(p.talk_seconds || 0), 0);
  const sorted = [...people].sort((a, b) => Number(b.talk_seconds) - Number(a.talk_seconds));
  const mean = people.length ? studentTotal / people.length : 0;
  const quiet = people.filter((p) => Number(p.talk_seconds) < mean * 0.5);
  const silent = people.filter((p) => Number(p.talk_seconds) < 5);
  const talkers = state.participants.map((p) => ({
    name: p.name,
    role: p.role,
    breakout_group: p.breakout_group,
    seconds: Math.round(Number(p.talk_seconds || 0)),
    share: pct(Number(p.talk_seconds || 0), total),
    signals: Number(p.signals_count || 0),
  }));
  const steps = Array.isArray(state.session.timeline) ? state.session.timeline.length : 0;
  const minutes = Math.max(0, Math.round((Date.parse(state.server_time) - Date.parse(state.session.created_at)) / 60000));
  return {
    students: people.length, total_people: state.participants.length, minutes,
    total_talk_seconds: Math.round(total),
    student_talk_seconds: Math.round(studentTotal),
    host_share: host ? pct(Number(host.talk_seconds || 0), total) : 0,
    student_share: pct(studentTotal, total),
    mean_seconds: Math.round(mean),
    top: sorted.slice(0, 3).map((p) => ({ name: p.name, seconds: Math.round(Number(p.talk_seconds || 0)) })),
    quiet: quiet.map((p) => p.name),
    silent: silent.map((p) => p.name),
    talkers,
    participation: pct(people.length - silent.length, people.length),
    steps_total: steps, step_reached: Number(state.session.current_step_index) + 1 || 1,
    polls: state.poll ? [{ question: state.poll.question, type: state.poll.type, votes: state.poll.total, counts: state.poll.counts, options: state.poll.options, status: state.poll.status }] : [],
    workbook_chars: (state.workbooks ?? []).reduce((a, w) => a + String(w.content || '').length, 0) ||
      String(state.workbook?.content ?? '').length,
  };
}

/** AI 없이도 쓸 수 있는 기본 리포트 — 계산만으로 만든다 */
function ruleReport(state: StateLike, m: ReturnType<typeof metricsOf>): Report {
  const title = state.session.title || '수업';
  const highlights: string[] = [];
  if (m.top.length) highlights.push(`발화 상위: ${m.top.map((t) => `${t.name}(${mmss(t.seconds)})`).join(', ')}`);
  if (m.silent.length) highlights.push(`거의 말하지 않은 학생: ${m.silent.join(', ')}`);
  else if (m.quiet.length) highlights.push(`발화가 적은 편: ${m.quiet.join(', ')}`);
  if (m.host_share >= 50) highlights.push(`교사 발화 비율이 ${m.host_share}% 로 높습니다 — 학생 발화로 넘길 구간을 늘려 보세요.`);
  if (state.poll) highlights.push(`투표 「${state.poll.question}」 ${state.poll.total}명 참여`);
  const summary = `${title} — ${m.minutes}분 수업, ${m.total_people}명 참여. 학생 발화 ${mmss(m.student_talk_seconds)}(전체의 ${m.student_share}%), `
    + `1인 평균 ${mmss(m.mean_seconds)}, 발언에 참여한 학생 ${m.participation}%. `
    + (m.silent.length ? `${m.silent.length}명은 거의 발화가 없었습니다.` : '모두 한 번 이상 말했습니다.');
  const students: StudentFeedback[] = m.talkers.filter((t) => t.role !== 'host').map((t) => {
    const level = t.seconds >= m.mean_seconds * 1.5 ? '많이' : t.seconds >= m.mean_seconds * 0.5 ? '고르게' : '적게';
    return {
      name: t.name,
      talk: `${mmss(t.seconds)} (${t.share}%)`,
      note: t.seconds < 5
        ? '이번 수업에서 발화가 거의 없었어요. 다음 시간에 먼저 물어보고 짧게라도 말할 기회를 만들어 주세요.'
        : level === '많이'
          ? '토론을 이끌었어요. 다른 친구의 말을 요약해 주는 역할도 맡겨 보세요.'
          : level === '고르게'
            ? '고르게 참여했어요. 핵심을 한 문장으로 정리하는 연습을 더해 보세요.'
            : '발화가 적은 편이에요. 2인 짝 토론에서 먼저 말하게 하면 좋아요.',
    };
  });
  const tips = [
    m.host_share >= 50 ? '교사 설명 구간을 5분 이내로 줄이고, 질문 → 1분 생각 → 짝 공유 순서로 바꿔 보세요.' : '지금의 학생 발화 비율을 유지하세요.',
    m.silent.length ? `${m.silent.slice(0, 3).join(', ')}에게 다음 시간 첫 질문을 미리 알려 주면 참여가 늘어납니다.` : '발화가 고른 편이라 모둠별 심화 질문을 더해도 좋습니다.',
    m.steps_total ? `타임라인 ${m.steps_total}단계 중 ${m.step_reached}단계까지 진행했습니다.` : '타임라인을 미리 짜 두면 수업 전환이 빨라집니다.',
  ];
  return { summary, metrics: m, highlights, students, tips, generated_by: 'rule' };
}

/** AI 에 보낼 요약 — 개인정보를 줄이고 크기를 제한한다 */
function promptOf(state: StateLike, m: ReturnType<typeof metricsOf>) {
  const notes = (state.workbooks ?? [])
    .filter((w) => String(w.content || '').trim())
    .map((w) => `[${w.group_id}] ${String(w.content).slice(0, 600)}`)
    .join('\n') || String(state.workbook?.content ?? '').slice(0, 600);
  const talk = m.talkers.map((t) => `${t.name}(${t.role === 'host' ? '교사' : '학생'}, ${t.seconds}초, ${t.share}%)`).join(', ');
  const polls = m.polls.map((p) => `「${p.question}」 ${p.votes}명 참여, 결과 ${p.counts.join('/')} (보기: ${p.options.join('/')})`).join(' | ') || '없음';
  return [
    `수업 제목: ${state.session.title}`,
    `진행: ${m.minutes}분, 참여 ${m.total_people}명(학생 ${m.students}명), 타임라인 ${m.step_reached}/${m.steps_total}단계`,
    `발화: ${talk}`,
    `투표: ${polls}`,
    `모둠 워크북:\n${notes || '없음'}`,
  ].join('\n');
}

const SYSTEM = [
  '너는 한국의 대안학교(별무리학교) 수업을 돕는 교수 설계 조력자다.',
  '교사가 액티브 러닝(미네르바 포럼식) 수업을 돌아보도록, 발화량·투표·모둠 워크북 지표를 근거로 짧고 구체적인 한국어 피드백을 쓴다.',
  '학생을 평가하거나 낙인찍지 않는다. 관찰된 사실과 다음 수업에서 해 볼 행동을 제안한다.',
  '반드시 JSON 하나만 출력한다. 형식: {"summary": string, "highlights": string[], "students": [{"name": string, "talk": string, "note": string}], "tips": string[]}',
  'summary 는 3~5문장, students 는 발화가 있었던 학생 각각에 대해 note 한두 문장, tips 는 교사용 3~4개.',
].join(' ');

export async function buildReport(state: StateLike): Promise<{ report: Report; model: string; fallback: boolean }> {
  const m = metricsOf(state);
  const base = ruleReport(state, m);
  try {
    const ai = await askHubAi({
      system: SYSTEM,
      prompt: promptOf(state, m),
      response_mime_type: 'application/json',
      max_tokens: 2000,
      temperature: 0.4,
    });
    const raw = String(ai.text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('JSON 없음');
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const students = Array.isArray(parsed.students)
      ? parsed.students.map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { name: String(o.name ?? '').slice(0, 40), talk: String(o.talk ?? '').slice(0, 60), note: String(o.note ?? '').slice(0, 400) };
      }).filter((x) => x.name)
      : base.students;
    const report: Report = {
      summary: String(parsed.summary ?? '').slice(0, 2000) || base.summary,
      metrics: m,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map((x) => String(x).slice(0, 200)).slice(0, 8) : base.highlights,
      students: students.length ? students : base.students,
      tips: Array.isArray(parsed.tips) ? parsed.tips.map((x) => String(x).slice(0, 300)).slice(0, 8) : base.tips,
      generated_by: 'ai',
    };
    return { report, model: ai.model || ai.provider || 'hub-ai', fallback: false };
  } catch (e) {
    console.error('ai-report', (e as Error).message);
    return { report: base, model: 'rule', fallback: true };
  }
}
