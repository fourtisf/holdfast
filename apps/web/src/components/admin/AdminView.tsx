"use client";

import type { AdminCoin, AdminLaunch, AdminLogEntry, AdminOverview, AdminReport } from "@holdfast/core";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, ErrorNote } from "@/components/ui/States";
import { Tabs } from "@/components/ui/Tabs";
import { adminClient, type AdminClient } from "@/lib/admin";
import { errorMessage } from "@/lib/api";
import { USE_MOCKS } from "@/lib/config";
import { formatRelativeTime, shortAddress } from "@/lib/format";
import { useNow } from "@/lib/hooks/useNow";

type Tab = "coins" | "reports" | "launches" | "log";
const TOKEN_KEY = "holdfast:admin-token";
const STUCK = ["creating", "refunding", "failed", "deposit_received"];

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Moderation and launch operations (needs ADMIN_TOKEN). Nothing here can move funds. */
export function AdminView() {
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  useEffect(() => setToken(readToken()), []);
  const client = useMemo(() => (token ? adminClient(token) : null), [token]);

  if (USE_MOCKS) {
    return (
      <Card>
        <EmptyState title="Admin needs the real API" body="Mock mode has no moderation backend. Run the API and set ADMIN_TOKEN." />
      </Card>
    );
  }
  if (!client) {
    return (
      <Card className="mx-auto max-w-md p-5">
        <h1 className="text-lg font-semibold text-fg">Moatpad admin</h1>
        <p className="mt-1 text-sm text-muted">Enter the API&apos;s ADMIN_TOKEN. It is kept for this browser tab only.</p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              sessionStorage.setItem(TOKEN_KEY, draft.trim());
            } catch {
              // storage unavailable: keep it in memory
            }
            setToken(draft.trim());
          }}
        >
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            className="h-10 flex-1 rounded-control border border-line bg-surface-2 px-3 text-sm text-fg outline-none focus:border-line-strong"
            placeholder="Admin token"
          />
          <Button type="submit" disabled={!draft.trim()}>
            Open
          </Button>
        </form>
      </Card>
    );
  }
  return (
    <AdminConsole
      client={client}
      onSignOut={() => {
        try {
          sessionStorage.removeItem(TOKEN_KEY);
        } catch {
          // ignore
        }
        setToken("");
        setDraft("");
      }}
    />
  );
}

