// forum-fn — 별무리 액티브 러닝 포럼 서버 함수
//
// 주소: https://psupfmarnyxontorftio.supabase.co/functions/v1/forum-fn/<경로>
//
//   GET  /health                        DB·표 연결 확인 · 메일/허브 AI 준비 여부
//   GET  /hello                         부른 사람(user)과 준비 상태
//
// 수업 입장 (구글 로그인 없이도 코드+이름으로 들어옵니다)
//   POST /session/create {title, host_name}          수업 방 만들기 → {code, key, state}
//   GET  /session/lookup?code=…                       입장 코드 확인 (제목·인원·진행 여부)
//   POST /session/join   {code, name, key?}           입장/재입장 → {code, key, state}
//   GET  /session/state?code=&key=                    상태 한 번에 읽기 + 접속 유지(heartbeat)
//
// 수업 운영
//   POST /session/timeline {code, key, timeline}      수업 타임라인 저장 (진행자)
//   POST /session/step     {code, key, index}         단계 이동 (진행자)
//   POST /session/poll     {code, key, type, question, options?}   즉석 투표 열기 (진행자)
//   POST /session/poll/close {code, key}              투표 마감 (진행자)
//   POST /poll/vote        {code, key, poll_id, choice?, text?}    한 표 (마감 전 변경 가능)
//   POST /session/breakout {code, key, mode, size}    소그룹 분반 (random·opinion·clear)
//   GET  /workbook?code=&key=                         내 모둠 워크북
//   POST /workbook         {code, key, group, content} 워크북 저장 (모둠원·진행자)
//   POST /session/talk     {code, key, seconds, signals}  발화 시간 누적
//   POST /session/end      {code, key}                수업 끝내기 (진행자)
//   POST /ai-report        {code, key}                수업 참여 리포트 + 학생 피드백 초안 (진행자, hub-ai)
//   GET  /reports?code=&key=                          지난 리포트 목록 (진행자)
//
// 함수는 이 앱 전용 DB 계정(forum_fn, 개발자 계정 forum_dev 의 권한을 물려받음)으로 접속해 RLS 를 거치지 않습니다.
// 그래서 누가 무엇을 볼 수 있는지는 이 파일에서 직접 확인합니다 — 브라우저에는 표 권한을 주지 않습니다.
// 실시간 동기화는 Supabase Realtime 의 broadcast(방송) 채널 'forum:<code>' 로 하고,
// 이 함수는 저장·확인(heartbeat)과 진짜 상태의 기준점 역할을 합니다.
import postgres from 'npm:postgres@3.4.5';
import { checkHubAuth, healthJson, type HubUser } from './lib/hub.ts';
import { DDL, CHECK_TABLES, DEFAULT_TIMELINE } from './schema.ts';
import { buildReport } from './report.ts';

const FN = 'forum-fn';
const SCHEMA = 'forum';
const PREFIX = 'FORUM_';
const ORIGINS = ['https://apps.bmrschool.net', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];
const METHODS = 'GET, POST, OPTIONS';

const secret = (name: string) => Deno.env.get(PREFIX + name) ?? '';
const DB_URL = secret('DB_URL');
// 서버리스라 연결을 적게: 최대 2개, 20초 쉬면 닫음. 트랜잭션 풀러(6543)라 prepare 끔
const db = DB_URL ? postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} }) : null;
type Sql = ReturnType<typeof postgres>;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': METHODS,
    'Access-Control-Max-Age': '600', Vary: 'Origin',
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });

/** 손님(구글 로그인 안 함)도 쓸 수 있는 앱이라, 로그인 확인은 '있으면 쓰는' 정도로만 한다 */
const getUser = (req: Request): Promise<HubUser | null> => checkHubAuth(req);
const route = (req: Request) => {
  const p = new URL(req.url).pathname; const i = p.indexOf('/' + FN);
  return (i < 0 ? '/' : p.slice(i + FN.length + 1)).replace(/\/+$/, '') || '/';
};

// ---------- 표가 없으면 만들기 (콜드 스타트 1회) ----------
let schemaReady: Promise<void> | null = null;
type TableFlags = { sessions?: boolean; participants?: boolean; polls?: boolean; poll_votes?: boolean; workbook?: boolean; ai_reports?: boolean };

