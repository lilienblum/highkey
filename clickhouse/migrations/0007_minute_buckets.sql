CREATE OR REPLACE FUNCTION bucket AS (t) -> multiIf(
    getSettingOrDefault('SQL_highkey_bucket', 'day') = 'minute', toDateTime64(toStartOfMinute(toDateTime64(t, 3, 'UTC')), 3, 'UTC'),
    getSettingOrDefault('SQL_highkey_bucket', 'day') = 'hour', toDateTime64(toStartOfHour(toDateTime64(t, 3, 'UTC')), 3, 'UTC'),
    getSettingOrDefault('SQL_highkey_bucket', 'day') = 'week', toDateTime64(toStartOfWeek(toDateTime64(t, 3, 'UTC'), 1), 3, 'UTC'),
    getSettingOrDefault('SQL_highkey_bucket', 'day') = 'month', toDateTime64(toStartOfMonth(toDateTime64(t, 3, 'UTC')), 3, 'UTC'),
    toDateTime64(toStartOfDay(toDateTime64(t, 3, 'UTC')), 3, 'UTC')
);
