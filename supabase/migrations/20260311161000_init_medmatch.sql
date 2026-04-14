create extension if not exists pgcrypto;
create table if not exists app_users (
  id text primary key,
  email text not null unique,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create table if not exists course_categories (
  slug text primary key,
  label text not null,
  section text not null,
  pool_keys jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);
create table if not exists schools (
  id text primary key,
  slug text not null unique,
  name text not null,
  state text not null,
  data_source text not null,
  source_pages integer[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now())
);
create table if not exists requirements (
  id text primary key,
  school_id text not null references schools(id) on delete cascade,
  course_name text not null,
  classification text not null default '',
  category_slug text not null,
  match_mode text not null default 'exact',
  pool_key text,
  requirement_level text not null default 'not_specified',
  credit_hours numeric,
  lab_policy text not null default 'not_specified',
  pass_fail_policy text not null default 'not_specified',
  ap_credit_policy text not null default 'not_specified',
  online_course_policy text not null default 'not_specified',
  community_college_policy text not null default 'not_specified',
  additional_info text not null default '',
  source_page integer not null,
  sort_order integer not null default 1,
  raw_course_name text not null default ''
);
create index if not exists requirements_school_id_idx on requirements(school_id);
create index if not exists requirements_category_slug_idx on requirements(category_slug);
create table if not exists user_course_profiles (
  id uuid primary key default gen_random_uuid(),
  user_sub text not null references app_users(id) on delete cascade,
  name text not null,
  used_ap boolean not null default false,
  used_online boolean not null default false,
  used_pass_fail boolean not null default false,
  used_community_college boolean not null default false,
  credit_system text not null default 'semester',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index if not exists user_course_profiles_user_sub_idx on user_course_profiles(user_sub, updated_at desc);
create table if not exists user_course_entries (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references user_course_profiles(id) on delete cascade,
  category_slug text not null,
  credits_semester numeric not null,
  has_lab boolean not null default false,
  completed boolean not null default true,
  source text not null,
  source_external_key text,
  display_name text
);
create index if not exists user_course_entries_profile_id_idx on user_course_entries(profile_id);
create table if not exists user_canvascope_course_mappings (
  id uuid primary key default gen_random_uuid(),
  user_sub text not null references app_users(id) on delete cascade,
  course_signature text not null,
  course_name text not null,
  course_code text not null default '',
  category_slug text not null,
  default_credits_semester numeric not null default 3,
  default_has_lab boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_sub, course_signature)
);
create index if not exists user_canvascope_course_mappings_user_sub_idx on user_canvascope_course_mappings(user_sub, updated_at desc);
create table if not exists import_runs (
  id uuid primary key default gen_random_uuid(),
  source_path text not null,
  source_checksum text not null,
  school_count integer not null default 0,
  requirement_count integer not null default 0,
  status text not null default 'completed',
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);
