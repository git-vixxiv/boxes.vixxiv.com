/**
 * Boxes - usage analytics (Amplitude HTTP API, no SDK).
 *
 * Privacy rules for anything sent from here:
 *   - never item names, box names, descriptions, locations, notes or photos
 *   - only that an action happened, plus counts and yes/no flags
 *   - nothing is sent without consent (see needsConsentPrompt)
 */

import { ANALYTICS } from './billing-config.js';

const CONSENT_KEY = 'boxes.analytics.consent';   // "granted" | "denied"
const DEVICE_KEY = 'boxes.analytics.device';
const FLUSH_DELAY_MS = 1000;

// Regions where tracking needs an explicit yes first (EU / EEA / UK / CH).
const CONSENT_TIMEZONE = /^(Europe\/|Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe)|Arctic\/Longyearbyen)/;

function readStore(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
}

function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function inConsentRegion() {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        return CONSENT_TIMEZONE.test(zone);
    } catch (e) {
        return true; // cannot tell: ask
    }
}

class Analytics {
    constructor() {
        this.userId = null;
        this.sessionId = Date.now();
        this.queue = [];
        this.flushTimer = null;
    }

    isConfigured() {
        return !!ANALYTICS.amplitudeApiKey;
    }

    /** "granted", "denied", or null when the user has not been asked. */
    storedConsent() {
        return readStore(CONSENT_KEY);
    }

    /** True when a consent banner must be shown before anything is sent. */
    needsConsentPrompt() {
        return this.isConfigured() && this.storedConsent() === null && inConsentRegion();
    }

    isEnabled() {
        if (!this.isConfigured()) return false;
        const consent = this.storedConsent();
        if (consent === 'granted') return true;
        if (consent === 'denied') return false;
        return !inConsentRegion();
    }

    setConsent(granted) {
        writeStore(CONSENT_KEY, granted ? 'granted' : 'denied');
        if (!granted) this.queue = [];
    }

    identify(userId) {
        this.userId = userId || null;
    }

    deviceId() {
        let id = readStore(DEVICE_KEY);
        if (!id) {
            id = randomId();
            writeStore(DEVICE_KEY, id);
        }
        return id;
    }

    track(eventType, properties = {}) {
        if (!this.isEnabled()) return;
        const event = {
            event_type: eventType,
            device_id: this.deviceId(),
            session_id: this.sessionId,
            time: Date.now(),
            insert_id: randomId(),
            platform: 'Web',
            language: navigator.language,
            event_properties: properties
        };
        if (this.userId) event.user_id = this.userId;
        this.queue.push(event);

        // Batch what arrives within a second. The timer is not restarted by
        // later events, so steady activity cannot hold a batch back.
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
        }
    }

    flush() {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (!this.queue.length || !this.isEnabled()) return;
        const events = this.queue;
        this.queue = [];
        // Analytics must never break or slow the app: fire and forget.
        fetch(ANALYTICS.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: ANALYTICS.amplitudeApiKey, events }),
            keepalive: true
        }).catch(() => {});
    }
}

export const analytics = new Analytics();

// Send whatever is queued when the tab is hidden, closed or navigated away.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') analytics.flush();
});
window.addEventListener('pagehide', () => analytics.flush());
