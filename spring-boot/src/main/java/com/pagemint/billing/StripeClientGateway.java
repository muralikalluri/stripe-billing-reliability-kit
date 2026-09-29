package com.pagemint.billing;

import com.stripe.exception.ApiConnectionException;
import com.stripe.exception.StripeException;
import com.stripe.model.Event;
import com.stripe.model.Subscription;
import com.stripe.model.SubscriptionItem;
import com.stripe.net.RequestOptions;
import com.stripe.param.SubscriptionListParams;
import java.time.Instant;
import java.util.List;
import org.springframework.stereotype.Component;

/** stripe-java implementation. It pins its own API version, which matches the model classes used here. */
@Component
public class StripeClientGateway implements StripeGateway {

    private final Settings settings;

    public StripeClientGateway(Settings settings) {
        this.settings = settings;
    }

    private RequestOptions opts() {
        return RequestOptions.builder().setApiKey(settings.stripeSecretKey()).build();
    }

    @Override
    public SubscriptionData retrieveSubscription(String id) {
        try {
            return map(Subscription.retrieve(id, opts()));
        } catch (StripeException e) {
            throw wrap(e);
        }
    }

    @Override
    public Page listSubscriptions(String customerId, String startingAfter, int limit) {
        try {
            SubscriptionListParams.Builder p = SubscriptionListParams.builder()
                    .setStatus(SubscriptionListParams.Status.ALL)
                    .setLimit((long) limit);
            if (customerId != null) p.setCustomer(customerId);
            if (startingAfter != null) p.setStartingAfter(startingAfter);
            var res = Subscription.list(p.build(), opts());
            List<SubscriptionData> data = res.getData().stream().map(StripeClientGateway::map).toList();
            return new Page(data, Boolean.TRUE.equals(res.getHasMore()));
        } catch (StripeException e) {
            throw wrap(e);
        }
    }

    @Override
    public String retrieveEventJson(String id) {
        try {
            return Event.retrieve(id, opts()).toJson();
        } catch (StripeException e) {
            throw wrap(e);
        }
    }

    static SubscriptionData map(Subscription s) {
        SubscriptionItem item = s.getItems().getData().isEmpty() ? null : s.getItems().getData().get(0);
        if (item == null) throw new IllegalStateException("subscription " + s.getId() + " has no items");
        return new SubscriptionData(
                s.getId(),
                s.getCustomer(),
                s.getStatus(),
                item.getPrice().getId(),
                item.getQuantity() == null ? 1 : item.getQuantity().intValue(),
                item.getCurrentPeriodStart() == null ? null : Instant.ofEpochSecond(item.getCurrentPeriodStart()),
                item.getCurrentPeriodEnd() == null ? null : Instant.ofEpochSecond(item.getCurrentPeriodEnd()),
                Boolean.TRUE.equals(s.getCancelAtPeriodEnd()) || s.getCancelAt() != null,
                s.getMetadata() == null ? null : s.getMetadata().get("user_id"));
    }

    private static GatewayException wrap(StripeException e) {
        String code = e instanceof ApiConnectionException ? "ECONNRESET" : e.getCode();
        return new GatewayException(e.getMessage(), code, e.getStatusCode(), e);
    }
}
