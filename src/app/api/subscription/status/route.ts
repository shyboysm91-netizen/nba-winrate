import { NextResponse } from "next/server";
import { getSubscriptionStatus } from "@/lib/subscription/getSubscription";

export async function GET() {
  const status = await getSubscriptionStatus();
  return NextResponse.json(status);
}
