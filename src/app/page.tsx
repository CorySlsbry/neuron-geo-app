import { redirect } from "next/navigation";

// The app opens on the dashboard; unauthenticated visitors bounce to /login there.
export default function HomePage() {
  redirect("/dashboard");
}
