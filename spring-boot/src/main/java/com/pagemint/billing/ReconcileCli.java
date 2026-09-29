package com.pagemint.billing;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.ExitCodeGenerator;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/** {@code --reconcile}: one run, report to $RECONCILE_REPORT_PATH (default reconcile-report.json), then exit. */
@Component
@Profile("cli")
public class ReconcileCli implements CommandLineRunner, ExitCodeGenerator {

    private final ReconcileService service;
    private final ObjectMapper mapper;
    private final String reportPath;
    private int exitCode = 0;

    public ReconcileCli(ReconcileService service, ObjectMapper mapper,
                        @Value("${RECONCILE_REPORT_PATH:reconcile-report.json}") String reportPath) {
        this.service = service;
        this.mapper = mapper;
        this.reportPath = reportPath;
    }

    @Override
    public void run(String... args) throws Exception {
        var report = service.runLocked("cli");
        if (report.isEmpty()) {
            System.err.println("another reconcile run is in progress");
            exitCode = 1;
            return;
        }
        var r = report.get();
        Files.writeString(Path.of(reportPath), mapper.writerWithDefaultPrettyPrinter().writeValueAsString(r));
        System.out.printf("reconcile: scanned=%d repaired=%d failed=%d -> %s%n",
                r.scanned(), r.counts().repaired(), r.counts().failed(), reportPath);
    }

    @Override
    public int getExitCode() {
        return exitCode;
    }
}
