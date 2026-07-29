importScripts('../lib/supabase.js');

// Add to self for background.js to find it seamlessly
if (typeof self !== 'undefined' && self.supabase) {
    console.log('[Canvascope] Supabase initialized in service worker wrapper');
}

importScripts('background.js');

// Canvascope add-ons: reminders + skin/tools sync glue. These live in
// separate files so the existing background.js stays untouched. They
// register their own message + alarm listeners.
importScripts('../core/reminders.js');
importScripts('background-cs-extras.js');

// Syllabus memory (parsed grading scheme / cutoffs / schedule per course).
// Loaded after cs-extras so CanvascopeAgentSync exists for the debounced
// Supabase mirror; background.js's parseSyllabusToMemory writes through it.
importScripts('../core/syllabus-memory.js');

// Canvascope autonomous agent (tool-use loop + daily briefing). Order matters:
// RAGCore + SemanticMatcher provide retrieval; the agent modules depend on
// globals from background.js (callCanvascopeSupabaseFunction, calendar
// helpers) and background-cs-extras (CanvascopeAgentSync), so load last.
importScripts('../core/semantic-matcher.js');
importScripts('../core/course-materials.js');
// On-device embeddings: frozen config, shared query normalizer, persisted
// int8 vector index, and the offscreen-host client. Loaded before rag-core
// so its bge-first retrieval paths see the globals.
importScripts('../core/embeddings-config.js');
importScripts('../core/query-normalizer.js');
importScripts('../core/embedding-index.js');
importScripts('../core/embed-client.js');
importScripts('../core/rag-core.js');
importScripts('../core/optional-capabilities.js');
importScripts('../core/character-profile.js');
importScripts('../core/agent-integrity.js');
importScripts('../core/agent-memory.js');
importScripts('../core/agent-tools.js');
importScripts('../core/agent-loop.js');
// Alarm-debounced background builder for the persisted embedding index.
// Loaded last: needs RAGCore + CanvascopeEmbeddingIndex + CanvascopeEmbedClient.
importScripts('embedding-index-sync.js');
