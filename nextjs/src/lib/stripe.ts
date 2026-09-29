import Stripe from "stripe";
import { env } from "./env";

let client: Stripe | undefined;
export function getStripe(): Stripe {
  return (client ??= new Stripe(env.stripeSecretKey));
}
