import {
	ArrowUpRight,
	Eraser,
	Hand,
	Highlighter,
	LoaderCircle,
	Pencil,
	Square,
	Type,
	Undo2,
	X,
} from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import type { ProjectPreviewAgentFrame } from "#/server/protocol";

type Point = { x: number; y: number };
type Mark =
	| { kind: "pen"; points: Point[] }
	| { kind: "highlight"; start: Point; end: Point }
	| { kind: "rectangle"; start: Point; end: Point }
	| { kind: "arrow"; start: Point; end: Point }
	| { kind: "text"; point: Point; text: string };
type Tool = Mark["kind"] | "pan";

const RED = "#ef4444";
const YELLOW = "#fde047";

function drawArrow(
	context: CanvasRenderingContext2D,
	start: Point,
	end: Point,
) {
	const angle = Math.atan2(end.y - start.y, end.x - start.x);
	const head = 18;
	context.beginPath();
	context.moveTo(start.x, start.y);
	context.lineTo(end.x, end.y);
	context.moveTo(end.x, end.y);
	context.lineTo(
		end.x - head * Math.cos(angle - Math.PI / 6),
		end.y - head * Math.sin(angle - Math.PI / 6),
	);
	context.moveTo(end.x, end.y);
	context.lineTo(
		end.x - head * Math.cos(angle + Math.PI / 6),
		end.y - head * Math.sin(angle + Math.PI / 6),
	);
	context.stroke();
}

function drawMark(context: CanvasRenderingContext2D, mark: Mark) {
	context.save();
	context.lineCap = "round";
	context.lineJoin = "round";
	if (mark.kind === "pen") {
		context.strokeStyle = RED;
		context.lineWidth = 5;
		context.beginPath();
		mark.points.forEach((point, index) => {
			if (index === 0) context.moveTo(point.x, point.y);
			else context.lineTo(point.x, point.y);
		});
		context.stroke();
	} else if (mark.kind === "highlight") {
		context.fillStyle = `${YELLOW}66`;
		context.fillRect(
			Math.min(mark.start.x, mark.end.x),
			Math.min(mark.start.y, mark.end.y),
			Math.abs(mark.end.x - mark.start.x),
			Math.abs(mark.end.y - mark.start.y),
		);
	} else if (mark.kind === "rectangle") {
		context.strokeStyle = RED;
		context.lineWidth = 5;
		context.strokeRect(
			Math.min(mark.start.x, mark.end.x),
			Math.min(mark.start.y, mark.end.y),
			Math.abs(mark.end.x - mark.start.x),
			Math.abs(mark.end.y - mark.start.y),
		);
	} else if (mark.kind === "arrow") {
		context.strokeStyle = RED;
		context.lineWidth = 5;
		drawArrow(context, mark.start, mark.end);
	} else {
		context.font = "600 24px sans-serif";
		context.lineWidth = 5;
		context.strokeStyle = "white";
		context.strokeText(mark.text, mark.point.x, mark.point.y);
		context.fillStyle = RED;
		context.fillText(mark.text, mark.point.x, mark.point.y);
	}
	context.restore();
}

