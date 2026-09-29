# Scheduled tasks

A scheduled task is a prompt and a time. When the time comes the server opens a
new conversation, runs the prompt as its first message through the normal turn
loop (same skills, memory, agent and provider routing as a chat), and saves the
result in the conversation list under the task's title.

## Making one

Ask the assistant: *"every weekday at 8am, summarise my calendar for the day"*.
It uses the `schedule_task` skill; `list_scheduled_tasks` and
`cancel_scheduled_task` (which also pauses) manage them by title.

Or over HTTP (all under `/api`, bearer-token protected):

| Method | Path | |
| --- | --- | --- |
| GET | `/scheduled-tasks` | list, soonest first |
| POST | `/scheduled-tasks` | `title`, `prompt`, `starts_at` (`YYYY-MM-DDTHH:MM` local), `repeat`, `tz` / `utc_offset`, `agent_id` |
| PATCH | `/scheduled-tasks/{id}` | change any of the above, or `enabled` to pause/resume |
| DELETE | `/scheduled-tasks/{id}` | |
| POST | `/scheduled-tasks/{id}/run` | run now, without touching the schedule |

`repeat` is `once`, `hourly`, `daily`, `weekdays`, `weekly` or `monthly`.

## Behaviour worth knowing

- **Wall-clock times.** `starts_at` is the user's local time, in the zone the
  device reported. "Daily at 09:00" stays 09:00 across daylight-saving changes.
  A monthly task on the 31st runs on the last day of shorter months.
- **Unattended.** Nobody can answer a prompt, so a skill that needs approval is
  refused immediately (unless the user has already chosen "always" for it), and
  a design question takes "no standard". Grant what a task needs before
  scheduling it.
- **No chains.** A scheduled run cannot schedule more tasks.
- **Missed runs.** The server must be running. On start it runs anything up to
  6 hours overdue; older occurrences are recorded as `missed` and skipped.
- **Overlap.** If a run is still going when the next occurrence is due, that
  occurrence is skipped.
- Each run has a 15-minute limit. The task keeps `last_status`
  (`ok` / `error` / `missed`), a short `last_summary`, and `last_session_id`.

Code: `schedule.py` (time maths), `scheduler.py` (the loop),
`skills/schedule.py` (the assistant's tools), `schedule_api.py` (HTTP).
