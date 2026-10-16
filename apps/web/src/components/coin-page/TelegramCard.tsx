import type { CoinDetail } from "@holdfast/core";
import { Card, CardHeader } from "@/components/ui/Card";
import { TelegramIcon } from "@/components/ui/icons";
import { botUrl, TELEGRAM_BOT } from "@/lib/config";

/** The coin in Telegram: the buy bot for its community group, and alerts in a private chat. */
export function TelegramCard({ coin }: { coin: CoinDetail }) {
  const group = botUrl(`buybot_${coin.mint}`, true);
  const alerts = botUrl(`follow_${coin.mint}`);
  if (!group || !alerts) return null;
  const link = "flex items-center justify-between rounded-control bg-surface-2 px-3 py-2.5 text-sm font-semibold text-fg ring-1 ring-line transition-colors hover:bg-surface-3";
  return (
    <Card>
      <CardHeader title="Telegram" icon={<TelegramIcon size={14} />} subtitle={`@${TELEGRAM_BOT}`} />
      <div className="space-y-2 px-4 pb-4">
        <a href={group} target="_blank" rel="noopener noreferrer" className={link}>
          <span>🟢 Buy bot for your group</span>
          <span className="text-xs font-normal text-muted">Every buy of ${coin.ticker}</span>
        </a>
        <a href={alerts} target="_blank" rel="noopener noreferrer" className={link}>
          <span>🔔 Alerts on Telegram</span>
          <span className="text-xs font-normal text-muted">Payouts, buybacks</span>
        </a>
      </div>
    </Card>
  );
}