export function ProjectPreviewFeedbackModal({
	frame,
	saving,
	error,
	onClose,
	onSave,
}: {
	frame: ProjectPreviewAgentFrame;
	saving: boolean;
	error: string | null;
	onClose: () => void;
	onSave: (blob: Blob, comment: string) => Promise<void>;
}) {
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const imageRef = useRef<HTMLImageElement | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [tool, setTool] = useState<Tool>("pen");
	const [marks, setMarks] = useState<Mark[]>([]);
	const [draft, setDraft] = useState<Mark | null>(null);
	const [text, setText] = useState("");
	const [comment, setComment] = useState("");

	useEffect(() => {
		if (window.matchMedia?.("(pointer: coarse)").matches) {
			setTool("pan");
		}
	}, []);

	useEffect(() => {
		const image = new Image();
		image.onload = () => {
			imageRef.current = image;
			const canvas = canvasRef.current;
			if (canvas) {
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
			}
			setLoaded(true);
		};
		image.src = `data:${frame.mime};base64,${frame.image_base64}`;
		return () => {
			image.onload = null;
		};
	}, [frame.image_base64, frame.mime]);

	useEffect(() => {
		if (!loaded) return;
		const canvas = canvasRef.current;
		const image = imageRef.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !image || !context) return;
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.drawImage(image, 0, 0);
		for (const mark of marks) drawMark(context, mark);
		if (draft) drawMark(context, draft);
	}, [draft, loaded, marks]);

	const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
		const canvas = event.currentTarget;
		const bounds = canvas.getBoundingClientRect();
		return {
			x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
			y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
		};
	};

	const start = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (saving || tool === "pan") return;
		const point = pointFor(event);
		if (tool === "text") {
			const value = text.trim();
			if (value) {
				setMarks((current) => [
					...current,
					{ kind: "text", point, text: value },
				]);
				setText("");
			}
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		setDraft(
			tool === "pen"
				? { kind: "pen", points: [point] }
				: { kind: tool, start: point, end: point },
		);
	};

	const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (!draft || !event.currentTarget.hasPointerCapture(event.pointerId))
			return;
		const point = pointFor(event);
		setDraft((current) => {
			if (!current) return null;
			if (current.kind === "pen") {
				return { ...current, points: [...current.points, point] };
			}
			if (current.kind === "text") return current;
			return { ...current, end: point };
		});
	};

	const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (!draft) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		setMarks((current) => [...current, draft]);
		setDraft(null);
	};

	const save = async () => {
		const canvas = canvasRef.current;
		if (!canvas || !loaded) return;
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/png"),
		);
		if (!blob) return;
		await onSave(blob, comment.trim());
	};

	const tools: Array<{ tool: Tool; label: string; icon: typeof Pencil }> = [
		{ tool: "pan", label: "Pan or scroll", icon: Hand },
		{ tool: "pen", label: "Pen", icon: Pencil },
		{ tool: "highlight", label: "Highlight", icon: Highlighter },
		{ tool: "rectangle", label: "Rectangle", icon: Square },
		{ tool: "arrow", label: "Arrow", icon: ArrowUpRight },
		{ tool: "text", label: "Text", icon: Type },
	];

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-3 backdrop-blur-sm">
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Annotate Project Preview"
				className="flex max-h-[96vh] w-full max-w-6xl flex-col border border-border bg-card shadow-2xl focus:outline-none"
				onKeyDown={onDialogKeyDown}
			>
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
					<div className="min-w-0 flex-1">
						<p className="truncate text-xs font-medium">
							Annotate Project Preview
						</p>
						<p className="truncate text-[9px] uppercase tracking-widest text-muted-foreground/60">
							{frame.viewport} · {frame.width}×{frame.height} · {frame.path}
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						disabled={saving}
						aria-label="Close Preview feedback"
						className="p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
					>
						<X className="h-4 w-4" />
					</button>
				</header>
				<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
					<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/30">
						<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 p-2">
							{tools.map(({ tool: value, label, icon: Icon }) => (
								<button
									key={value}
									type="button"
									onClick={() => setTool(value)}
									aria-label={label}
									title={label}
									className={`p-2 ${
										tool === value
											? "bg-primary text-primary-foreground"
											: "text-muted-foreground hover:bg-muted hover:text-foreground"
									}`}
								>
									<Icon className="h-4 w-4" />
								</button>
							))}
							<div className="mx-1 h-5 w-px bg-border" />
							<button
								type="button"
								onClick={() => setMarks((current) => current.slice(0, -1))}
								disabled={marks.length === 0}
								aria-label="Undo annotation"
								title="Undo"
								className="p-2 text-muted-foreground hover:text-foreground disabled:opacity-25"
							>
								<Undo2 className="h-4 w-4" />
							</button>
							<button
								type="button"
								onClick={() => setMarks([])}
								disabled={marks.length === 0}
								aria-label="Clear annotations"
								title="Clear"
								className="p-2 text-muted-foreground hover:text-destructive disabled:opacity-25"
							>
								<Eraser className="h-4 w-4" />
							</button>
							{tool === "text" && (
								<input
									value={text}
									onChange={(event) => setText(event.target.value)}
									placeholder="Type, then click to place"
									maxLength={120}
									aria-label="Annotation text"
									className="ml-1 h-8 min-w-48 flex-1 border border-border bg-background px-2 text-xs outline-none focus:border-primary"
								/>
							)}
							{tool === "pan" && (
								<span className="ml-1 text-[10px] text-muted-foreground/60">
									Swipe the image to scroll
								</span>
							)}
						</div>
						<div className="min-h-0 flex-1 overflow-auto p-3">
							<canvas
								ref={canvasRef}
								onPointerDown={start}
								onPointerMove={move}
								onPointerUp={finish}
								onPointerCancel={finish}
								aria-label="Preview annotation canvas"
								className={`mx-auto block h-auto max-w-full border border-border bg-white shadow ${
									tool === "pan" ? "cursor-default" : "cursor-crosshair"
								}`}
								style={{
									touchAction: tool === "pan" ? "pan-x pan-y" : "none",
								}}
							/>
						</div>
					</div>
					<aside className="flex w-full shrink-0 flex-col gap-3 border-t border-border p-3 lg:w-72 lg:border-t-0 lg:border-l">
						<label className="flex min-h-0 flex-1 flex-col gap-2 text-[10px] uppercase tracking-widest text-muted-foreground">
							Message to agent
							<textarea
								value={comment}
								onChange={(event) => setComment(event.target.value)}
								maxLength={10_000}
								placeholder="What should the agent look at?"
								className="min-h-28 flex-1 resize-none border border-border bg-background p-2 text-xs normal-case tracking-normal text-foreground outline-none focus:border-primary"
							/>
						</label>
						<p className="text-[10px] leading-4 text-muted-foreground/60">
							The annotated PNG is saved as a retained Relic and attached to the
							next Raven message.
						</p>
						{error && (
							<p className="text-xs leading-4 text-destructive">{error}</p>
						)}
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={onClose}
								disabled={saving}
								className="border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => void save()}
								disabled={!loaded || saving}
								className="flex items-center gap-2 bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-40"
							>
								{saving && (
									<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
								)}
								Save and send
							</button>
						</div>
					</aside>
				</div>
			</div>
		</div>,
		document.body,
	);
}
