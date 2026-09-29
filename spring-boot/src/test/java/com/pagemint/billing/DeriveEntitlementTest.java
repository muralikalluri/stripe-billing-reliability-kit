package com.pagemint.billing;

import static org.assertj.core.api.Assertions.assertThat;

import com.pagemint.billing.DeriveEntitlement.Entitlement;
import com.pagemint.billing.DeriveEntitlement.SubscriptionState;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Case-for-case port of nextjs/test/derive.test.ts. */
class DeriveEntitlementTest {

    static final Instant START = Instant.parse("2030-01-01T00:00:00Z");
    static final Instant END = Instant.parse("2030-02-01T00:00:00Z");

    static SubscriptionState sub(String status) {
        return new SubscriptionState(status, "pro", 1, START, END, false);
    }

    @Test
    void activeGrantsPlanUntilPeriodEndPlusBuffer() {
        Entitlement e = DeriveEntitlement.derive(sub("active"));
        assertThat(e.plan()).isEqualTo("pro");
        assertThat(e.validUntil()).isEqualTo(END.plus(DeriveEntitlement.RENEWAL_BUFFER));
    }

    @Test
    void trialingGrantsPlanUntilPeriodEndPlusBuffer() {
        Entitlement e = DeriveEntitlement.derive(sub("trialing"));
        assertThat(e.plan()).isEqualTo("pro");
        assertThat(e.validUntil()).isEqualTo(END.plus(DeriveEntitlement.RENEWAL_BUFFER));
    }

    @Test
    void pastDueIsAnchoredOnFailedPeriodStartNotTheAdvancedPeriodEnd() {
        Entitlement e = DeriveEntitlement.derive(sub("past_due"));
        assertThat(e.plan()).isEqualTo("pro");
        assertThat(e.validUntil()).isEqualTo(START.plus(DeriveEntitlement.PAST_DUE_GRACE));
        assertThat(e.validUntil()).isBefore(END);
    }

    @ParameterizedTest
    @ValueSource(strings = {"incomplete", "incomplete_expired", "unpaid", "canceled", "paused"})
    void noAccessStates(String status) {
        assertThat(DeriveEntitlement.derive(sub(status)).plan()).isEqualTo("free");
    }

    @Test
    void unknownStatusFailsClosed() {
        assertThat(DeriveEntitlement.derive(sub("something_new")).plan()).isEqualTo("free");
    }

    @Test
    void cancelAtPeriodEndRemovesTheRenewalBuffer() {
        var s = new SubscriptionState("active", "pro", 1, START, END, true);
        assertThat(DeriveEntitlement.derive(s).validUntil()).isEqualTo(END);
    }

    @Test
    void noSubscriptionOrUnknownPlanIsFree() {
        assertThat(DeriveEntitlement.derive(null).plan()).isEqualTo("free");
        assertThat(DeriveEntitlement.derive(new SubscriptionState("active", null, 1, START, END, false)).plan())
                .isEqualTo("free");
    }

    @Test
    void missingDatesFailClosed() {
        assertThat(DeriveEntitlement.derive(new SubscriptionState("active", "pro", 1, START, null, false)).plan())
                .isEqualTo("free");
        assertThat(DeriveEntitlement.derive(new SubscriptionState("past_due", "pro", 1, null, END, false)).plan())
                .isEqualTo("free");
    }

    @Test
    void aPaidPlanNeverHasANullValidUntil() {
        for (String status : List.of("active", "trialing", "past_due", "canceled", "unpaid", "paused", "incomplete", "x")) {
            for (boolean cancel : new boolean[] {true, false}) {
                Entitlement e = DeriveEntitlement.derive(new SubscriptionState(status, "pro", 1, START, END, cancel));
                if (!e.plan().equals("free")) assertThat(e.validUntil()).isNotNull();
            }
        }
    }

    @Test
    void seatsFollowQuantityMinimumOne() {
        assertThat(DeriveEntitlement.derive(new SubscriptionState("active", "team", 5, START, END, false)).seats()).isEqualTo(5);
        assertThat(DeriveEntitlement.derive(new SubscriptionState("active", "pro", 0, START, END, false)).seats()).isEqualTo(1);
    }

    @Test
    void bestOfSeveralSubscriptions() {
        Entitlement free = DeriveEntitlement.FREE;
        Entitlement pro2030 = new Entitlement("pro", 1, Instant.parse("2030-01-01T00:00:00Z"));
        Entitlement pro2031 = new Entitlement("pro", 1, Instant.parse("2031-01-01T00:00:00Z"));
        Entitlement team2030 = new Entitlement("team", 1, Instant.parse("2030-01-01T00:00:00Z"));
        assertThat(DeriveEntitlement.best(List.of(free, pro2030)).plan()).isEqualTo("pro");
        assertThat(DeriveEntitlement.best(List.of(pro2031, team2030)).plan()).isEqualTo("team");
        assertThat(DeriveEntitlement.best(List.of(pro2030, pro2031)).validUntil()).isEqualTo(pro2031.validUntil());
        assertThat(DeriveEntitlement.best(List.of()).plan()).isEqualTo("free");
    }

    @Test
    void constantsMatchTheChaosHarnessAndTheNextjsImplementation() {
        assertThat(DeriveEntitlement.PAST_DUE_GRACE.toDays()).isEqualTo(3);
        assertThat(DeriveEntitlement.RENEWAL_BUFFER.toDays()).isEqualTo(3);
    }
}
