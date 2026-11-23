/* global frappe */

// Server-synced clock for time-bound POS Offers.
//
// Offer start/end times are company (site) time. The till can be a PC in another country, or
// one whose clock was set by hand, so the PC clock is not trusted: we ask the server for the
// current UTC time and then advance it with performance.now(), which counts real elapsed time
// and does not move when someone changes the PC clock. Re-synced every minute (Invoice.vue),
// which also corrects any drift after the PC sleeps.
//
// serverNowString() returns null until the first successful sync; callers fall back to the PC
// clock converted to the site time zone in that case (e.g. the till started while offline).

let base = null; // { serverMs, perfMs }: server UTC ms observed at perf time perfMs
let timeZone = null;
let inflight = null;

const MAX_GOOD_RTT_MS = 5000;

function perfNow() {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

export function syncServerClock() {
	if (inflight) {
		return inflight;
	}
	const sent = perfNow();
	inflight = Promise.resolve(
		frappe.call({ method: "posawesome.posawesome.api.offers.get_server_time" }),
	)
		.then((r) => {
			const msg = r && r.message;
			if (!msg || !msg.epoch_ms) {
				return;
			}
			const received = perfNow();
			const rtt = received - sent;
			// A very slow round trip gives a fuzzy reading -- keep the previous good one.
			if (base && rtt > MAX_GOOD_RTT_MS) {
				return;
			}
			base = { serverMs: Number(msg.epoch_ms), perfMs: sent + rtt / 2 };
			if (msg.time_zone) {
				timeZone = msg.time_zone;
			}
		})
		.catch((error) => {
			console.warn("Server clock sync failed, keeping last reading:", error);
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

// Current server time as "YYYY-MM-DD HH:mm:ss" in the site time zone, or null if never synced.
export function serverNowString() {
	if (!base) {
		return null;
	}
	const tz =
		timeZone ||
		(frappe.boot && frappe.boot.time_zone && frappe.boot.time_zone.system) ||
		(frappe.sys_defaults && frappe.sys_defaults.time_zone);
	const m = typeof window !== "undefined" ? window.moment : null;
	if (!tz || !m || typeof m.tz !== "function") {
		return null;
	}
	return m.tz(base.serverMs + (perfNow() - base.perfMs), tz).format("YYYY-MM-DD HH:mm:ss");
}
