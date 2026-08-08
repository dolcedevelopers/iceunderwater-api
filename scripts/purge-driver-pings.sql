-- Run daily (cron). Retention default 90 days.
DELETE FROM iuw_driver_pings
WHERE recorded_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 90 DAY);
