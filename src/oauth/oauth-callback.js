// oauth-callback.js
// Handles the redirect from Supabase OAuth
document.addEventListener('DOMContentLoaded', () => {
    // URL will look like: chrome-extension://<id>/oauth-callback.html#access_token=...
    const hashFragment = window.location.hash.substring(1);

    if (hashFragment) {
        chrome.runtime.sendMessage({
            type: 'processOAuthTokens',
            hash: hashFragment
        }, (response) => {
            // Close this tab when done 
            window.close();
        });
    } else {
        document.querySelector('h2').textContent = 'Error: No auth tokens received';
        document.querySelector('.loader').style.display = 'none';
    }
});
