// Deliberately broken example for the health check. Do not deploy.
const express = require("express");
const Stripe = require("stripe");
const db = require("./db");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(express.json());

app.post("/api/stripe/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(JSON.stringify(req.body), sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed":
      await db.users.update({ where: { stripeCustomerId: event.data.object.customer }, data: { plan: "pro" } });
      break;
    case "invoice.paid":
      await db.users.update({ where: { stripeCustomerId: event.data.object.customer }, data: { credits: { increment: 500 } } });
      break;
  }
  res.json({ received: true });
});

app.get("/checkout/success", async (req, res) => {
  const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
  await db.users.update({ where: { email: session.customer_details.email }, data: { plan: "pro" } });
  res.redirect("/dashboard");
});

app.listen(3000);
