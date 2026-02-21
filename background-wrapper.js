importScripts('lib/supabase.js');

// Add to self for background.js to find it seamlessly
if (typeof self !== 'undefined' && self.supabase) {
    console.log('[Canvascope] Supabase initialized in service worker wrapper');
}

importScripts('background.js');
