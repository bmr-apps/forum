// forum-fn 이 처음 살아날 때(콜드 스타트) 스스로 표를 만듭니다.
// supabase/migrations/202611150001_forum_init.sql 과 같은 내용입니다 —
// 마이그레이션을 손으로 돌리지 않아도 앱이 바로 동작하게 하려는 안전장치예요.
// 함수는 표 주인 권한(forum_fn ← forum_dev)으로 접속하므로 만들 수 있습니다.
//
// 브라우저(anon·authenticated)에는 이 표들의 권한을 주지 않습니다.
// 읽기·쓰기는 모두 이 함수를 지나고, 누가 무엇을 할 수 있는지는 함수 코드에서 직접 확인합니다.
// (Realtime 은 표가 아니라 방송(broadcast)·presence 채널로만 씁니다.)

export const DDL: string[] = [
  // ---------- 수업 방 ----------
  `create table if not exists forum.sessions (
    id bigint generated always as identity primary key,
    code text unique not null check (code ~ '^[A-Z0-9]{4,8}$'),
    title text not null default '' check (char_length(title) <= 120),
    host_key text not null check (char_length(host_key) between 4 and 80),
    host_name text not null default '' check (char_length(host_name) <= 40),
    status text not null default 'open' check (status in ('open', 'ended')),
    current_step_index int not null default 0 check (current_step_index between 0 and 99),
    timeline jsonb not null default '[]'::jsonb,
    active_poll_id bigint,
    breakout_config jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    ended_at timestamptz
  )`,
  `comment on table forum.sessions is '수업 방. code 는 학생이 입력하는 입장 코드, host_key 는 진행자 신분(참가자 user_key 와 같은 값).'`,

  // ---------- 참가자 ----------
  `create table if not exists forum.participants (
    id bigint generated always as identity primary key,
    session_id bigint not null references forum.sessions(id) on delete cascade,
    user_key text not null check (char_length(user_key) between 4 and 80),
    name text not null check (char_length(name) between 1 and 40),
    role text not null default 'student' check (role in ('host', 'student')),
    breakout_group text not null default 'main' check (breakout_group ~ '^(main|group-[1-9][0-9]?)$'),
    talk_seconds numeric(10,1) not null default 0 check (talk_seconds >= 0),
    signals_count int not null default 0 check (signals_count >= 0),
    joined_at timestamptz not null default now(),
    last_seen timestamptz not null default now(),
    unique (session_id, user_key)
  )`,
  `comment on table forum.participants is '수업 방 참가자. user_key 는 구글 로그인(u:<uuid>) 또는 빠른 입장(g:<무작위>) 신분표. talk_seconds 는 발화 누적 초.'`,
  `create index if not exists participants_session_idx on forum.participants (session_id, role)`,

  // ---------- 즉석 투표 ----------
  `create table if not exists forum.polls (
    id bigint generated always as identity primary key,
    session_id bigint not null references forum.sessions(id) on delete cascade,
    step_index int not null default 0,
    type text not null check (type in ('yesno', 'choice', 'text')),
    question text not null check (char_length(question) between 1 and 300),
    options jsonb not null default '[]'::jsonb,
    status text not null default 'open' check (status in ('open', 'closed')),
    created_at timestamptz not null default now(),
    closed_at timestamptz
  )`,
  `comment on table forum.polls is '즉석 투표. type: yesno(찬반) · choice(객관식) · text(한 줄 의견). options 는 객관식 보기 이름 배열.'`,
  `create index if not exists polls_session_idx on forum.polls (session_id, id)`,

  `create table if not exists forum.poll_votes (
    id bigint generated always as identity primary key,
    poll_id bigint not null references forum.polls(id) on delete cascade,
    user_key text not null check (char_length(user_key) between 4 and 80),
    name text not null default '' check (char_length(name) <= 40),
    choice int,
    text_answer text check (char_length(text_answer) <= 500),
    created_at timestamptz not null default now(),
    unique (poll_id, user_key)
  )`,
  `comment on table forum.poll_votes is '투표 한 표. 마감 전에는 다시 눌러 바꿀 수 있습니다(같은 poll_id·user_key 는 한 줄).'`,
  `create index if not exists poll_votes_poll_idx on forum.poll_votes (poll_id, choice)`,

  // ---------- 모둠 공동 워크북 ----------
  `create table if not exists forum.workbook_notes (
    session_id bigint not null references forum.sessions(id) on delete cascade,
    group_id text not null default 'main' check (group_id ~ '^(main|group-[1-9][0-9]?)$'),
    content text not null default '' check (char_length(content) <= 20000),
    updated_by text not null default '' check (char_length(updated_by) <= 40),
    updated_at timestamptz not null default now(),
    primary key (session_id, group_id)
  )`,
  `comment on table forum.workbook_notes is '모둠별 공동 워크북(전체 방은 main). 교사 관제 화면이 모든 모둠 것을 한 번에 읽습니다.'`,

  // ---------- 수업 후 AI 리포트 ----------
  `create table if not exists forum.ai_reports (
    id bigint generated always as identity primary key,
    session_id bigint not null references forum.sessions(id) on delete cascade,
    summary text not null default '',
    feedback_json jsonb not null default '{}'::jsonb,
    model text not null default '' check (char_length(model) <= 80),
    created_at timestamptz not null default now()
  )`,
  `comment on table forum.ai_reports is '수업 참여 지표를 hub-ai 로 정리한 교사용 리포트와 학생 피드백 초안(JSON).'`,
  `create index if not exists ai_reports_session_idx on forum.ai_reports (session_id, id desc)`,

  // ---------- 브라우저 권한 정리 (읽기·쓰기 모두 서버 함수만) ----------
  `alter table forum.sessions enable row level security`,
  `alter table forum.participants enable row level security`,
  `alter table forum.polls enable row level security`,
  `alter table forum.poll_votes enable row level security`,
  `alter table forum.workbook_notes enable row level security`,
  `alter table forum.ai_reports enable row level security`,
  `revoke all on forum.sessions, forum.participants, forum.polls, forum.poll_votes, forum.workbook_notes, forum.ai_reports from anon, authenticated`,
];

/** 빠른 확인: 핵심 표가 이미 있는지 (있으면 DDL 을 건너뛴다) */
export const CHECK_TABLES = `select
  to_regclass('forum.sessions')       is not null as sessions,
  to_regclass('forum.participants')   is not null as participants,
  to_regclass('forum.polls')          is not null as polls,
  to_regclass('forum.poll_votes')     is not null as poll_votes,
  to_regclass('forum.workbook_notes') is not null as workbook,
  to_regclass('forum.ai_reports')     is not null as ai_reports`;

/** 미리보기(체험 모드) 밖에서 쓰는 기본 타임라인 — 교사가 화면에서 바로 고칠 수 있다 */
export const DEFAULT_TIMELINE = [
  { id: 'intro', kind: 'intro', title: '도입 — 오늘의 질문', minutes: 5, note: '질문을 던지고 1분 생각 시간을 줍니다.' },
  { id: 'poll', kind: 'poll', title: '즉석 투표 — 찬반', minutes: 5, note: '찬성/반대로 의견을 모읍니다.' },
  { id: 'breakout', kind: 'breakout', title: '소그룹 분반 — 토론', minutes: 12, note: '의견이 다른 사람끼리 3~4명으로 묶습니다.' },
  { id: 'share', kind: 'discuss', title: '전체 정리 — 모둠 나눔', minutes: 8, note: '모둠 워크북을 함께 봅니다.' },
];