async function ensureSchema(sql: Sql): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    try {
      const [flags] = await sql.unsafe(CHECK_TABLES) as TableFlags[];
      const missing = ['sessions', 'participants', 'polls', 'poll_votes', 'workbook', 'ai_reports'].some((k) => !(flags as Record<string, boolean>)[k]);
      if (!missing) return;
      for (const ddl of DDL) {
        try { await sql.unsafe(ddl); } catch (e) { console.error('DDL', (e as Error).message); }
      }
    } catch (e) {
      console.error('ensureSchema', (e as Error).message);
      schemaReady = null; // 다음 요청에서 다시 시도
      throw e;
    }
  })();
  return schemaReady;
}

// ---------- 입력 다듬기 ----------
const clean = (v: unknown, max: number) =>
  String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v: unknown, max: number) =>
  String(v ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').slice(0, max);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(n = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return 'g:' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const KEY_RE = /^(u:[0-9a-fA-F-]{8,60}|g:[0-9a-f]{8,60})$/;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// ---------- 수업 상태 읽기 ----------
type SessionRow = {
  id: string; code: string; title: string; host_key: string; host_name: string; status: string;
  current_step_index: number; timeline: unknown; active_poll_id: string | null; breakout_config: unknown;
  created_at: string; updated_at: string;
};
type ParticipantRow = {
  user_key: string; name: string; role: string; breakout_group: string;
  talk_seconds: string | number; signals_count: number; online: boolean; joined_at: string;
};

async function sessionByCode(sql: Sql, code: string): Promise<SessionRow> {
  const [s] = await sql`
    select id, code, title, host_key, host_name, status, current_step_index, timeline, active_poll_id, breakout_config, created_at, updated_at
    from forum.sessions where code = ${code}`;
  if (!s) throw new HttpError(404, '그 입장 코드의 수업을 찾지 못했어요. 코드를 다시 확인해 주세요.');
  return s as SessionRow;
}

async function participantOf(sql: Sql, sessionId: string, key: string): Promise<ParticipantRow | null> {
  const [p] = await sql`
    select user_key, name, role, breakout_group, talk_seconds, signals_count,
           (last_seen > now() - interval '45 seconds') as online, joined_at
    from forum.participants where session_id = ${sessionId} and user_key = ${key}`;
  return (p as ParticipantRow) ?? null;
}

/**
 * 한 번에 내려주는 상태 — 화면이 이것만으로 그려진다.
 * 진행자에게는 모둠 워크북 전체와 지난 리포트 요약까지 함께 준다.
 */
async function loadState(sql: Sql, code: string, key: string) {
  const s = await sessionByCode(sql, code);
  const me = await participantOf(sql, s.id, key);
  if (!me) throw new HttpError(403, '이 수업에 들어온 기록이 없어요. 다시 입장해 주세요.');
  await sql`update forum.participants set last_seen = now() where session_id = ${s.id} and user_key = ${key}`;
  const isHost = s.host_key === key || me.role === 'host';

  const participants = await sql`
    select user_key, name, role, breakout_group, talk_seconds, signals_count,
           (last_seen > now() - interval '45 seconds') as online, joined_at
    from forum.participants where session_id = ${s.id}
    order by (case when role = 'host' then 0 else 1 end), joined_at asc`;

  // ---------- 지금 열린(또는 방금 마감한) 투표 ----------
  let poll = null;
  if (s.active_poll_id) {
    const [p] = await sql`
      select id, type, question, options, status, step_index, created_at
      from forum.polls where id = ${s.active_poll_id} and session_id = ${s.id}`;
    if (p) {
      const votes = await sql`select user_key, name, choice, text_answer from forum.poll_votes where poll_id = ${p.id} order by created_at asc`;
      const opts: string[] = Array.isArray(p.options) ? (p.options as string[]) : [];
      const size = p.type === 'yesno' ? 2 : p.type === 'choice' ? opts.length : 0;
      const counts = new Array(size).fill(0);
      const texts: { name: string; text: string }[] = [];
      const byKey: Record<string, number> = {};
      let mine: { choice: number | null; text: string } | null = null;
      for (const v of votes) {
        const c = typeof v.choice === 'number' ? v.choice : null;
        if (c != null && c >= 0 && c < size) { counts[c] += 1; byKey[String(v.user_key)] = c; }
        if (p.type === 'text' && v.text_answer) texts.push({ name: String(v.name ?? ''), text: String(v.text_answer) });
        if (v.user_key === key) mine = { choice: c, text: String(v.text_answer ?? '') };
      }
      poll = {
        id: String(p.id), type: String(p.type), question: String(p.question),
        options: p.type === 'yesno' ? ['찬성', '반대'] : opts,
        status: String(p.status), step_index: Number(p.step_index),
        total: votes.length, counts, texts, by_key: byKey, my_vote: mine,
      };
    }
  }

  // ---------- 워크북 ----------
  const myGroup = me.breakout_group || 'main';
  const [note] = await sql`
    select group_id, content, updated_by, updated_at from forum.workbook_notes
    where session_id = ${s.id} and group_id = ${myGroup}`;
  const workbook = note
    ? { group_id: String(note.group_id), content: String(note.content ?? ''), updated_by: String(note.updated_by ?? ''), updated_at: note.updated_at }
    : { group_id: myGroup, content: '', updated_by: '', updated_at: null };
  let workbooks = null;
  if (isHost) {
    const rows = await sql`
      select group_id, content, updated_by, updated_at from forum.workbook_notes
      where session_id = ${s.id} order by group_id`;
    workbooks = (rows as unknown as { group_id: string; content: string; updated_by: string; updated_at: string }[])
      .map((w) => ({ group_id: String(w.group_id), content: String(w.content ?? ''), updated_by: String(w.updated_by ?? ''), updated_at: w.updated_at }));
  }

  const [last] = await sql`select id, summary, model, created_at from forum.ai_reports where session_id = ${s.id} order by id desc limit 1`;

  return {
    code: s.code,
    me: { key, name: me.name, role: isHost ? 'host' : me.role, breakout_group: myGroup },
    session: {
      title: s.title, host_name: s.host_name, status: s.status,
      current_step_index: Number(s.current_step_index),
      timeline: Array.isArray(s.timeline) ? s.timeline : [],
      breakout_config: s.breakout_config ?? {},
      created_at: s.created_at, updated_at: s.updated_at,
      active_poll_id: s.active_poll_id ? String(s.active_poll_id) : null,
    },
    participants: (participants as unknown as ParticipantRow[]).map((p) => ({
      key: p.user_key, name: p.name, role: p.role, breakout_group: p.breakout_group,
      talk_seconds: Number(p.talk_seconds ?? 0), signals_count: Number(p.signals_count ?? 0),
      online: Boolean(p.online), joined_at: p.joined_at,
    })),
    poll,
    workbook,
    workbooks,
    last_report: last ? { id: String(last.id), summary: String(last.summary ?? ''), model: String(last.model ?? ''), created_at: last.created_at } : null,
    server_time: new Date().toISOString(),
  };
}

/** 진행자만 할 수 있는 일 */
function needHost(s: SessionRow, key: string) {
  if (s.host_key !== key) throw new HttpError(403, '진행자만 할 수 있는 일이에요.');
}
function needOpen(s: SessionRow) {
  if (s.status !== 'open') throw new HttpError(409, '이미 끝난 수업이에요.');
}

// ---------- 타임라인 다듬기 ----------
type Step = { id: string; kind: string; title: string; minutes: number; note?: string };
const KINDS = new Set(['intro', 'poll', 'breakout', 'discuss', 'wrap', 'custom']);
function cleanTimeline(v: unknown): Step[] {
  if (!Array.isArray(v)) throw new HttpError(400, '타임라인 형식이 올바르지 않습니다.');
  if (v.length > 30) throw new HttpError(400, '단계는 30개까지 넣을 수 있어요.');
  return v.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const title = clean(o.title, 80);
    if (!title) throw new HttpError(400, `${i + 1}번째 단계에 이름이 없습니다.`);
    const kind = KINDS.has(String(o.kind)) ? String(o.kind) : 'custom';
    const minutes = Math.max(0, Math.min(180, Math.round(Number(o.minutes ?? 0)) || 0));
    return {
      id: /^[a-zA-Z0-9_-]{1,24}$/.test(String(o.id ?? '')) ? String(o.id) : `s${i + 1}`,
      kind, title, minutes, note: clean(o.note, 300),
    };
  });
}

