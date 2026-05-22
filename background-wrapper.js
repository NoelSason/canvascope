importScripts('lib/supabase.js');

// Add to self for background.js to find it seamlessly
if (typeof self !== 'undefined' && self.supabase) {
    console.log('[Canvascope] Supabase initialized in service worker wrapper');
}

importScripts('background.js');

// Canvascope add-ons: reminders + skin/tools sync glue. These live in
// separate files so the existing background.js stays untouched. They
// register their own message + alarm listeners.
importScripts('reminders.js');
importScripts('background-cs-extras.js');
