package com.pagemint.billing;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.util.List;
import java.util.TreeSet;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The two implementations share the same tables. This applies the Next.js (drizzle) migrations to a scratch database
 * and compares columns, constraints and indexes with the Flyway-built schema. Spring-only tables are excluded.
 */
class SchemaParityIT extends IntegrationTestBase {

    static final List<String> SHARED = List.of("users", "customers", "subscriptions", "entitlements", "webhook_events", "reconcile_runs");

    static TreeSet<String> describe(Connection c) throws Exception {
        var out = new TreeSet<String>();
        String in = "('" + String.join("','", SHARED) + "')";
        try (var st = c.createStatement()) {
            try (ResultSet rs = st.executeQuery("select table_name, column_name, data_type, is_nullable, coalesce(column_default,'') d"
                    + " from information_schema.columns where table_schema='public' and table_name in " + in)) {
                while (rs.next()) out.add("col " + rs.getString(1) + "." + rs.getString(2) + " " + rs.getString(3)
                        + " null=" + rs.getString(4) + " default=" + rs.getString(5));
            }
            try (ResultSet rs = st.executeQuery("select conrelid::regclass::text, conname, pg_get_constraintdef(oid)"
                    + " from pg_constraint where connamespace='public'::regnamespace and conrelid::regclass::text in " + in)) {
                while (rs.next()) out.add("con " + rs.getString(1) + " " + rs.getString(2) + " " + rs.getString(3));
            }
            try (ResultSet rs = st.executeQuery("select tablename, indexname, indexdef from pg_indexes"
                    + " where schemaname='public' and tablename in " + in)) {
                while (rs.next()) out.add("idx " + rs.getString(1) + " " + rs.getString(2) + " " + rs.getString(3));
            }
        }
        return out;
    }

    @Test
    void flywaySchemaMatchesTheDrizzleMigrations() throws Exception {
        jdbc.execute("drop database if exists parity_drizzle");
        jdbc.execute("create database parity_drizzle");
        String url = PG.getJdbcUrl().replaceFirst("/[^/?]+(\\?|$)", "/parity_drizzle$1");

        Path dir = Path.of("../nextjs/drizzle");
        List<Path> files;
        try (Stream<Path> s = Files.list(dir)) {
            files = s.filter(p -> p.toString().endsWith(".sql")).sorted().toList();
        }
        assertThat(files).as("drizzle migrations found").isNotEmpty();

        TreeSet<String> drizzle;
        try (Connection c = DriverManager.getConnection(url, PG.getUsername(), PG.getPassword())) {
            for (Path f : files) {
                for (String stmt : Files.readString(f).split("--> statement-breakpoint")) {
                    if (!stmt.isBlank()) c.createStatement().execute(stmt);
                }
            }
            drizzle = describe(c);
        }
        TreeSet<String> flyway;
        try (Connection c = DriverManager.getConnection(PG.getJdbcUrl(), PG.getUsername(), PG.getPassword())) {
            flyway = describe(c);
        }

        assertThat(drizzle).as("drizzle schema described").hasSizeGreaterThan(20);
        assertThat(flyway).isEqualTo(drizzle);
    }
}
