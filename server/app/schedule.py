"""When a scheduled task next runs. Pure functions: no store, no clock of their own.

A task is anchored to a wall-clock time in the zone it was created in -- "every
day at 09:00" means 09:00 on the user's clock, and stays 09:00 across a
daylight-saving change rather than drifting an hour. So occurrences are
computed on naive local datetimes and only then given a zone, never by adding
24 hours to an instant.

The anchor (`starts_at`, 'YYYY-MM-DDTHH:MM') is the first occurrence and is
never rewritten. The next run is always derived from it, which is what keeps a
monthly task anchored on the 31st from sliding to the 28th for good after one
short month.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

REPEATS = ("once", "hourly", "daily", "weekdays", "weekly", "monthly")

# Strict for the same reason the calendar's is: a model guessing at "next
# Tuesday" should be told the format, not have a date invented from a partial
# match.
WHEN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")

# Beyond this many steps something is wrong (an anchor decades ago, hourly).
_MAX_STEPS = 200_000


def zone_for(name: str | None, offset_minutes: int | None = None) -> tzinfo:
    """The zone a task's wall clock is read in.

    The named zone first, then the bare offset the device reported, then the
    server's own -- the same order `Situation.tzinfo` uses, because a machine
    without a timezone database cannot resolve a single name.
    """
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError, KeyError):
            pass
    if offset_minutes is not None:
        return timezone(timedelta(minutes=offset_minutes))
    return datetime.now().astimezone().tzinfo or timezone.utc


def parse_local(when: str) -> datetime | None:
    """'YYYY-MM-DDTHH:MM' as a naive datetime, or None if it is not one."""
    if not isinstance(when, str) or not WHEN.match(when):
        return None
    try:
        return datetime.strptime(when, "%Y-%m-%dT%H:%M")
    except ValueError:  # 2026-02-31 matches the shape and is not a date
        return None


def _add_months(anchor: datetime, months: int) -> datetime:
    index = anchor.year * 12 + (anchor.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    # Clamped to the month's last day: a task on the 31st runs on the 30th in
    # April, and on the 31st again in May.
    for day in (anchor.day, 30, 29, 28):
        try:
            return anchor.replace(year=year, month=month, day=day)
        except ValueError:
            continue
    return anchor  # unreachable: every month has a 28th


def occurrence(anchor: datetime, repeat: str, n: int) -> datetime:
    """The n-th (0-based) local occurrence of a task anchored at `anchor`."""
    if repeat == "hourly":
        return anchor + timedelta(hours=n)
    if repeat == "daily":
        return anchor + timedelta(days=n)
    if repeat == "weekly":
        return anchor + timedelta(weeks=n)
    if repeat == "monthly":
        return _add_months(anchor, n)
    if repeat == "weekdays":
        # n-th weekday at or after the anchor's date. If the anchor itself is
        # a weekend, the first run is the following Monday.
        day = anchor
        while day.weekday() >= 5:
            day += timedelta(days=1)
        weeks, extra = divmod(n, 5)
        day += timedelta(weeks=weeks)
        while extra:
            day += timedelta(days=1)
            if day.weekday() < 5:
                extra -= 1
        return day
    return anchor  # "once"


def _to_ms(local: datetime, zone: tzinfo) -> int:
    return int(local.replace(tzinfo=zone).timestamp() * 1000)


def next_run_ms(anchor: str, repeat: str, zone: tzinfo, after_ms: int) -> int | None:
    """The first occurrence strictly after `after_ms` (epoch ms), or None.

    None for a one-off that has already passed: there is nothing left to run.
    """
    start = parse_local(anchor)
    if start is None or repeat not in REPEATS:
        return None
    if repeat == "once":
        first = _to_ms(start, zone)
        return first if first > after_ms else None
    for n in range(_MAX_STEPS):
        ms = _to_ms(occurrence(start, repeat, n), zone)
        if ms > after_ms:
            return ms
    return None


def first_run_ms(anchor: str, repeat: str, zone: tzinfo, now_ms: int) -> int | None:
    """When a brand-new task first fires: the anchor itself if it is still ahead."""
    return next_run_ms(anchor, repeat, zone, now_ms)


def describe_when(ms: int, zone: tzinfo) -> str:
    """A run time as the user's clock reads it: 'Tue 30 Sep 2026, 09:00'."""
    local = datetime.fromtimestamp(ms / 1000, tz=zone)
    return local.strftime("%a %d %b %Y, %H:%M")