function AdminConsole({ client, onSignOut }: { client: AdminClient; onSignOut: () => void }) {
  const now = useNow(30_000);
  const [tab, setTab] = useState<Tab>("coins");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [coins, setCoins] = useState<AdminCoin[]>([]);
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [launches, setLaunches] = useState<AdminLaunch[]>([]);
  const [log, setLog] = useState<AdminLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, c, r, l, g] = await Promise.all([client.overview(), client.coins(), client.reports(), client.launches(STUCK), client.log()]);
      setOverview(o);
      setCoins(c);
      setReports(r);
      setLaunches(l);
      setLog(g);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);
  useEffect(() => void load(), [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hide = (c: { mint: string; ticker: string }) => {
    const reason = window.prompt(`Why hide $${c.ticker}? (shown on the coin page)`);
    if (!reason?.trim()) return;
    const blockImage = window.confirm("Also block its image from future uploads?");
    void act(() => client.hide(c.mint, { reason: reason.trim(), blockImage }));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-fg">Admin</h1>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={busy}>
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {overview ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Open reports" value={overview.openReports} />
          <Stat label="Coins to review" value={overview.coinsNeedingReview} />
          <Stat label="Hidden coins" value={overview.hiddenCoins} />
          <Stat label="Launches in progress" value={(overview.launches.creating ?? 0) + (overview.launches.deposit_received ?? 0) + (overview.launches.refunding ?? 0)} />
        </div>
      ) : null}

      <Card className="p-0">
        <div className="pt-1">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "coins", label: `Coins (${coins.length})` },
              { value: "reports", label: `Reports (${reports.length})` },
              { value: "launches", label: `Launches (${launches.length})` },
              { value: "log", label: "Log" },
            ]}
          />
        </div>
        <div className="overflow-x-auto">
          {tab === "coins" ? (
            coins.length === 0 ? (
              <EmptyState title="Nothing to review" body="Reported, flagged and hidden coins show up here." />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-faint">
                  <tr>
                    <th className="px-4 py-2 font-medium">Coin</th>
                    <th className="px-4 py-2 font-medium">State</th>
                    <th className="px-4 py-2 font-medium">Reports</th>
                    <th className="px-4 py-2 font-medium">Launched</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {coins.map((c) => (
                    <tr key={c.mint} className="border-t border-line">
                      <td className="px-4 py-2">
                        <Link href={`/coin/${c.mint}`} className="font-semibold text-fg hover:underline">
                          {c.name} <span className="text-muted">${c.ticker}</span>
                        </Link>
                        <div className="font-mono text-xs text-faint">{shortAddress(c.mint, 5)}</div>
                      </td>
                      <td className="px-4 py-2">
                        {c.hidden ? <Badge tone="sell">hidden: {c.hiddenReason}</Badge> : c.needsReview ? <Badge tone="ath">reserved name</Badge> : <Badge tone="muted">listed</Badge>}
                      </td>
                      <td className="px-4 py-2 tabular">{c.openReports}</td>
                      <td className="px-4 py-2 text-muted">{formatRelativeTime(c.createdAt, now)}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {c.hidden ? (
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => client.unhide(c.mint))}>
                            Unhide
                          </Button>
                        ) : (
                          <span className="inline-flex gap-2">
                            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => client.reviewed(c.mint))}>
                              Looks fine
                            </Button>
                            <Button size="sm" variant="sell" disabled={busy} onClick={() => hide(c)}>
                              Hide
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}

          {tab === "reports" ? (
            reports.length === 0 ? (
              <EmptyState title="No open reports" />
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id} className="border-t border-line first:border-t-0">
                      <td className="px-4 py-2">
                        <Badge tone="sell">{r.reason}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        <Link href={`/coin/${r.mint}`} className="font-mono text-xs text-fg hover:underline">
                          {shortAddress(r.mint, 5)}
                        </Link>
                        {r.targetType === "comment" ? <span className="ml-2 text-xs text-faint">comment #{r.targetId}</span> : null}
                        {r.commentBody ? <div className="mt-0.5 max-w-md border-l-2 border-line pl-2 text-xs text-fg">“{r.commentBody}”</div> : null}
                        {r.details ? <div className="mt-0.5 max-w-md text-xs text-muted">{r.details}</div> : null}
                      </td>
                      <td className="px-4 py-2 text-muted">{formatRelativeTime(r.createdAt, now)}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {r.targetType === "comment" ? (
                          <Button size="sm" variant="outline" className="mr-2" disabled={busy} onClick={() => void act(() => client.hideComment(r.targetId, `reported: ${r.reason}`))}>
                            Hide comment
                          </Button>
                        ) : null}
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => client.resolveReport(r.id, "dismissed"))}>
                          Dismiss
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}

          {tab === "launches" ? (
            launches.length === 0 ? (
              <EmptyState title="No stuck launches" body="Launches that are creating, refunding, or failed show up here." />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-faint">
                  <tr>
                    <th className="px-4 py-2 font-medium">Launch</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Attempts</th>
                    <th className="px-4 py-2 font-medium">Last error</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {launches.map((l) => (
                    <tr key={l.launchId} className="border-t border-line align-top">
                      <td className="px-4 py-2">
                        <div className="font-semibold text-fg">
                          {l.name} <span className="text-muted">${l.ticker}</span>
                        </div>
                        <div className="font-mono text-xs text-faint">{shortAddress(l.depositAddress, 5)}</div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={l.status === "failed" ? "sell" : "ath"}>{l.status}</Badge>
                      </td>
                      <td className="px-4 py-2 tabular">{l.attempts}</td>
                      <td className="max-w-sm px-4 py-2 text-xs break-words text-muted">{l.error ?? "–"}</td>
                      <td className="px-4 py-2 text-right">
                        {l.status === "creating" || l.status === "refunding" ? (
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => client.retryLaunch(l.launchId))}>
                            Retry now
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}

          {tab === "log" ? (
            log.length === 0 ? (
              <EmptyState title="No admin actions yet" />
            ) : (
              <ul className="divide-y divide-line text-sm">
                {log.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-3 px-4 py-2">
                    <span className="font-semibold text-fg">{e.action}</span>
                    <span className="font-mono text-xs text-muted">{shortAddress(e.target, 6)}</span>
                    <span className="text-muted">{e.reason}</span>
                    <span className="ml-auto text-xs text-faint">
                      {e.actor} · {formatRelativeTime(e.createdAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-fg tabular">{value}</div>
    </Card>
  );
}
