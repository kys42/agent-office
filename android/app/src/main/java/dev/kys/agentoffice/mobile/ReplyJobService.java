package dev.kys.agentoffice.mobile;

import android.app.job.*;
import android.content.*;
import android.webkit.CookieManager;
import java.util.concurrent.*;

public final class ReplyJobService extends JobService {
    private static final int JOB = 432101;
    private ExecutorService executor;
    private Future<?> work;
    static void schedule(Context c) {
        JobScheduler scheduler = c.getSystemService(JobScheduler.class);
        if (!AppSettings.notifications(c) || AppSettings.origin(c).isEmpty()) { scheduler.cancel(JOB); return; }
        scheduler.schedule(new JobInfo.Builder(JOB, new ComponentName(c, ReplyJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15 * 60 * 1000L)
                .setPersisted(true).build());
    }
    @Override public boolean onStartJob(JobParameters params) {
        String cookie = CookieManager.getInstance().getCookie(AppSettings.origin(this) + "/mobile/api/state");
        ExecutorService jobExecutor = Executors.newSingleThreadExecutor();
        executor = jobExecutor;
        work = jobExecutor.submit(() -> {
            ReplyPoller.scan(this, cookie, 24);
            if (!Thread.currentThread().isInterrupted()) jobFinished(params, false);
            jobExecutor.shutdown();
        });
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) {
        if (work != null) work.cancel(true);
        if (executor != null) executor.shutdownNow();
        return false;
    }
}
