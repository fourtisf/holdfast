import type { Metadata } from "next";
import { Suspense } from "react";
import { ProfileView } from "@/components/profile/ProfileView";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <Suspense fallback={null}>
      <ProfileView />
    </Suspense>
  );
}
