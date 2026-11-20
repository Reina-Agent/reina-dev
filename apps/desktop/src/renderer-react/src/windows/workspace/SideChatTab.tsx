import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { bridge } from "~/lib/bridge";
import {
  bindSideChatSession,
  sideChatClear,
  sideChatInterrupt,
  sideChatSend,
  useSideChatStore,
} from "../main/sideChatStore";

const STR = {
  empty: "Ask a side question without interrupting the main agent.",
  placeholder: "Ask about this session…",
  unavailable: "Select a task before starting Side Chat.",
  answering: "Answering…",
  clear: "Clear Side Chat",
  clearConfirm: "Clear this Side Chat? This cannot be undone.",
  stop: "Stop answering",
  send: "Send",
};

function activityLabel(tool: string): string {
  const reads: Record<string, string> = {
    read_file: "Reading files",
    grep: "Searching",
    glob: "Listing files",
    list_notes: "Reading notes",
    read_note: "Reading notes",
    read_skill: "Reading skills",
    list_skills: "Reading skills",
    search_tool: "Looking up tools",
  };
  return reads[tool] ?? `Using ${tool}`;
}

function MessagesIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden />;
}

function Markdown({ source }: { source: string }) {
  return (
    <div className="min-w-0 text-[13px] leading-6 text-foreground/90 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_li]:my-1 [&_ol]:my-2 [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-secondary [&_pre]:p-3 [&_ul]:my-2 [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                if (!href || !/^(?:https?|mailto|tel):/i.test(href)) return;
                event.preventDefault();
                bridge().openLink(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export function SideChatTab({
  sessionId,
  quoteRequest,
  resetRequest,
}: {
  sessionId: string | null;
  quoteRequest?: { text: string; seq: number } | null;
  resetRequest?: number;
}) {
  const messages = useSideChatStore((state) => state.messages);
  const streamText = useSideChatStore((state) => state.streamText);
  const activity = useSideChatStore((state) => state.activity);
  const running = useSideChatStore((state) => state.running);
  const error = useSideChatStore((state) => state.error);
  const [draft, setDraft] = useState("");
  const [selectedQuote, setSelectedQuote] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastQuoteRequestSeq = useRef(0);
  const lastResetRequest = useRef(0);
  const previousSessionId = useRef<string | null>(sessionId);
  const embedded = window.parent !== window;

  useEffect(() => {
    const previous = previousSessionId.current;
    previousSessionId.current = sessionId;
    bindSideChatSession(sessionId);
    // The embedded Workspace hydrates its active session just after first mount.
    // Preserve a quote injected during that null -> active transition; only a
    // genuine switch away from an existing session should clear its context.
    if (previous !== null && previous !== sessionId) {
      setDraft("");
      setSelectedQuote("");
    }
  }, [sessionId]);

  useEffect(() => {
    if (!resetRequest || resetRequest === lastResetRequest.current) return;
    lastResetRequest.current = resetRequest;
    sideChatClear();
    setDraft("");
    setSelectedQuote("");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [resetRequest]);

  useEffect(() => {
    if (!quoteRequest || quoteRequest.seq === lastQuoteRequestSeq.current) return;
    lastQuoteRequestSeq.current = quoteRequest.seq;
    setSelectedQuote(quoteRequest.text.trim());
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [quoteRequest]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, 144);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 144 ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, streamText, running]);

  const submit = () => {
    const text = draft.trim();
    if (!text || !sessionId || running) return;
    setDraft("");
    setSelectedQuote("");
    void sideChatSend(text, selectedQuote);
  };

  const hasContent = messages.length > 0 || streamText.length > 0 || running;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-(--surface-divider) bg-card/60 px-2">
        <MessagesIcon className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/80">
          Session Side Chat
        </span>
        {running && (
          <span className="flex items-center gap-1.5 text-[11px] text-primary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            {STR.answering}
          </span>
        )}
        {hasContent && (
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title={STR.clear}
            aria-label={STR.clear}
            onClick={() => {
              if (window.confirm(STR.clearConfirm)) sideChatClear();
            }}
          >
            <TrashIcon />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {!hasContent && !error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary/70">
              <MessagesIcon />
            </span>
            <div className="max-w-64">
              <p className="text-[13px] font-medium text-foreground/80">Side Chat</p>
              <p className="mt-1 text-[12px] leading-5">{sessionId ? STR.empty : STR.unavailable}</p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {messages.map((message, index) =>
              message.role === "user" ? (
                <div className="flex justify-end" key={index}>
                  <div className="max-w-[82%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[13px] leading-5 text-foreground">
                    {message.text}
                  </div>
                </div>
              ) : (
                <div className={message.failed ? "text-destructive" : ""} key={index}>
                  <Markdown source={message.text} />
                  {!message.failed && embedded && (
                    <button
                      type="button"
                      className="mt-2 inline-flex h-7 items-center rounded-lg border border-(--surface-divider) bg-card px-2.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      title="Add this answer to the main conversation composer"
                      onClick={() => {
                        window.parent.postMessage(
                          { type: "reina:add-to-conversation", text: message.text },
                          "*",
                        );
                      }}
                    >
                      添加到对话
                    </button>
                  )}
                </div>
              ),
            )}
            {(running || streamText) && (
              <div>
                {streamText ? (
                  <Markdown source={streamText} />
                ) : (
                  <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    {activity ? activityLabel(activity) : STR.answering}
                  </span>
                )}
                {streamText && activity && (
                  <span className="mt-2 block text-[11px] text-muted-foreground">
                    {activityLabel(activity)}
                  </span>
                )}
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 pb-[18px]">
        <div
          className="mx-auto w-full max-w-3xl rounded-2xl border border-transparent bg-[var(--composer-bg,var(--card))] px-3.5 pb-2.5 pt-3 transition-colors focus-within:bg-[var(--composer-bg-focus,var(--card))]"
          onMouseDown={(event) => {
            if ((event.target as Element).closest("button, textarea")) return;
            event.preventDefault();
            textareaRef.current?.focus();
          }}
        >
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            {selectedQuote && (
              <span
                className="flex h-6 max-w-[min(100%,20rem)] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full bg-secondary px-2 text-[12px] text-muted-foreground"
                title={selectedQuote}
              >
                <svg className="h-3.5 w-3.5 shrink-0 fill-current opacity-80" viewBox="0 0 24 24" aria-hidden>
                  <path d="M7 17h4V9H5v6a2 2 0 0 0 2 2Zm10 0h2V9h-6v6a2 2 0 0 0 2 2h2Z" />
                </svg>
                <span className="min-w-0 truncate">{selectedQuote.replace(/\s+/g, " ")}</span>
                <button
                  type="button"
                  className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
                  title="移除引用"
                  aria-label="移除引用"
                  onClick={() => setSelectedQuote("")}
                >
                  ×
                </button>
              </span>
            )}
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              disabled={!sessionId}
              placeholder={sessionId ? STR.placeholder : STR.unavailable}
              aria-label={sessionId ? STR.placeholder : STR.unavailable}
              className="max-h-36 min-h-6 w-full min-w-0 resize-none overflow-x-hidden bg-transparent p-0 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                } else if (event.key === "Escape" && running) {
                  event.preventDefault();
                  sideChatInterrupt();
                }
              }}
            />
          </div>
          <div className="mt-1.5 flex h-8 items-center">
            <span className="text-[11px] text-muted-foreground">Side Chat</span>
            <button
              type="button"
              className={
                "ml-auto grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg transition-colors active:scale-95 " +
                (running
                  ? "bg-destructive/12 text-destructive hover:bg-destructive/20"
                  : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-secondary disabled:text-muted-foreground")
              }
              title={running ? STR.stop : STR.send}
              aria-label={running ? STR.stop : STR.send}
              disabled={!running && (!draft.trim() || !sessionId)}
              onClick={() => (running ? sideChatInterrupt() : submit())}
            >
              {running ? <StopIcon /> : <ArrowUpIcon />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
