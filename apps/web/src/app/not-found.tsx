import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg pt-10">
      <Card>
        <EmptyState title="Page not found" body="That page drifted off with the tide." action={<ButtonLink href="/">Back to coins</ButtonLink>} />
      </Card>
    </div>
  );
}
