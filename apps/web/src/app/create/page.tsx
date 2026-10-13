import type { Metadata } from "next";
import { CreateView } from "@/components/create/CreateView";

export const metadata: Metadata = { title: "Launch a coin" };

export default function CreatePage() {
  return <CreateView />;
}
