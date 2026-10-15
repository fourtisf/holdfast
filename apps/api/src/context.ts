import type { Db } from "@holdfast/db";
import type { ApiConfig } from "./config.js";
import type { LaunchService } from "./launch/service.js";
import type { WalletLauncher } from "./launch/wallet.js";
import type { SolPriceSource } from "./services/price.js";
import type { TradeChain } from "./trade/chain.js";
import type { LiveFeed } from "./ws/feed.js";
import type { SubscriptionHub } from "./ws/hub.js";

/** Shared dependencies of the route modules. */
export interface ApiContext {
  db: Db;
  config: ApiConfig;
  tradeChain: TradeChain;
  launches: LaunchService;
  walletLauncher: WalletLauncher;
  hub: SubscriptionHub;
  feed: LiveFeed;
  prices: SolPriceSource;
  now: () => number;
}
