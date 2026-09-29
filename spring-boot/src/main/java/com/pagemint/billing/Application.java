package com.pagemint.billing;

import java.util.Arrays;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;

@SpringBootApplication
public class Application {

    /**
     * {@code java -jar app.jar --reconcile} runs ONE reconcile with no web server (profile "cli"), writes the drift
     * report to $RECONCILE_REPORT_PATH and exits: 0 on success, 1 if another run holds the lock or it failed.
     */
    public static void main(String[] args) {
        boolean cli = Arrays.asList(args).contains("--reconcile");
        SpringApplication app = new SpringApplication(Application.class);
        if (cli) {
            app.setWebApplicationType(WebApplicationType.NONE);
            app.setAdditionalProfiles("cli");
        }
        ConfigurableApplicationContext ctx = app.run(args);
        if (cli) {
            System.exit(SpringApplication.exit(ctx));
        }
    }
}
