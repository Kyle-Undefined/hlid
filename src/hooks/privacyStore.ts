let _privacy = false;
const _subscribers = new Set<() => void>();

function notify() {
	for (const fn of _subscribers) fn();
}

export function getSnapshot(): boolean {
	return _privacy;
}

export function subscribe(fn: () => void): () => void {
	_subscribers.add(fn);
	return () => _subscribers.delete(fn);
}

export function togglePrivacy(): void {
	_privacy = !_privacy;
	try {
		localStorage.setItem("hlid:privacy", _privacy ? "on" : "off");
	} catch {}
	document.documentElement.setAttribute(
		"data-privacy",
		_privacy ? "on" : "off",
	);
	notify();
}

export function initFromStorage(): void {
	try {
		_privacy = localStorage.getItem("hlid:privacy") === "on";
	} catch {}
	document.documentElement.setAttribute(
		"data-privacy",
		_privacy ? "on" : "off",
	);
	notify();
}
