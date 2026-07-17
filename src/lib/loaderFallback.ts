/** Resolve optional loader data quickly without cancelling useful background work. */
export function loaderValueOrFallback<T>(
	read: Promise<T>,
	fallback: T,
	timeoutMs: number,
): Promise<T> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(fallback), timeoutMs);
		void read.then(finish, () => finish(fallback));
	});
}

export type OptionalLoaderValue<T> =
	| { status: "ready"; value: T }
	| { status: "unavailable"; value: T };

/**
 * Resolve optional route data inside a fixed navigation budget while preserving
 * whether the fallback was used. Mounted pages can then hydrate in the
 * background and offer a retry instead of presenting fallback data as truth.
 */
export function optionalLoaderValue<T>(
	read: Promise<T>,
	fallback: T,
	timeoutMs: number,
): Promise<OptionalLoaderValue<T>> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: OptionalLoaderValue<T>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(
			() => finish({ status: "unavailable", value: fallback }),
			timeoutMs,
		);
		void read.then(
			(value) => finish({ status: "ready", value }),
			() => finish({ status: "unavailable", value: fallback }),
		);
	});
}
