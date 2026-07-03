-- Remove the historical MedMatch schema. These tables are not referenced by
-- Canvascope or Lectra runtime code and are empty in the linked database.
drop table if exists public.import_runs;
drop table if exists public.user_canvascope_course_mappings;
drop table if exists public.user_course_entries;
drop table if exists public.user_course_profiles;
drop table if exists public.requirements;
drop table if exists public.schools;
drop table if exists public.course_categories;
drop table if exists public.app_users;

-- Remove the SCI cause-list alert schema (created by the historical
-- sci_causelist_alerts_init migration for the separate IndiaProject). These
-- tables are not referenced by Canvascope or Lectra runtime code and are empty
-- in the linked database. Foreign keys are internal to this cluster, so they
-- are dropped in dependency order (NotificationSent -> CaseWatch -> Subscriber).
drop table if exists public."NotificationSent";
drop table if exists public."CaseWatch";
drop table if exists public."CauseListRun";
drop table if exists public."Subscriber";
