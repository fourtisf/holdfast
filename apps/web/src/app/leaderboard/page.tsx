import type { Metadata } from "next";
import { LeaderboardView } from "@/components/leaderboard/LeaderboardView";

export const metadata: Metadata = { title: "Leaderboard" };

export default function LeaderboardPage() {
  return <LeaderboardView />;
}
