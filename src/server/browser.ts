export function openInBrowser(url: string): void {
	try {
		const { protocol } = new URL(url);
		if (protocol !== "http:" && protocol !== "https:") return;
	} catch {
		return;
	}
	if (process.platform === "win32") {
		// Use explorer.exe (GUI subsystem) instead of cmd.exe (console subsystem).
		// Spawning a console app from a --windows-hide-console exe causes Windows
		// to create a new visible console window for the child.
		Bun.spawn(["explorer.exe", url], {
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: true,
		});
	} else if (process.platform === "darwin") {
		Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
	} else {
		Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] });
	}
}
