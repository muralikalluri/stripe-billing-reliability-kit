package com.pagemint.billing;

import java.util.Arrays;
import java.util.Locale;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Configuration from environment variables (same names as the Next.js implementation). */
@Component
public class Settings {

    private final String stripeSecretKey;
    private final String webhookSecret;
    private final String proMonthly;
    private final String proYearly;
    private final String teamSeat;
    private final String adminEmails;
    private final String jwtSecret;

    public Settings(
            @Value("${STRIPE_SECRET_KEY:}") String stripeSecretKey,
            @Value("${STRIPE_WEBHOOK_SECRET:}") String webhookSecret,
            @Value("${STRIPE_PRICE_PRO_MONTHLY:}") String proMonthly,
            @Value("${STRIPE_PRICE_PRO_YEARLY:}") String proYearly,
            @Value("${STRIPE_PRICE_TEAM_SEAT:}") String teamSeat,
            @Value("${ADMIN_EMAILS:}") String adminEmails,
            @Value("${JWT_SECRET:}") String jwtSecret) {
        this.stripeSecretKey = stripeSecretKey;
        this.webhookSecret = webhookSecret;
        this.proMonthly = proMonthly;
        this.proYearly = proYearly;
        this.teamSeat = teamSeat;
        this.adminEmails = adminEmails;
        this.jwtSecret = jwtSecret;
    }

    /** Stripe TEST mode only: refuses anything that is not sk_test_ / rk_test_. */
    public String stripeSecretKey() {
        if (!stripeSecretKey.matches("^(sk|rk)_test_.+") || stripeSecretKey.contains("REPLACE_ME")) {
            throw new IllegalStateException("STRIPE_SECRET_KEY must be a Stripe TEST mode key");
        }
        return stripeSecretKey;
    }

    public String webhookSecret() {
        if (webhookSecret.isBlank()) {
            throw new IllegalStateException("STRIPE_WEBHOOK_SECRET is not set");
        }
        return webhookSecret;
    }

    public String jwtSecret() {
        if (jwtSecret.getBytes().length < 32) {
            throw new IllegalStateException("JWT_SECRET must be set (at least 32 bytes) for the HTTP API");
        }
        return jwtSecret;
    }

    /** "pro" | "team" | null (unknown price). */
    public String planForPrice(String priceId) {
        if (priceId == null || priceId.isBlank()) return null;
        if (priceId.equals(proMonthly) || priceId.equals(proYearly)) return "pro";
        if (priceId.equals(teamSeat)) return "team";
        return null;
    }

    /** ADMIN_EMAILS allowlist; unset or empty means NOBODY is admin. */
    public boolean isAdmin(String email) {
        if (email == null || adminEmails.isBlank()) return false;
        String e = email.trim().toLowerCase(Locale.ROOT);
        return Arrays.stream(adminEmails.split(","))
                .map(s -> s.trim().toLowerCase(Locale.ROOT))
                .filter(s -> !s.isEmpty())
                .anyMatch(s -> s.equals(e));
    }
}
