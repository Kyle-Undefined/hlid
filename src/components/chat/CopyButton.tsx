import { Check, Copy } from "lucide-react";
import { cn } from "#/lib/utils";

interface CopyButtonProps {
	onCopy: () => void;
	copied: boolean;
	className?: string;
}

export function CopyButton({ onCopy, copied, className }: CopyButtonProps) {
	return (
		<button
			type="button"
			onClick={onCopy}
			aria-label={copied ? "Copied" : "Copy"}
			className={cn(
				"p-1 rounded-none transition-all",
				"text-muted-foreground/40 hover:text-muted-foreground/80",
				className,
			)}
		>
			{copied ? (
				<Check aria-hidden className="w-3 h-3 text-primary/60" />
			) : (
				<Copy aria-hidden className="w-3 h-3" />
			)}
		</button>
	);
}
