package com.pagemint.billing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** In-memory Stripe: pagination, per-customer listing, and Stripe's rule that test-clock subs hide from the global list. */
public class FakeStripe implements StripeGateway {

    public static final Instant START = Instant.parse("2030-01-01T00:00:00Z");
    public static final Instant END = Instant.parse("2030-02-01T00:00:00Z");

    private final Map<String, SubscriptionData> subs = new ConcurrentHashMap<>();
    private final Set<String> testClock = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> delays = new ConcurrentHashMap<>();
    public volatile int failListOnCall = -1; // 1-based call number to fail (non-retryable)
    public volatile int listCalls = 0;
    public volatile int retrieveCalls = 0;
    public volatile String eventJson = "{}";

    public void reset() {
        subs.clear();
        testClock.clear();
        delays.clear();
        failListOnCall = -1;
        listCalls = 0;
        retrieveCalls = 0;
    }

    public static SubscriptionData sub(String id, String customer, String status) {
        return new SubscriptionData(id, customer, status, "price_pro_m", 1, START, END, false, null);
    }

    public FakeStripe put(SubscriptionData s) {
        subs.put(s.id(), s);
        return this;
    }

    public FakeStripe putOnTestClock(SubscriptionData s) {
        testClock.add(s.id());
        return put(s);
    }

    public void remove(String id) {
        subs.remove(id);
    }

    public void delay(String id, long ms) {
        delays.put(id, ms);
    }

    @Override
    public SubscriptionData retrieveSubscription(String id) {
        retrieveCalls++;
        Long d = delays.get(id);
        if (d != null) {
            try { Thread.sleep(d); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        SubscriptionData s = subs.get(id);
        if (s == null) throw new GatewayException("No such subscription", "resource_missing", 404, null);
        return s;
    }

    @Override
    public Page listSubscriptions(String customerId, String startingAfter, int limit) {
        int call = ++listCalls;
        if (call == failListOnCall) throw new GatewayException("boom", "api_error", 400, null);
        List<SubscriptionData> all = new ArrayList<>();
        for (SubscriptionData s : new LinkedHashMap<>(subs).values()) {
            boolean visible = customerId != null ? s.customerId().equals(customerId) : !testClock.contains(s.id());
            if (visible) all.add(s);
        }
        all.sort(Comparator.comparing(SubscriptionData::id));
        int from = 0;
        if (startingAfter != null) {
            for (int i = 0; i < all.size(); i++) if (all.get(i).id().equals(startingAfter)) from = i + 1;
        }
        int to = Math.min(all.size(), from + limit);
        return new Page(all.subList(from, to), to < all.size());
    }

    @Override
    public String retrieveEventJson(String id) {
        return eventJson;
    }
}
