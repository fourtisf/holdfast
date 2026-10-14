"use client";

import { COMMENT_MAX_LENGTH, commentMessage, encodeSignature, normalizeCommentBody, type CoinDetail, type Comment, type Page } from "@holdfast/core";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorNote } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { FlagIcon } from "@/components/ui/icons";
import { WalletButton } from "@/components/layout/WalletButton";
import { api, errorMessage } from "@/lib/api";
import { formatAgo, formatMultiplier, shortAddress } from "@/lib/format";
import { useComments } from "@/lib/hooks/queries";
import { useNow } from "@/lib/hooks/useNow";

function Composer({ coin, replyTo, onCancelReply, onPosted }: { coin: CoinDetail; replyTo: Comment | null; onCancelReply: () => void; onPosted: (c: Comment) => void }) {
  const { publicKey, signMessage } = useWallet();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = normalizeCommentBody(body);
  const tooLong = text.length > COMMENT_MAX_LENGTH;

  if (coin.hidden) return <p className="px-4 py-3 text-sm text-muted">Comments are closed on this coin.</p>;
  if (!publicKey)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-sm text-muted">Connect a wallet to comment. Holders get a badge with their weight.</p>
        <WalletButton />
      </div>
    );

  const post = async () => {
    if (!signMessage) {
      setError("This wallet cannot sign messages.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const signedAt = Date.now();
      const replyId = replyTo?.id ?? null;
      const message = commentMessage({ mint: coin.mint, body: text, replyTo: replyId, signedAt });
      const signature = encodeSignature(await signMessage(new TextEncoder().encode(message)));
      const c = await api.postComment(coin.mint, { wallet: publicKey.toBase58(), body: text, replyTo: replyId, signedAt, signature });
      setBody("");
      onPosted(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-line px-4 py-3">
      {replyTo ? (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-muted">
          <span className="truncate">
            Replying to <span className="font-mono">{shortAddress(replyTo.wallet)}</span>: “{replyTo.body.slice(0, 80)}”
          </span>
          <button type="button" onClick={onCancelReply} className="shrink-0 font-semibold hover:text-fg">
            Cancel
          </button>
        </div>
      ) : null}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        maxLength={COMMENT_MAX_LENGTH + 50}
        placeholder={`Say something about $${coin.ticker}…`}
        aria-label="Comment"
        className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-line-strong focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className={cn("text-[11px] tabular", tooLong ? "text-sell" : "text-faint")}>
          {text.length}/{COMMENT_MAX_LENGTH}
        </span>
        <span className="text-[11px] text-faint">Your wallet signs the text: free, no transaction.</span>
        <Button size="sm" className="ml-auto" onClick={() => void post()} disabled={busy || text.length === 0 || tooLong}>
          {busy ? "Signing…" : replyTo ? "Reply" : "Post"}
        </Button>
      </div>
      {error ? <ErrorNote className="mt-2">{error}</ErrorNote> : null}
    </div>
  );
}

function CommentRow({ c, parent, now, onReply }: { c: Comment; parent: Comment | undefined; now: number; onReply: (c: Comment) => void }) {
  const [reported, setReported] = useState(false);
  const report = async () => {
    try {
      await api.reportComment(c.id, { reason: "other" });
    } finally {
      setReported(true);
    }
  };
  return (
    <li className="border-b border-line/60 px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Link href={`/profile?wallet=${c.wallet}`} className="font-mono text-muted hover:text-fg">
          {shortAddress(c.wallet)}
        </Link>
        {c.isCreator ? <Badge tone="ath">Creator</Badge> : null}
        {c.holder ? <Badge tone="buy">Holder {c.weightMultiplier !== null ? formatMultiplier(c.weightMultiplier) : ""}</Badge> : null}
        <span className="text-faint">{formatAgo(c.createdAt, now)}</span>
      </div>
      {c.replyTo !== null ? (
        <div className="mt-1 truncate border-l-2 border-line pl-2 text-xs text-faint">
          ↪ {parent ? `${shortAddress(parent.wallet)}: ${parent.hidden ? "hidden comment" : parent.body.slice(0, 90)}` : `reply to #${c.replyTo}`}
        </div>
      ) : null}
      {c.hidden ? (
        <p className="mt-1 text-sm text-faint italic">Hidden by moderators.</p>
      ) : (
        <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">{c.body}</p>
      )}
      {!c.hidden ? (
        <div className="mt-1.5 flex items-center gap-3 text-[11px] font-semibold text-faint">
          <button type="button" onClick={() => onReply(c)} className="hover:text-fg">
            Reply
          </button>
          <button type="button" onClick={() => void report()} disabled={reported} className="inline-flex items-center gap-1 hover:text-fg disabled:opacity-60">
            <FlagIcon size={11} />
            {reported ? "Reported" : "Report"}
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** Wallet-signed comment thread of a coin, newest first. */
export function CommentsPanel({ coin }: { coin: CoinDetail }) {
  const { data, size, setSize, isLoading, isValidating, mutate, error } = useComments(coin.mint);
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const now = useNow(15_000);
  const comments = data?.flatMap((p) => p.items) ?? [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  const hasMore = Boolean(data?.[data.length - 1]?.nextCursor);

  const onPosted = (c: Comment) => {
    setReplyTo(null);
    void mutate((pages: Page<Comment>[] | undefined) => {
      if (!pages || pages.length === 0) return [{ items: [c], nextCursor: null }];
      const [first, ...rest] = pages;
      return [{ ...first!, items: [c, ...first!.items.filter((x) => x.id !== c.id)] }, ...rest];
    }, { revalidate: false });
  };

  return (
    <div>
      <Composer coin={coin} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onPosted={onPosted} />
      {error ? <ErrorNote className="m-4">Could not load comments: {errorMessage(error)}</ErrorNote> : null}
      {isLoading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-surface-2" />
          ))}
        </div>
      ) : comments.length === 0 ? (
        <EmptyState title="No comments yet" body="Start the conversation." />
      ) : (
        <ul className="scrollbar-thin lg:max-h-[640px] lg:overflow-y-auto">
          {comments.map((c) => (
            <CommentRow key={c.id} c={c} parent={c.replyTo !== null ? byId.get(c.replyTo) : undefined} now={now} onReply={setReplyTo} />
          ))}
        </ul>
      )}
      {hasMore ? (
        <div className="flex justify-center border-t border-line p-3">
          <Button variant="ghost" size="sm" onClick={() => void setSize(size + 1)} disabled={isValidating}>
            {isValidating && size > (data?.length ?? 0) ? "Loading…" : "Older comments"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
