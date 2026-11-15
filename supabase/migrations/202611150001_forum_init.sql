-- 별무리 액티브 러닝 포럼 — 표·권한·RLS (2026-11-15)
--
-- 12명 안팎의 액티브 러닝 화상 수업(미네르바 포럼 방식)을 BMR APPS 안에서만 돌립니다.
-- 외부 화상 서버 없이 Supabase Realtime(신호·방송) + WebRTC P2P 로 소리·영상을 주고받고,
-- 표에는 수업 방·참가자·투표·모둠 워크북·AI 리포트만 남깁니다.
--
-- · 브라우저(anon·authenticated)에는 이 표들의 권한을 주지 않습니다. 읽기·쓰기는 모두 서버 함수 forum-fn 을 지납니다.
-- · 함수는 처음 살아날 때 같은 구조를 스스로 만들기 때문에(ensureSchema) 이 파일을 꼭 실행하지 않아도 앱은 동작합니다.
--   손으로 돌릴 때는 .env.local 의 DATABASE_URL 을 채우고 npm run db:migrate.
-- · auth.uid() 대신 bmr.uid() 를 쓰지만, 이 앱은 구글 로그인 없이 '코드+이름'으로도 들어오므로
--   신분은 표의 user_key(u:<구글 아이디> 또는 g:<무작위>)로 구분합니다.

create table if not exists forum.sessions (
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
  );

comment on table forum.sessions is '수업 방. code 는 학생이 입력하는 입장 코드, host_key 는 진행자 신분(참가자 user_key 와 같은 값).';

create table if not exists forum.participants (
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
  );

comment on table forum.participants is '수업 방 참가자. user_key 는 구글 로그인(u:<uuid>) 또는 빠른 입장(g:<무작위>) 신분표. talk_seconds 는 발화 누적 초.';

create index if not exists participants_session_idx on forum.participants (session_id, role);

create table if not exists forum.polls (
    id bigint generated always as identity primary key,
    session_id bigint not null references forum.sessions(id) on delete cascade,
    step_index int not null default 0,
    type text not null check (type in ('yesno', 'choice', 'text')),
    question text not null check (char_length(question) between 1 and 300),
    options jsonb not null default '[]'::jsonb,
    status text not null default 'open' check (status in ('open', 'closed')),
    created_at timestamptz not null default now(),
    closed_at timestamptz
  );

comment on table forum.polls is '즉석 투표. type: yesno(찬반) · choice(객관식) · text(한 줄 의견). options 는 객관식 보기 이름 배열.';

create index if not exists polls_session_idx on forum.polls (session_id, id);

create table if not exists forum.poll_votes (
    id bigint generated always as identity primary key,
    poll_id bigint not null references forum.polls(id) on delete cascade,
    user_key text not null check (char_length(user_key) between 4 and 80),
    name text not null default '' check (char_length(name) <= 40),
    choice int,
    text_answer text check (char_length(text_answer) <= 500),
    created_at timestamptz not null default now(),
    unique (poll_id, user_key)
  );

comment on table forum.poll_votes is '투표 한 표. 마감 전에는 다시 눌러 바꿀 수 있습니다(같은 poll_id·user_key 는 한 줄).';

create index if not exists poll_votes_poll_idx on forum.poll_votes (poll_id, choice);

create table if not exists forum.workbook_notes (
    session_id bigint not null references forum.sessions(id) on delete cascade,
    group_id text not null default 'main' check (group_id ~ '^(main|group-[1-9][0-9]?)$'),
    content text not null default '' check (char_length(content) <= 20000),
    updated_by text not null default '' check (char_length(updated_by) <= 40),
    updated_at timestamptz not null default now(),
    primary key (session_id, group_id)
  );

comment on table forum.workbook_notes is '모둠별 공동 워크북(전체 방은 main). 교사 관제 화면이 모든 모둠 것을 한 번에 읽습니다.';

create table if not exists forum.ai_reports (
    id bigint generated always as identity primary key,
    session_id bigint not null references forum.sessions(id) on delete cascade,
    summary text not null default '',
    feedback_json jsonb not null default '{}'::jsonb,
    model text not null default '' check (char_length(model) <= 80),
    created_at timestamptz not null default now()
  );

comment on table forum.ai_reports is '수업 참여 지표를 hub-ai 로 정리한 교사용 리포트와 학생 피드백 초안(JSON).';

create index if not exists ai_reports_session_idx on forum.ai_reports (session_id, id desc);

alter table forum.sessions enable row level security;

alter table forum.participants enable row level security;

alter table forum.polls enable row level security;

alter table forum.poll_votes enable row level security;

alter table forum.workbook_notes enable row level security;

alter table forum.ai_reports enable row level security;