// ---------- 소그룹 나누기 ----------
function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** 의견이 다른 사람끼리 섞이게 — 같은 표끼리 한 사람씩 번갈아 뽑아 줄을 세운 뒤 size 명씩 자른다 */
function mixedOrder<T>(list: T[], choiceOf: (x: T) => number | null): T[] {
  const buckets = new Map<string, T[]>();
  for (const x of shuffle(list)) {
    const c = choiceOf(x);
    const k = c == null ? 'none' : String(c);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(x);
  }
  const lists = [...buckets.values()].sort((a, b) => b.length - a.length);
  const out: T[] = [];
  let guard = 0;
  while (lists.some((l) => l.length) && guard++ < 500) {
    for (const l of lists) if (l.length) out.push(l.shift()!);
  }
  return out;
}

// ---------- 요청 본문 ----------
type Body = Record<string, unknown>;
async function readBody(req: Request): Promise<Body> {
  const t = await req.text();
  if (t.length > 65536) throw new HttpError(413, '요청이 너무 큽니다.');
  if (!t) return {};
  try {
    const b = JSON.parse(t);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('bad');
    return b as Body;
  } catch { throw new HttpError(400, 'JSON 형식이 아닙니다.'); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const o = req.headers.get('Origin');
  if (o && !ORIGINS.includes(o)) return json(req, 403, { error: '허용되지 않은 출처입니다.' });
  const path = route(req);
  const isGet = (req.method as string) === 'GET';
  try {
    if (path === '/health') {
      // 표준 모양(lib/hub.ts 의 healthJson): 허브 운영 현황이 이 응답을 읽어 앱 상태를 보여 줍니다
      if (!db) return json(req, 503, healthJson(false));
      try {
        await db`select 1`;
        await ensureSchema(db);
      } catch { return json(req, 503, healthJson(false)); }
      return json(req, 200, healthJson(true));
    }

    const user = await getUser(req);
    if (path === '/hello') {
      return json(req, 200, { app: SCHEMA, user, ai_hub: Boolean(secret('AI_TOKEN') || secret('MAIL_TOKEN')), time: new Date().toISOString() });
    }
    if (!db) return json(req, 503, { error: '서버 설정이 아직 끝나지 않았습니다 (DB 연결 정보 없음).' });
    const sql = db;
    await ensureSchema(sql);

    const q = new URL(req.url).searchParams;
    const meKey = (): string => {
      const k = String(q.get('key') ?? '');
      if (!KEY_RE.test(k)) throw new HttpError(400, '내 신분표(key)가 없습니다.');
      return k;
    };

    // ---------- 입장 코드 확인 ----------
    if (path === '/session/lookup' && isGet) {
      const code = clean(q.get('code'), 8).toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) throw new HttpError(400, '입장 코드는 영문·숫자 4~8자예요.');
      const [s] = await sql`select code, title, host_name, status, created_at from forum.sessions where code = ${code}`;
      if (!s) throw new HttpError(404, '그 입장 코드의 수업을 찾지 못했어요.');
      const [c] = await sql`select count(*)::int as n from forum.participants where session_id = (select id from forum.sessions where code = ${code})`;
      return json(req, 200, { code: s.code, title: s.title, host_name: s.host_name, status: s.status, participants: Number(c?.n ?? 0) });
    }

    // ---------- 상태 ----------
    if (path === '/session/state' && isGet) {
      const code = clean(q.get('code'), 8).toUpperCase();
      const state = await loadState(sql, code, meKey());
      return json(req, 200, { ...state, viewer: user ? { email: user.email } : null });
    }

    if (req.method !== 'POST') return json(req, 405, { error: '지원하지 않는 방식입니다.' });
    const b = await readBody(req);
    const codeIn = clean(b.code, 8).toUpperCase();
    const keyIn = String(b.key ?? '');
    const key = KEY_RE.test(keyIn) ? keyIn : '';

    // ---------- 수업 만들기 ----------
    if (path === '/session/create') {
      const title = clean(b.title, 120) || '이름 없는 수업';
      const hostName = clean(b.host_name, 40) || (user?.email ? user.email.split('@')[0] : '선생님');
      const hostKey = user?.id ? `u:${user.id}` : randomKey();
      let code = '';
      for (let i = 0; i < 8; i++) {
        const c = randomCode(6);
        const [dup] = await sql`select 1 as x from forum.sessions where code = ${c}`;
        if (!dup) { code = c; break; }
      }
      if (!code) throw new HttpError(500, '입장 코드를 만들지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      const [s] = await sql`
        insert into forum.sessions (code, title, host_key, host_name, timeline)
        values (${code}, ${title}, ${hostKey}, ${hostName}, ${sql.json(DEFAULT_TIMELINE)})
        returning id`;
      await sql`
        insert into forum.participants (session_id, user_key, name, role)
        values (${s.id}, ${hostKey}, ${hostName}, 'host')`;
      await sql`
        insert into forum.workbook_notes (session_id, group_id, content, updated_by)
        values (${s.id}, 'main', '', ${hostName})`;
      const state = await loadState(sql, code, hostKey);
      return json(req, 201, { ...state, code, key: hostKey });
    }

    // ---------- 입장 / 재입장 ----------
    if (path === '/session/join') {
      const s = await sessionByCode(sql, codeIn);
      const name = clean(b.name, 40);
      if (!name) throw new HttpError(400, '이름을 적어 주세요.');
      // 같은 기기에서 다시 들어오면(key 가 살아 있으면) 그 사람으로 이어진다
      let myKey = key && KEY_RE.test(key) ? key : '';
      const uKey = user?.id ? `u:${user.id}` : '';
      if (uKey && s.host_key === uKey) myKey = uKey;   // 진행자가 구글 로그인으로 다시 들어온 경우
      else if (!myKey) myKey = uKey || randomKey();     // 처음 들어온 로그인 사용자는 u:<아이디>
      const host = s.host_key === myKey;
      await sql`
        insert into forum.participants (session_id, user_key, name, role, last_seen)
        values (${s.id}, ${myKey}, ${name}, ${host ? 'host' : 'student'}, now())
        on conflict (session_id, user_key) do update
          set name = excluded.name, role = ${host ? 'host' : 'student'}, last_seen = now()`;
      if (host) await sql`update forum.sessions set host_name = ${name}, updated_at = now() where id = ${s.id}`;
      const state = await loadState(sql, codeIn, myKey);
      return json(req, 200, { ...state, code: codeIn, key: myKey });
    }

    // 아래는 모두 이 수업에 들어온 사람만
    if (!key) throw new HttpError(400, '내 신분표(key)가 없습니다.');
    const s = await sessionByCode(sql, codeIn);
    const me = await participantOf(sql, s.id, key);
    if (!me) throw new HttpError(403, '이 수업에 들어온 기록이 없어요. 다시 입장해 주세요.');
    const isHost = s.host_key === key;

    if (path === '/workbook' && isGet) {
      const g = clean(q.get('group'), 20) || me.breakout_group || 'main';
      if (!/^(main|group-[1-9][0-9]?)$/.test(g)) throw new HttpError(400, '모둠 이름이 올바르지 않습니다.');
      const [note] = await sql`select group_id, content, updated_by, updated_at from forum.workbook_notes where session_id = ${s.id} and group_id = ${g}`;
      return json(req, 200, note ?? { group_id: g, content: '', updated_by: '', updated_at: null });
    }

    if (path === '/reports' && isGet) {
      needHost(s, key);
      const rows = await sql`select id, summary, feedback_json, model, created_at from forum.ai_reports where session_id = ${s.id} order by id desc limit 20`;
      return json(req, 200, { reports: rows });
    }

    // ---------- 타임라인 ----------
    if (path === '/session/timeline') {
      needHost(s, key); needOpen(s);
      const timeline = cleanTimeline(b.timeline);
      const step = Math.min(Number(s.current_step_index) || 0, Math.max(0, timeline.length - 1));
      await sql`update forum.sessions set timeline = ${sql.json(timeline)}, current_step_index = ${step}, updated_at = now() where id = ${s.id}`;
      return json(req, 200, await loadState(sql, codeIn, key));
    }

    // ---------- 단계 이동 ----------
    if (path === '/session/step') {
      needHost(s, key); needOpen(s);
      const timeline = Array.isArray(s.timeline) ? s.timeline as Step[] : [];
      const idx = Math.max(0, Math.min(timeline.length - 1, Math.round(Number(b.index ?? 0)) || 0));
      await sql`update forum.sessions set current_step_index = ${idx}, updated_at = now() where id = ${s.id}`;
      return json(req, 200, await loadState(sql, codeIn, key));
    }

    // ---------- 즉석 투표 ----------
    if (path === '/session/poll') {
      needHost(s, key); needOpen(s);
      const type = ['yesno', 'choice', 'text'].includes(String(b.type)) ? String(b.type) : '';
      const question = clean(b.question, 300);
      if (!type || !question) throw new HttpError(400, '투표 종류와 질문을 적어 주세요.');
      let options: string[] = [];
      if (type === 'choice') {
        options = (Array.isArray(b.options) ? b.options : []).map((x) => clean(x, 60)).filter(Boolean).slice(0, 6);
        if (options.length < 2) throw new HttpError(400, '객관식은 보기를 2개 이상 적어 주세요.');
      }
      const [p] = await sql`
        insert into forum.polls (session_id, step_index, type, question, options)
        values (${s.id}, ${Number(s.current_step_index) || 0}, ${type}, ${question}, ${sql.json(options)})
        returning id`;
      await sql`update forum.sessions set active_poll_id = ${p.id}, updated_at = now() where id = ${s.id}`;
      return json(req, 201, await loadState(sql, codeIn, key));
    }

    if (path === '/session/poll/close') {
      needHost(s, key);
      if (s.active_poll_id) {
        await sql`update forum.polls set status = 'closed', closed_at = now() where id = ${s.active_poll_id} and session_id = ${s.id}`;
      }
      await sql`update forum.sessions set updated_at = now() where id = ${s.id}`;
      return json(req, 200, await loadState(sql, codeIn, key));
    }

    if (path === '/poll/vote') {
      needOpen(s);
      const pollId = String(b.poll_id ?? '');
      if (!/^\d{1,18}$/.test(pollId)) throw new HttpError(400, '투표 번호가 올바르지 않습니다.');
      const [p] = await sql`select id, type, options, status from forum.polls where id = ${pollId} and session_id = ${s.id}`;
      if (!p) throw new HttpError(404, '그 투표를 찾지 못했어요.');
      if (p.status !== 'open') throw new HttpError(409, '마감된 투표예요.');
      const opts: string[] = Array.isArray(p.options) ? (p.options as string[]).length ? p.options as string[] : [] : [];
      const size = p.type === 'yesno' ? 2 : p.type === 'choice' ? opts.length : 0;
      let choice: number | null = null;
      let answer = '';
      if (p.type === 'text') {
        answer = text(b.text, 500).trim();
        if (!answer) throw new HttpError(400, '의견을 적어 주세요.');
      } else {
        const c = Number(b.choice);
        if (!Number.isInteger(c) || c < 0 || c >= size) throw new HttpError(400, '보기를 골라 주세요.');
        choice = c;
      }
      await sql`
        insert into forum.poll_votes (poll_id, user_key, name, choice, text_answer)
        values (${p.id}, ${key}, ${me.name}, ${choice}, ${answer})
        on conflict (poll_id, user_key) do update
          set choice = excluded.choice, text_answer = excluded.text_answer, name = excluded.name, created_at = now()`;
      return json(req, 200, await loadState(sql, codeIn, key));
    }

    // ---------- 소그룹 분반 ----------
    if (path === '/session/breakout') {
      needHost(s, key); needOpen(s);
      const mode = ['random', 'opinion', 'clear'].includes(String(b.mode)) ? String(b.mode) : 'random';
      const size = Math.max(2, Math.min(6, Math.round(Number(b.size ?? 4)) || 4));
      if (mode === 'clear') {
        await sql`update forum.participants set breakout_group = 'main' where session_id = ${s.id}`;
        await sql`update forum.sessions set breakout_config = ${sql.json({ active: false, size, mode, groups: 0, at: new Date().toISOString() })}, updated_at = now() where id = ${s.id}`;
        return json(req, 200, await loadState(sql, codeIn, key));
      }
      const rows = await sql`
        select user_key, name from forum.participants where session_id = ${s.id}
        order by (case when role = 'host' then 0 else 1 end), joined_at asc`;
      const choiceOf = new Map<string, number | null>();
      if (mode === 'opinion' && s.active_poll_id) {
        const votes = await sql`select user_key, choice from forum.poll_votes where poll_id = ${s.active_poll_id}`;
        for (const v of votes) choiceOf.set(String(v.user_key), typeof v.choice === 'number' ? v.choice : null);
      }
      const people = rows.map((r) => ({ key: String(r.user_key), name: String(r.name) }));
      const ordered = mode === 'opinion' ? mixedOrder(people, (p) => choiceOf.get(p.key) ?? null) : shuffle(people);
      const groups = Math.max(1, Math.ceil(ordered.length / size));
      const assign = new Map<string, string>();
      ordered.forEach((p, i) => {
        const g = `group-${(i % groups) + 1}`;
        assign.set(p.key, g);
      });
      for (const [k, g] of assign) {
        await sql`update forum.participants set breakout_group = ${g} where session_id = ${s.id} and user_key = ${k}`;
      }
      // 모둠 워크북 줄을 미리 만들어 둔다 (없으면 빈 줄)
      for (let i = 1; i <= groups; i++) {
        await sql`insert into forum.workbook_notes (session_id, group_id) values (${s.id}, ${'group-' + i}) on conflict do nothing`;
      }
      const cfg = { active: true, size, mode, groups, at: new Date().toISOString() };
      await sql`update forum.sessions set breakout_config = ${sql.json(cfg)}, updated_at = now() where id = ${s.id}`;
      return json(req, 200, await loadState(sql, codeIn, key));
    }

    // ---------- 워크북 ----------
    if (path === '/workbook') {
      needOpen(s);
      const g = clean(b.group, 20) || me.breakout_group || 'main';
      if (!/^(main|group-[1-9][0-9]?)$/.test(g)) throw new HttpError(400, '모둠 이름이 올바르지 않습니다.');
      if (!isHost && g !== me.breakout_group) throw new HttpError(403, '내 모둠 워크북만 고칠 수 있어요.');
      const content = text(b.content, 20000);
      await sql`
        insert into forum.workbook_notes (session_id, group_id, content, updated_by, updated_at)
        values (${s.id}, ${g}, ${content}, ${me.name}, now())
        on conflict (session_id, group_id) do update
          set content = excluded.content, updated_by = excluded.updated_by, updated_at = now()`;
      return json(req, 200, { ok: true, group_id: g, updated_at: new Date().toISOString() });
    }

    // ---------- 발화 시간 ----------
    if (path === '/session/talk') {
      const seconds = Math.max(0, Math.min(600, Number(b.seconds) || 0));
      const signals = Math.max(0, Math.min(100, Math.round(Number(b.signals) || 0)));
      if (seconds || signals) {
        await sql`
          update forum.participants
             set talk_seconds = talk_seconds + ${seconds}, signals_count = signals_count + ${signals}, last_seen = now()
           where session_id = ${s.id} and user_key = ${key}`;
      }
      return json(req, 200, { ok: true });
    }

    // ---------- 수업 끝내기 ----------
    if (path === '/session/end') {
      needHost(s, key);
      await sql`update forum.sessions set status = 'ended', ended_at = now(), updated_at = now() where id = ${s.id}`;
      await sql`update forum.participants set last_seen = now() - interval '10 minutes' where session_id = ${s.id}`;
      return json(req, 200, await loadState(sql, codeIn, key));
    }

    // ---------- AI 리포트 ----------
    if (path === '/ai-report') {
      needHost(s, key);
      const state = await loadState(sql, codeIn, key);
      const built = await buildReport(state);
      const [row] = await sql`
        insert into forum.ai_reports (session_id, summary, feedback_json, model)
        values (${s.id}, ${built.report.summary}, ${sql.json(built.report as unknown as Record<string, never>)}, ${built.model})
        returning id, created_at`;
      return json(req, 201, { id: String(row.id), created_at: row.created_at, ...built });
    }

    return json(req, 404, { error: '없는 경로입니다.' });
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message });
    console.error(FN, (e as { code?: string })?.code ?? '', (e as Error)?.message ?? e);
    return json(req, 500, { error: '서버 오류가 났습니다.', code: (e as { code?: string })?.code });
  }
});
