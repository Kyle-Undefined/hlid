import type { AcpAuthMethod, AcpCatalogItem } from "#/lib/serverFns/acp";

/** One authentication method for an ACP agent: env vars, terminal command, credential link, or an authenticate button. */
export function AcpAuthMethodRow({
	method,
	item,
	disabled = false,
	onAuthenticate,
}: {
	method: AcpAuthMethod;
	item: AcpCatalogItem;
	disabled?: boolean;
	onAuthenticate: (methodId: string) => void;
}) {
	return (
		<div className="min-w-0 space-y-1 border border-border p-2 text-xs">
			<div className="break-words">{method.name}</div>
			{method.description && (
				<div className="break-words text-muted-foreground">
					{method.description}
				</div>
			)}
			{method.vars && (
				<div className="break-all font-mono text-[10px]">
					Required environment:{" "}
					{method.vars.map((variable) => variable.name).join(", ")}
				</div>
			)}
			{method.type === "terminal" && (
				<div className="break-all font-mono text-[10px]">
					Credential command: {item.command} {(method.args ?? []).join(" ")}
				</div>
			)}
			{method.link && (
				<a
					href={method.link}
					target="_blank"
					rel="noreferrer"
					className="text-primary"
				>
					Open credential page
				</a>
			)}
			{!method.type && (
				<button
					type="button"
					disabled={disabled}
					onClick={() => onAuthenticate(method.id)}
					className="text-primary uppercase"
				>
					Add or replace credentials
				</button>
			)}
		</div>
	);
}
