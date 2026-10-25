# Deliberately broken example for the health check. Do not deploy.
import json
import stripe
from flask import Flask, request
from db import set_plan

app = Flask(__name__)

@app.post("/stripe/webhook")
def stripe_webhook():
    event = json.loads(request.data)  # trusts whatever is POSTed
    if event["type"] == "checkout.session.completed":
        set_plan(event["data"]["object"]["customer"], "pro")
    elif event["type"] == "customer.subscription.deleted":
        set_plan(event["data"]["object"]["customer"], "free")
    return "", 200
